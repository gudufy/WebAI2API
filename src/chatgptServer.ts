import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { parseArgs } from "node:util";
import { ChatGPTResponsesClient, normalizeChatGPTCredentials, type ChatGPTResponseRequest } from "./chatgptResponsesClient.js";
import { collectResponse, forwardSseStream } from "./chatgptResponseStream.js";
import { errorResponse, getAllowedIpSummary, isAllowlistedClient, readRequestJson, sendJson, sendSseData, sendSseDone, sendSseHeaders, corsHeaders } from "./server/httpUtils.js";
import { isDirectRun } from "./utils.js";

const DEFAULT_PORT = 8787;
const DEFAULT_MODEL = process.env.CHATGPT_MODEL?.trim() || "gpt-5.5";

function normalizeModel(model: unknown): string {
    const requested = typeof model === "string" && model.trim() ? model.trim() : DEFAULT_MODEL;
    if (/^gpt-/i.test(requested)) return requested;
    console.log(`[ChatGPT] Mapping local model "${requested}" -> "${DEFAULT_MODEL}"`);
    return DEFAULT_MODEL;
}

function normalizeRequest(raw: any): ChatGPTResponseRequest {
    const input = Array.isArray(raw?.input) ? raw.input : [];
    const request: ChatGPTResponseRequest = {
        ...raw,
        model: normalizeModel(raw?.model),
        input,
        instructions: typeof raw?.instructions === "string" && raw.instructions.trim() ? raw.instructions : "You are a helpful coding assistant.",
        stream: true,
        store: false,
    };
    if (input.length === 0 && request.generate === undefined) request.generate = false;
    return request;
}

function describeRequest(raw: any): string {
    const inputCount = Array.isArray(raw?.input) ? raw.input.length : 0;
    const model = typeof raw?.model === "string" ? raw.model : DEFAULT_MODEL;
    const type = typeof raw?.type === "string" ? raw.type : "response.create";
    return `type=${type} model=${model} input=${inputCount} stream=${raw?.stream === true}`;
}

