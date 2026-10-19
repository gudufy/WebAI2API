import crypto from "node:crypto";
import { WebSocket } from "ws";

export interface ChatGPTCredentials {
    accessToken: string;
    accountId?: string;
    userAgent?: string;
    cookie?: string;
}

export interface ChatGPTResponseRequest {
    [key: string]: unknown;
    model: string;
    input: unknown[];
    stream: true;
    store: false;
}

export interface ChatGPTStreamResult {
    body: ReadableStream<Uint8Array>;
    responseId?: string;
}

export interface ChatGPTWebSocketMetadata {
    sessionId?: string;
    threadId?: string;
    turnId?: string;
    windowId?: string;
    turnMetadata?: string;
    version?: string;
}

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

function getAccountIdFromJwt(accessToken: string): string | undefined {
    try {
        const parts = accessToken.split(".");
        if (parts.length < 2) return undefined;
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
        const auth = payload["https://api.openai.com/auth"];
        if (auth && typeof auth === "object") {
            const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
            if (typeof accountId === "string" && accountId) return accountId;
        }
        const accountId = payload.chatgpt_account_id;
        return typeof accountId === "string" && accountId ? accountId : undefined;
    } catch {
        return undefined;
    }
}

export function normalizeChatGPTCredentials(credentials: ChatGPTCredentials): ChatGPTCredentials {
    return { ...credentials, accountId: credentials.accountId || getAccountIdFromJwt(credentials.accessToken) };
}

function createRequestId(): string {
    return crypto.randomUUID();
}

export class ChatGPTResponsesClient {
    readonly credentials: ChatGPTCredentials;
    readonly baseUrl: string;

    constructor(credentials: ChatGPTCredentials, baseUrl = CODEX_BASE_URL) {
        if (!credentials.accessToken?.trim()) throw new Error("ChatGPT access token is required.");
        this.credentials = normalizeChatGPTCredentials(credentials);
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }

    private headers(): Record<string, string> {
        const headers: Record<string, string> = {
            "Authorization": `Bearer ${this.credentials.accessToken}`,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "originator": "codex_cli_rs",
            "OpenAI-Beta": "responses_websockets=2026-02-06",
            "User-Agent": this.credentials.userAgent || "WebAI2API/ChatGPT",
            "x-client-request-id": createRequestId(),
        };
        if (this.credentials.accountId) headers["ChatGPT-Account-Id"] = this.credentials.accountId;
        if (this.credentials.cookie) headers.Cookie = this.credentials.cookie;
        return headers;
    }

    private websocketHeaders(metadata: ChatGPTWebSocketMetadata = {}): Record<string, string> {
        const headers = this.headers();
        delete headers["Content-Type"];
        delete headers.Accept;

        headers["Originator"] = "codex_cli_rs";
        headers["Version"] = metadata.version || process.env.CHATGPT_CODEX_VERSION || "0.0.0";
        if (metadata.sessionId) {
            headers.session_id = metadata.sessionId;
            headers["session-id"] = metadata.sessionId;
        }
        if (metadata.threadId) {
            headers.thread_id = metadata.threadId;
            headers["thread-id"] = metadata.threadId;
        }
        if (metadata.windowId) headers["x-codex-window-id"] = metadata.windowId;
        if (metadata.turnMetadata) headers["x-codex-turn-metadata"] = metadata.turnMetadata;
        return headers;
    }

    async createResponse(request: Omit<ChatGPTResponseRequest, "stream" | "store"> & Partial<Pick<ChatGPTResponseRequest, "stream" | "store">>, signal?: AbortSignal): Promise<ChatGPTStreamResult> {
        const body: ChatGPTResponseRequest = { ...request, stream: true, store: false };
        if (!Array.isArray(body.input)) throw new Error("ChatGPT Codex Responses requires input to be an array.");

        const response = await fetch(`${this.baseUrl}/responses`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(body),
            signal,
        });
        if (!response.ok || !response.body) {
            const text = await response.text().catch(() => "");
            let detail = text.trim();
            try {
                const json = JSON.parse(text) as { detail?: string; error?: { message?: string } };
                detail = json.error?.message || json.detail || detail;
            } catch { }
            throw new Error(`ChatGPT Codex request failed (${response.status}): ${detail || response.statusText}`);
        }
        return { body: response.body };
    }

    async connectWebSocket(metadata: ChatGPTWebSocketMetadata = {}, signal?: AbortSignal): Promise<WebSocket> {
        const wsUrl = `${this.baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/responses`;
        const headers = this.websocketHeaders(metadata);
        console.log(`[ChatGPT] Connecting upstream WebSocket: ${wsUrl}`);
        console.log(`[ChatGPT] Handshake metadata: session=${metadata.sessionId ? "yes" : "no"} thread=${metadata.threadId ? "yes" : "no"} window=${metadata.windowId ? "yes" : "no"} version=${headers.Version}`);
        return await new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(wsUrl, { headers });
            let settled = false;
            const cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
            const onAbort = () => {
                if (settled) return;
                settled = true;
                ws.close();
                cleanupAbort();
                reject(new Error("ChatGPT WebSocket connection aborted."));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            ws.once("open", () => {
                if (settled) return;
                settled = true;
                cleanupAbort();
                console.log("[ChatGPT] Upstream WebSocket connected.");
                resolve(ws);
            });
            ws.once("unexpected-response", (_request, response) => {
                if (settled) return;
                settled = true;
                cleanupAbort();
                let body = "";
                response.on("data", chunk => { body += String(chunk); });
                response.on("end", () => {
                    const headersText = Object.entries(response.headers)
                        .filter(([name]) => /^(www-authenticate|x-request-id|x-ratelimit|cf-ray)$/i.test(name))
                        .map(([name, value]) => `${name}=${Array.isArray(value) ? value.join(",") : value}`)
                        .join(" ");
                    const detail = body.trim().replace(/\s+/g, " ").slice(0, 1000);
                    reject(new Error(`ChatGPT WebSocket handshake failed: HTTP ${response.statusCode}${headersText ? ` ${headersText}` : ""}${detail ? ` ${detail}` : ""}`));
                });
            });
            ws.once("error", error => {
                if (settled) return;
                settled = true;
                cleanupAbort();
                reject(error);
            });
            ws.once("close", (code, reason) => {
                if (settled) console.log(`[ChatGPT] Upstream WebSocket closed: ${code} ${reason.toString()}`);
            });
        });
    }

    async listModels(signal?: AbortSignal): Promise<any[]> {
        const response = await fetch(`${this.baseUrl}/models?client_version=WebAI2API`, {
            headers: { ...this.headers(), Accept: "application/json" },
            signal,
        });
        if (!response.ok) return [];
        const json = await response.json().catch(() => null) as any;
        if (Array.isArray(json)) return json;
        if (Array.isArray(json?.data)) return json.data;
        if (Array.isArray(json?.models)) return json.models;
        return [];
    }
}
