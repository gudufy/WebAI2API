import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Stream from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { parseArgs } from "node:util";
import { authChatGPT, getDefaultChatGPTCredentialPath, loadChatGPTCredentials } from "./chatgptAuth.js";
import { ChatGPTResponsesClient, type ChatGPTResponseRequest } from "./chatgptResponsesClient.js";
import { collectResponse, forwardSseStream } from "./chatgptResponseStream.js";
import { errorResponse, getAllowedIpSummary, isAllowlistedClient, readRequestJson, sendJson, sendSseData, sendSseDone, sendSseHeaders, corsHeaders } from "./server/httpUtils.js";
import { isDirectRun } from "./utils.js";

const DEFAULT_PORT = 8787;
const DEFAULT_MODEL = "gpt-5.5";

function asResponseRequest(raw: any): ChatGPTResponseRequest {
    const input = Array.isArray(raw?.input) ? raw.input : [];
    if (!input.length) throw new Error("input must be a non-empty array.");
    return {
        ...raw,
        model: typeof raw.model === "string" && raw.model.trim() ? raw.model : DEFAULT_MODEL,
        input,
        instructions: typeof raw.instructions === "string" && raw.instructions.trim()
            ? raw.instructions
            : "You are a helpful coding assistant.",
        stream: true,
        store: false,
    };
}

function chatMessagesToResponses(raw: any): ChatGPTResponseRequest {
    const messages = Array.isArray(raw?.messages) ? raw.messages : [];
    const input = messages.map((message: any) => {
        const role = message?.role === "system" ? "developer" : message?.role;
        if (message?.tool_calls) {
            return message;
        }
        return {
            type: "message",
            role,
            content: typeof message?.content === "string"
                ? [{ type: "input_text", text: message.content }]
                : message?.content,
        };
    });
    return {
        model: typeof raw?.model === "string" && raw.model.trim() ? raw.model : DEFAULT_MODEL,
        input,
        instructions: "You are a helpful coding assistant.",
        stream: true,
        store: false,
        ...(raw?.tools ? { tools: raw.tools.map((tool: any) => tool.type === "function" ? { type: "function", ...tool.function } : tool) } : {}),
        ...(raw?.tool_choice ? { tool_choice: raw.tool_choice } : {}),
    };
}

function sendResponseSse(res: ServerResponse, event: Record<string, unknown>) {
    sendSseData(res, event);
}

async function handleResponses(req: IncomingMessage, res: ServerResponse, client: ChatGPTResponsesClient) {
    try {
        const raw = await readRequestJson(req);
        const request = asResponseRequest(raw);
        const upstream = await client.createResponse(request);
        const abort = new AbortController();
        res.once("close", () => abort.abort());

        if (raw.stream === true) {
            sendSseHeaders(res);
            await forwardSseStream(upstream.body, event => {
                if (!res.writableEnded && !abort.signal.aborted) sendResponseSse(res, event);
            });
            if (!res.writableEnded) sendSseDone(res);
            return;
        }

        const result = await collectResponse(upstream.body);
        sendJson(res, 200, result);
    } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, errorResponse(message, 500, "server_error"));
    }
}

function chatChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
    return {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, client: ChatGPTResponsesClient) {
    const raw = await readRequestJson(req);
    const request = chatMessagesToResponses(raw);
    const id = `chatcmpl-${Date.now()}`;
    const upstream = await client.createResponse(request);

    if (raw.stream === false) {
        const result = await collectResponse(upstream.body);
        const output = Array.isArray(result.output) ? result.output as any[] : [];
        const message: any = { role: "assistant", content: typeof result.output_text === "string" ? result.output_text : null };
        const functionCalls = output.filter(item => item?.type === "function_call");
        if (functionCalls.length) {
            message.tool_calls = functionCalls.map(item => ({
                id: item.call_id || item.id,
                type: "function",
                function: { name: item.name, arguments: item.arguments || "{}" },
            }));
        }
        sendJson(res, 200, {
            id,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: request.model,
            choices: [{ index: 0, message, finish_reason: functionCalls.length ? "tool_calls" : "stop" }],
            usage: result.usage ?? null,
        });
        return;
    }

    sendSseHeaders(res);
    const toolIndexes = new Map<string, number>();
    let nextToolIndex = 0;
    let sawToolCall = false;
    await forwardSseStream(upstream.body, event => {
        const type = event.type;
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
            sendResponseSse(res, chatChunk(id, request.model, { content: event.delta }));
        } else if (type === "response.output_item.added" && event.item && typeof event.item === "object") {
            const item = event.item as any;
            if (item.type === "function_call") {
                sawToolCall = true;
                const index = nextToolIndex++;
                toolIndexes.set(String(item.id || item.call_id), index);
                sendResponseSse(res, chatChunk(id, request.model, {
                    tool_calls: [{ index, id: item.call_id || item.id, type: "function", function: { name: item.name || "", arguments: "" } }],
                }));
            }
        } else if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
            const index = toolIndexes.get(String(event.item_id)) ?? 0;
            sendResponseSse(res, chatChunk(id, request.model, {
                tool_calls: [{ index, function: { arguments: event.delta } }],
            }));
        } else if (type === "response.completed") {
            sendResponseSse(res, chatChunk(id, request.model, {}, sawToolCall ? "tool_calls" : "stop"));
        }
    });
    if (!res.writableEnded) sendSseDone(res);
}

