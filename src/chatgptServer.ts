import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Stream from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { parseArgs } from "node:util";
import { ChatGPTResponsesClient, normalizeChatGPTCredentials, type ChatGPTResponseRequest } from "./chatgptResponsesClient.js";
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
        instructions: typeof raw.instructions === "string" && raw.instructions.trim() ? raw.instructions : "You are a helpful coding assistant.",
        stream: true,
        store: false,
    };
}

function chatMessagesToResponses(raw: any): ChatGPTResponseRequest {
    const messages = Array.isArray(raw?.messages) ? raw.messages : [];
    if (!messages.length) throw new Error("messages must be a non-empty array.");
    const input = messages.map((message: any) => ({
        type: "message",
        role: message?.role === "system" ? "developer" : message?.role,
        content: typeof message?.content === "string" ? [{ type: "input_text", text: message.content }] : message?.content,
    }));
    return {
        model: typeof raw?.model === "string" && raw.model.trim() ? raw.model : DEFAULT_MODEL,
        input,
        instructions: "You are a helpful coding assistant.",
        stream: true,
        store: false,
        ...(Array.isArray(raw?.tools) ? { tools: raw.tools.map((tool: any) => tool.type === "function" ? { type: "function", ...tool.function } : tool) } : {}),
        ...(raw?.tool_choice !== undefined ? { tool_choice: raw.tool_choice } : {}),
    };
}

function sendEvent(res: ServerResponse, event: Record<string, unknown>) {
    sendSseData(res, event);
}

async function handleResponses(req: IncomingMessage, res: ServerResponse, client: ChatGPTResponsesClient) {
    try {
        const raw = await readRequestJson(req);
        const upstream = await client.createResponse(asResponseRequest(raw));
        if (raw.stream === true) {
            sendSseHeaders(res);
            await forwardSseStream(upstream.body, event => {
                if (!res.writableEnded) sendEvent(res, event);
            });
            if (!res.writableEnded) sendSseDone(res);
            return;
        }
        sendJson(res, 200, await collectResponse(upstream.body));
    } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        sendJson(res, 500, errorResponse(error instanceof Error ? error.message : String(error), 500, "server_error"));
    }
}

function chatChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
    return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, client: ChatGPTResponsesClient) {
    const raw = await readRequestJson(req);
    const request = chatMessagesToResponses(raw);
    const id = `chatcmpl-${Date.now()}`;
    const upstream = await client.createResponse(request);

    if (raw.stream === false) {
        const result = await collectResponse(upstream.body);
        const output = Array.isArray(result.output) ? result.output as any[] : [];
        const calls = output.filter(item => item?.type === "function_call");
        const message: any = { role: "assistant", content: typeof result.output_text === "string" ? result.output_text : null };
        if (calls.length) message.tool_calls = calls.map(item => ({ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } }));
        sendJson(res, 200, { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: result.usage ?? null });
        return;
    }

    sendSseHeaders(res);
    const indexes = new Map<string, number>();
    let nextIndex = 0;
    let sawTool = false;
    await forwardSseStream(upstream.body, event => {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            sendEvent(res, chatChunk(id, request.model, { content: event.delta }));
        } else if (event.type === "response.output_item.added" && event.item && typeof event.item === "object") {
            const item = event.item as any;
            if (item.type === "function_call") {
                sawTool = true;
                const index = nextIndex++;
                indexes.set(String(item.id || item.call_id), index);
                sendEvent(res, chatChunk(id, request.model, { tool_calls: [{ index, id: item.call_id || item.id, type: "function", function: { name: item.name || "", arguments: "" } }] }));
            }
        } else if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
            const index = indexes.get(String(event.item_id)) ?? 0;
            sendEvent(res, chatChunk(id, request.model, { tool_calls: [{ index, function: { arguments: event.delta } }] }));
        } else if (event.type === "response.completed") {
            sendEvent(res, chatChunk(id, request.model, {}, sawTool ? "tool_calls" : "stop"));
        }
    });
    if (!res.writableEnded) sendSseDone(res);
}

