import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { parseArgs } from "node:util";
import { ChatGPTBrowserClient, type ChatGPTBrowserRequest } from "./chatgptBrowserClient.js";
import { collectResponse, forwardSseStream, parseSseStream } from "./chatgptResponseStream.js";
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

function normalizeRequest(raw: any): ChatGPTBrowserRequest {
    const input = Array.isArray(raw?.input) ? raw.input : [];
    const request: ChatGPTBrowserRequest = {
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

async function handleResponses(req: IncomingMessage, res: ServerResponse, client: ChatGPTBrowserClient) {
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

async function handleWebSocketSession(ws: WebSocket, client: ChatGPTBrowserClient) {
    console.log("[Local WS] Codex WebSocket connected (browser-backed mode).");
    let queue = Promise.resolve();
    let activeAbort: AbortController | undefined;

    ws.on("message", data => {
        const text = data.toString();
        let message: any;
        try {
            message = JSON.parse(text);
        } catch {
            console.warn("[Local WS] Ignoring non-JSON WebSocket message.");
            return;
        }

        const inputSummary = Array.isArray(message.input)
            ? `input=${message.input.length}`
            : `inputType=${typeof message.input}`;
        console.log(`[Local WS] <- ${message.type || "unknown"}${message.model ? ` model=${message.model}` : ""} ${inputSummary} keys=${Object.keys(message).join(",")}`);
        if (message.type === "response.cancel" || message.type === "response.abort") {
            activeAbort?.abort();
            return;
        }
        if (message.type !== "response.create") {
            // Responses WebSocket clients may send acknowledgements or other control
            // events. Browser mode has no upstream socket to forward these to.
            return;
        }

        queue = queue.then(async () => {
            if (ws.readyState !== 1) return;
            activeAbort = new AbortController();
            try {
                const metadataSources = [message?.client_metadata, message?.metadata, message]
                    .filter(value => value && typeof value === "object" && !Array.isArray(value));
                let threadId = "default";
                for (const metadata of metadataSources) {
                    const value = metadata.thread_id || metadata.threadId || metadata.session_id || metadata.sessionId;
                    if (typeof value === "string" && value.trim()) {
                        threadId = value.trim();
                        break;
                    }
                    // Codex may serialize thread metadata into x-codex-turn-metadata.
                    const turnMetadata = metadata["x-codex-turn-metadata"];
                    if (typeof turnMetadata === "string") {
                        try {
                            const parsed = JSON.parse(turnMetadata) as Record<string, unknown>;
                            const nested = parsed.thread_id || parsed.threadId || parsed.session_id || parsed.sessionId;
                            if (typeof nested === "string" && nested.trim()) {
                                threadId = nested.trim();
                                break;
                            }
                        } catch {
                            // Ignore malformed optional metadata and use the default session.
                        }
                    }
                }
                const response = await client.createResponse(normalizeRequest(message), threadId, activeAbort.signal);
                for await (const event of parseSseStream(response.body)) {
                    if (ws.readyState !== 1) break;
                    ws.send(JSON.stringify(event));
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                console.error(`[Local WS] Browser response failed: ${detail}`);
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        type: "error",
                        error: { type: "browser_error", message: detail },
                    }));
                }
            } finally {
                activeAbort = undefined;
            }
        }).catch(error => console.error("[Local WS] Queue error:", error));
    });

    ws.on("close", () => {
        activeAbort?.abort();
        console.log("[Local WS] Codex WebSocket closed.");
    });
    ws.on("error", error => console.error(`[Local WS] Error: ${error.message}`));
}

async function main() {
    const parsed = parseArgs({ args: process.argv.slice(2), options: { port: { type: "string", short: "p", default: String(DEFAULT_PORT) } }, allowPositionals: false, strict: true });
    const cdpUrl = process.env.CHATGPT_CDP_URL?.trim() || "http://127.0.0.1:9222";
    console.log(`[WebAI2API ChatGPT] Model: ${DEFAULT_MODEL}`);
    console.log(`[WebAI2API ChatGPT] Mode: logged-in browser UI (CDP)`);
    const client = new ChatGPTBrowserClient(cdpUrl);
    await client.connect();

    const server = createServer((req, res) => {
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (!isAllowlistedClient(req)) { console.warn(`[HTTP] Forbidden client: ${req.socket.remoteAddress}`); sendJson(res, 403, errorResponse("Forbidden: client IP is not in allowlist.", 403, "forbidden")); return; }
        if (method === "OPTIONS") { res.writeHead(204, { ...corsHeaders(res), "Access-Control-Allow-Headers": "content-type, authorization, x-requested-with", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" }); res.end(); return; }
        if (method === "GET" && url.pathname === "/health") { console.log("[HTTP] GET /health"); sendJson(res, 200, { ok: true, provider: "chatgpt", model: DEFAULT_MODEL }); return; }
        if (method === "GET" && url.pathname === "/v1/models") { console.log("[HTTP] GET /v1/models"); sendJson(res, 200, { object: "list", data: [{ id: DEFAULT_MODEL, object: "model", created: 0, owned_by: "openai" }] }); return; }
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