async function handleResponses(req: IncomingMessage, res: ServerResponse, client: ChatGPTResponsesClient) {
    try {
        const raw = await readRequestJson(req);
        console.log(`[Local HTTP] POST /v1/responses ${describeRequest(raw)}`);
        const upstream = await client.createResponse(normalizeRequest(raw));
        console.log("[Local HTTP] Upstream ChatGPT response connected.");
        if (raw.stream === true) {
            sendSseHeaders(res);
            await forwardSseStream(upstream.body, event => { if (!res.writableEnded) sendSseData(res, event); });
            if (!res.writableEnded) sendSseDone(res);
            console.log("[Local HTTP] Response stream completed.");
            return;
        }
        sendJson(res, 200, await collectResponse(upstream.body));
        console.log("[Local HTTP] Response completed.");
    } catch (error) {
        console.error(`[Local HTTP] Error: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, errorResponse(error instanceof Error ? error.message : String(error), 500, "server_error"));
    }
}

async function handleWebSocketSession(ws: WebSocket, client: ChatGPTResponsesClient) {
    console.log("[Local WS] Codex WebSocket connected.");
    let upstream: WebSocket | undefined;
    let connecting: Promise<WebSocket> | undefined;

    const getUpstream = async () => {
        if (upstream && upstream.readyState === 1) return upstream;
        if (!connecting) {
            connecting = client.connectWebSocket().then(socket => {
                upstream = socket;
                connecting = undefined;
                socket.on("message", data => {
                    if (ws.readyState === 1) ws.send(data.toString());
                });
                socket.on("close", (code, reason) => {
                    console.log(`[Local WS] Upstream closed: ${code} ${reason.toString()}`);
                    upstream = undefined;
                    if (ws.readyState === 1) ws.close(code || 1000, reason.toString());
                });
                socket.on("error", error => console.error(`[Local WS] Upstream error: ${error.message}`));
                return socket;
            }).catch(error => {
                connecting = undefined;
                throw error;
            });
        }
        return connecting;
    };

    ws.on("message", async data => {
        const text = data.toString();
        try {
            const message = JSON.parse(text) as any;
            console.log(`[Local WS] <- ${message.type || "unknown"}${message.model ? ` model=${message.model}` : ""}`);
            const socket = await getUpstream();
            if (socket.readyState !== 1) throw new Error(`Upstream WebSocket is not open (state=${socket.readyState}).`);
            const outgoing = message.type === "response.create" ? { ...message, model: normalizeModel(message.model) } : message;
            socket.send(JSON.stringify(outgoing));
            console.log(`[Upstream WS] -> ${message.type || "unknown"}${message.type === "response.create" ? ` model=${normalizeModel(message.model)}` : ""}`);
        } catch (error) {
            console.error(`[Local WS] Error: ${error instanceof Error ? error.message : String(error)}`);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", status: 500, error: { type: "server_error", message: error instanceof Error ? error.message : String(error) } }));
        }
    });

    ws.on("close", () => {
        console.log("[Local WS] Codex WebSocket closed.");
        if (upstream) upstream.close(1000, "Local client disconnected");
    });
    ws.on("error", error => console.error(`[Local WS] Error: ${error.message}`));
}

async function main() {
    const parsed = parseArgs({ args: process.argv.slice(2), options: { port: { type: "string", short: "p", default: String(DEFAULT_PORT) } }, allowPositionals: false, strict: true });
    const accessToken = process.env.CHATGPT_ACCESS_TOKEN?.trim();
    if (!accessToken) throw new Error("CHATGPT_ACCESS_TOKEN is required. Use a ChatGPT/Codex OAuth access token.");
    const credentials = normalizeChatGPTCredentials({ accessToken, accountId: process.env.CHATGPT_ACCOUNT_ID, userAgent: process.env.CHATGPT_USER_AGENT });
    console.log(`[WebAI2API ChatGPT] Account ID: ${credentials.accountId ? "detected" : "not detected"}`);
    console.log(`[WebAI2API ChatGPT] Model: ${DEFAULT_MODEL}`);
    const client = new ChatGPTResponsesClient(credentials);

    const server = createServer((req, res) => {
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!isAllowlistedClient(req)) { console.warn(`[HTTP] Forbidden client: ${req.socket.remoteAddress}`); sendJson(res, 403, errorResponse("Forbidden: client IP is not in allowlist.", 403, "forbidden")); return; }
        if (method === "OPTIONS") { res.writeHead(204, { ...corsHeaders(res), "Access-Control-Allow-Headers": "content-type, authorization, x-requested-with", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" }); res.end(); return; }
        if (method === "GET" && url.pathname === "/health") { console.log("[HTTP] GET /health"); sendJson(res, 200, { ok: true, provider: "chatgpt", model: DEFAULT_MODEL }); return; }
        if (method === "GET" && url.pathname === "/v1/models") { console.log("[HTTP] GET /v1/models"); void client.listModels().then(models => sendJson(res, 200, { object: "list", data: (models.length ? models : [{ id: DEFAULT_MODEL }]).map((m: any) => ({ id: m.id || m.slug || m.model, object: "model", created: m.created || 0, owned_by: "openai" })) })).catch(error => { console.error(`[HTTP] /v1/models error: ${error.message}`); sendJson(res, 500, errorResponse(String(error), 500, "server_error")); }); return; }
        if (method === "POST" && url.pathname === "/v1/responses") { void handleResponses(req, res, client); return; }
        console.log(`[HTTP] 404 ${method} ${url.pathname}`);
        sendJson(res, 404, errorResponse(`Route not found: ${method} ${url.pathname}`, 404, "not_found"));
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        console.log(`[HTTP] WebSocket upgrade ${url.pathname} from ${req.socket.remoteAddress || "unknown"}`);
        if (!isAllowlistedClient(req) || url.pathname !== "/v1/responses") { console.warn("[HTTP] WebSocket upgrade rejected."); socket.destroy(); return; }
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
