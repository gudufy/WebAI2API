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

function normalizeRequest(raw: any): ChatGPTResponseRequest {
    const input = Array.isArray(raw?.input) ? raw.input : [];
    const request: ChatGPTResponseRequest = {
        ...raw,
        model: typeof raw?.model === "string" && raw.model.trim() ? raw.model : DEFAULT_MODEL,
        input,
        instructions: typeof raw?.instructions === "string" && raw.instructions.trim() ? raw.instructions : "You are a helpful coding assistant.",
        stream: true,
        store: false,
    };
    if (input.length === 0 && request.generate === undefined) request.generate = false;
    return request;
}

async function handleResponses(req: IncomingMessage, res: ServerResponse, client: ChatGPTResponsesClient) {
    try {
        const raw = await readRequestJson(req);
        const upstream = await client.createResponse(normalizeRequest(raw));
        if (raw.stream === true) {
            sendSseHeaders(res);
            await forwardSseStream(upstream.body, event => { if (!res.writableEnded) sendSseData(res, event); });
            if (!res.writableEnded) sendSseDone(res);
            return;
        }
        sendJson(res, 200, await collectResponse(upstream.body));
    } catch (error) {
        if (!res.headersSent) sendJson(res, 500, errorResponse(error instanceof Error ? error.message : String(error), 500, "server_error"));
    }
}

async function handleWebSocketSession(ws: WebSocket, client: ChatGPTResponsesClient) {
    ws.on("message", async data => {
        try {
            const message = JSON.parse(data.toString()) as any;
            if (message.type !== "response.create") throw new Error(`Unsupported WebSocket message type: ${String(message.type)}`);
            const upstream = await client.createResponse(normalizeRequest(message.data ?? message));
            await forwardSseStream(upstream.body, event => { if (ws.readyState === 1) ws.send(JSON.stringify(event)); });
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
        if (method === "GET" && url.pathname === "/v1/models") { void client.listModels().then(models => sendJson(res, 200, { object: "list", data: (models.length ? models : [{ id: DEFAULT_MODEL }]).map((m: any) => ({ id: m.id || m.slug || m.model, object: "model", created: m.created || 0, owned_by: "openai" })) })).catch(error => sendJson(res, 500, errorResponse(String(error), 500, "server_error"))); return; }
        if (method === "POST" && url.pathname === "/v1/responses") { void handleResponses(req, res, client); return; }
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
