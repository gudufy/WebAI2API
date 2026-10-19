import crypto from "node:crypto";

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
    return {
        ...credentials,
        accountId: credentials.accountId || getAccountIdFromJwt(credentials.accessToken),
    };
}

function createRequestId(): string {
    return crypto.randomUUID();
}

export class ChatGPTResponsesClient {
    readonly credentials: ChatGPTCredentials;
    readonly baseUrl: string;

    constructor(credentials: ChatGPTCredentials, baseUrl = CODEX_BASE_URL) {
        if (!credentials.accessToken?.trim()) {
            throw new Error("ChatGPT access token is required.");
        }
        this.credentials = normalizeChatGPTCredentials(credentials);
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }

    private headers(): Record<string, string> {
        const headers: Record<string, string> = {
            "Authorization": `Bearer ${this.credentials.accessToken}`,
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "originator": "WebAI2API",
            "OpenAI-Beta": "responses_websockets=2026-02-06",
            "User-Agent": this.credentials.userAgent || "WebAI2API/ChatGPT",
            "x-client-request-id": createRequestId(),
        };
        if (this.credentials.accountId) {
            headers["ChatGPT-Account-Id"] = this.credentials.accountId;
        }
        if (this.credentials.cookie) {
            headers.Cookie = this.credentials.cookie;
        }
        return headers;
    }

    async createResponse(request: Omit<ChatGPTResponseRequest, "stream" | "store"> & Partial<Pick<ChatGPTResponseRequest, "stream" | "store">>, signal?: AbortSignal): Promise<ChatGPTStreamResult> {
        const body: ChatGPTResponseRequest = {
            ...request,
            stream: true,
            store: false,
        };

        if (!Array.isArray(body.input)) {
            throw new Error("ChatGPT Codex Responses requires input to be an array.");
        }

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

        return {
            body: response.body,
        };
    }

    async listModels(signal?: AbortSignal): Promise<any[]> {
        const response = await fetch(`${this.baseUrl}/models?client_version=WebAI2API`, {
            headers: {
                ...this.headers(),
                Accept: "application/json",
            },
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

export function parseSseJsonLines(text: string): Record<string, unknown>[] {
    const events: Record<string, unknown>[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === "object") events.push(parsed);
        } catch { }
    }
    return events;
}