async function handleModels(res: ServerResponse, client: ChatGPTResponsesClient) {
    const models = await client.listModels().catch(() => []);
    const data = models.length ? models.map((model: any) => ({ id: model.id || model.slug || model.model, object: "model", created: model.created || 0, owned_by: model.owned_by || "openai" })).filter((model: any) => model.id) : [DEFAULT_MODEL, "gpt-5.6-codex", "gpt-5.3-codex"].map(id => ({ id, object: "model", created: 0, owned_by: "openai" }));
    sendJson(res, 200, { object: "list", data });
}

async function handleWebSocketSession(ws: WebSocket, client: ChatGPTResponsesClient) {
    ws.on("message", async data => {
        try {
            const message = JSON.parse(data.toString()) as any;
            if (message.type !== "response.create") throw new Error(`Unsupported WebSocket message type: ${String(message.type)}`);
            const upstream = await client.createResponse(asResponseRequest(message.data ?? message));
            await forwardSseStream(upstream.body, event => {
                if (ws.readyState === 1) ws.send(JSON.stringify(event));
            });
        } catch (error) {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "response.failed", response: { status: "failed", error: { type: "server_error", code: "server_error", message: error instanceof Error ? error.message : String(error) } } }));
        }
    });
}

async function main() {
    const parsed = parseArgs({ args: process.argv.slice(2), options: { port: { type: "string", short: "p", default: String(DEFAULT_PORT) } }, allowPositionals: false, strict: true });
    const accessToken = process.env.CHATGPT_ACCESS_TOKEN?.trim();
    if (!accessToken) throw new Error("CHATGPT_ACCESS_TOKEN is required. Use a ChatGPT/Codex OAuth access token.");
    const credentials = normalizeChatGPTCredentials({ accessToken, accountId: process.env.CHATGPT_ACCOUNT_ID, userAgent: process.env.CHATGPT_USER_AGENT });
    const client = new ChatGPTResponsesClient(credentials);

    const server = createServer((req, res) => {
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!isAllowlistedClient(req)) { sendJson(res, 403, errorResponse("Forbidden: client IP is not in allowlist.", 403, "forbidden")); return; }
        if (method === "OPTIONS") { res.writeHead(204, { ...corsHeaders(res), "Access-Control-Allow-Headers": "content-type, authorization, x-requested-with", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" }); res.end(); return; }
        if (method === "GET" && url.pathname === "/health") { sendJson(res, 200, { ok: true, provider: "chatgpt" }); return; }
        if (method === "GET" && url.pathname === "/v1/models") { void handleModels(res, client); return; }
        if (method === "POST" && url.pathname === "/v1/responses") { void handleResponses(req, res, client); return; }
        if (method === "POST" && url.pathname === "/v1/chat/completions") { void handleChatCompletions(req, res, client).catch(error => { if (!res.headersSent) sendJson(res, 500, errorResponse(error instanceof Error ? error.message : String(error), 500, "server_error")); }); return; }
        sendJson(res, 404, errorResponse(`Route not found: ${method} ${url.pathname}`, 404, "not_found"));
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!isAllowlistedClient(req) || url.pathname !== "/v1/responses") { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => { void handleWebSocketSession(ws, client); });
    });

    const port = Number(parsed.values.port) || DEFAULT_PORT;
    server.listen(port, () => {
        console.log(`[WebAI2API ChatGPT] HTTP server listening on http://127.0.0.1:${port}`);
        console.log(`[WebAI2API ChatGPT] WebSocket support enabled on ws://127.0.0.1:${port}/v1/responses`);
        console.log(`[WebAI2API ChatGPT] Allowed client IPs: ${getAllowedIpSummary()}`);
    });
}

if (isDirectRun(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