async function handleModels(res: ServerResponse, client: ChatGPTResponsesClient) {
    try {
        const models = await client.listModels();
        if (models.length) {
            sendJson(res, 200, { object: "list", data: models.map((model: any) => ({
                id: model.id || model.slug || model.model,
                object: "model",
                created: model.created || 0,
                owned_by: model.owned_by || "openai",
            })).filter((model: any) => model.id) });
            return;
        }
    } catch { }
    sendJson(res, 200, {
        object: "list",
        data: [DEFAULT_MODEL, "gpt-5.6-codex", "gpt-5.3-codex"].map(id => ({ id, object: "model", created: 0, owned_by: "openai" })),
    });
}

function handleWebSocketUpgrade(req: IncomingMessage, socket: Stream.Duplex, head: Buffer, wss: WebSocketServer, client: ChatGPTResponsesClient) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!isAllowlistedClient(req) || url.pathname !== "/v1/responses") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
        void handleWebSocketSession(ws, client);
    });
}

async function handleWebSocketSession(ws: WebSocket, client: ChatGPTResponsesClient) {
    ws.on("message", async data => {
        try {
            const message = JSON.parse(data.toString()) as any;
            if (message.type !== "response.create") throw new Error(`Unsupported WebSocket message type: ${String(message.type)}`);
            const request = asResponseRequest(message.data ?? message);
            const upstream = await client.createResponse(request);
            await forwardSseStream(upstream.body, event => {
                if (ws.readyState === 1) ws.send(JSON.stringify(event));
            });
        } catch (error) {
            if (ws.readyState === 1) {
                ws.send(JSON.stringify({
                    type: "response.failed",
                    response: {
                        status: "failed",
                        error: { type: "server_error", code: "server_error", message: error instanceof Error ? error.message : String(error) },
                    },
                }));
            }
        }
    });
}

async function main() {
    const parsed = parseArgs({
        args: process.argv.slice(2),
        options: {
            port: { type: "string", short: "p", default: String(DEFAULT_PORT) },
            browser: { type: "boolean" },
            "user-data-dir": { type: "string" },
            credentials: { type: "string", short: "c", default: getDefaultChatGPTCredentialPath() },
        },
        allowPositionals: false,
        strict: true,
    });

    const credentialPath = parsed.values.credentials;
    if (parsed.values.browser) {
        await authChatGPT({
            launchBrowser: true,
            userDataDir: parsed.values["user-data-dir"],
            outputPath: credentialPath,
            onProgress: message => console.log(`[ChatGPT Auth] ${message}`),
        });
    }

    const credentials = loadChatGPTCredentials(credentialPath);
    const client = new ChatGPTResponsesClient(credentials);
    const server = createServer((req, res) => {
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!isAllowlistedClient(req)) {
            sendJson(res, 403, errorResponse("Forbidden: client IP is not in allowlist.", 403, "forbidden"));
            return;
        }
        if (method === "OPTIONS") {
            res.writeHead(204, { ...corsHeaders(res), "Access-Control-Allow-Headers": "content-type, authorization, x-requested-with", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
            res.end();
            return;
        }
        if (method === "GET" && url.pathname === "/health") {
            sendJson(res, 200, { ok: true, provider: "chatgpt" });
            return;
        }
        if (method === "GET" && url.pathname === "/v1/models") {
            void handleModels(res, client);
            return;
        }
        if (method === "POST" && url.pathname === "/v1/responses") {
            void handleResponses(req, res, client);
            return;
        }
        if (method === "POST" && url.pathname === "/v1/chat/completions") {
            void handleChatCompletions(req, res, client).catch(error => {
                if (!res.headersSent) sendJson(res, 500, errorResponse(error instanceof Error ? error.message : String(error), 500, "server_error"));
            });
            return;
        }
        sendJson(res, 404, errorResponse(`Route not found: ${method} ${url.pathname}`, 404, "not_found"));
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => handleWebSocketUpgrade(req, socket, head, wss, client));

    const port = Number(parsed.values.port) || DEFAULT_PORT;
    server.listen(port, () => {
        console.log(`[WebAI2API ChatGPT] HTTP server listening on http://127.0.0.1:${port}`);
        console.log(`[WebAI2API ChatGPT] WebSocket support enabled on ws://127.0.0.1:${port}/v1/responses`);
        console.log(`[WebAI2API ChatGPT] Allowed client IPs: ${getAllowedIpSummary()}`);
        console.log(`[WebAI2API ChatGPT] Credential source: ${credentialPath}`);
    });
}

if (isDirectRun(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
