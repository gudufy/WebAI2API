import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import crypto from "node:crypto";

export interface ChatGPTBrowserRequest {
    [key: string]: unknown;
    model: string;
    input: unknown[];
    stream?: boolean;
    store?: boolean;
}

export interface ChatGPTBrowserStreamResult {
    body: ReadableStream<Uint8Array>;
    responseId?: string;
}

type ResponseEvent = Record<string, unknown>;

function id(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function sse(event: ResponseEvent): Uint8Array {
    return new TextEncoder().encode(`event: ${String(event.type || "message")}\ndata: ${JSON.stringify(event)}\n\n`);
}

function textOf(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        return value.map(item => {
            if (!item || typeof item !== "object") return "";
            const part = item as Record<string, unknown>;
            if (typeof part.text === "string") return part.text;
            if (typeof part.content === "string") return part.content;
            if (part.type === "image") return "[image attached]";
            return "";
        }).filter(Boolean).join("\n");
    }
    if (value && typeof value === "object") {
        const item = value as Record<string, unknown>;
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
    }
    return "";
}

function inputToPrompt(input: unknown[]): string {
    // The browser page already holds conversation history. Avoid replaying previous turns
    // when Codex supplies the complete Responses input on each request.
    let lastUser = -1;
    for (let i = 0; i < input.length; i += 1) {
        const item = input[i] as any;
        if (item && typeof item === "object" && item.role === "user" && item.type !== "function_call_output") lastUser = i;
    }
    const selected = input.filter((entry, index) => {
        const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        return index >= lastUser || item.role === "system" || item.role === "developer";
    });
    return selected.map(entry => {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object") return String(entry ?? "");
        const item = entry as Record<string, unknown>;
        if (item.type === "function_call_output") {
            return `[Tool result: ${String(item.call_id || item.id || "unknown")}]
${textOf(item.output) || JSON.stringify(item.output ?? "")}`;
        }
        const role = typeof item.role === "string" ? item.role : String(item.type || "message");
        const content = textOf(item.content ?? item.text ?? item.input);
        if (item.type === "function_call") {
            return `[Previous tool call: ${String(item.name || "tool")}]
${String(item.arguments || "")}`;
        }
        return `[${role}]
${content || JSON.stringify(item)}`;
    }).join("\n\n");
}

function extractFunctionCall(text: string): { name: string; arguments: Record<string, unknown> } | undefined {
    const trimmed = text.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
    try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const call = (parsed.tool_call && typeof parsed.tool_call === "object" ? parsed.tool_call : parsed) as Record<string, unknown>;
        const name = typeof call.name === "string" ? call.name : typeof call.tool === "string" ? call.tool : "";
        if (!name) return undefined;
        const args = call.arguments ?? call.parameters ?? {};
        if (typeof args === "string") {
            try { return { name, arguments: JSON.parse(args) as Record<string, unknown> }; }
            catch { return { name, arguments: { value: args } }; }
        }
        return { name, arguments: args && typeof args === "object" ? args as Record<string, unknown> : {} };
    } catch {
        return undefined;
    }
}

/**
 * Uses the user's already-authenticated Chromium/Edge session via CDP.
 * Start the browser with --remote-debugging-port=9222. No ChatGPT API token
 * or upstream WebSocket is used.
 */
export class ChatGPTBrowserClient {
    private browser?: Browser;
    private context?: BrowserContext;
    private readonly pages = new Map<string, Page>();
    private readonly threadQueues = new Map<string, Promise<void>>();
    private defaultThread = "default";

    constructor(private readonly cdpUrl = process.env.CHATGPT_CDP_URL || "http://127.0.0.1:9222") {}

    async connect(): Promise<void> {
        if (this.browser?.isConnected()) return;
        this.browser = await chromium.connectOverCDP(this.cdpUrl);
        this.context = this.browser.contexts()[0];
        if (!this.context) throw new Error("No browser context found on the CDP connection.");
        const existing = this.context.pages().find(page => page.url().includes("chatgpt.com"));
        if (existing) {
            console.log("[ChatGPT Browser] Detected an existing ChatGPT tab; new Codex threads will use separate tabs in the same logged-in browser context.");
        } else {
            console.log("[ChatGPT Browser] Connected to browser; will open ChatGPT tabs using the existing login state.");
        }
        console.log(`[ChatGPT Browser] CDP connected: ${this.cdpUrl}`);
    }

    private async pageFor(threadId: string): Promise<Page> {
        await this.connect();
        const key = threadId || this.defaultThread;
        let page = this.pages.get(key);
        if (page && !page.isClosed()) return page;
        const context = this.context!;
        // Keep the user's manually open ChatGPT tab untouched. Each Codex thread gets
        // its own new tab while sharing the authenticated CDP browser context/cookies.
        page = await context.newPage();
        this.pages.set(key, page);
        if (!page.url().includes("chatgpt.com")) {
            await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
        }
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
        const loginRequired = await page.locator('input[name="email"], input[type="password"]').count().catch(() => 0);
        if (loginRequired || /\/auth\/login|\/log-in/.test(page.url())) {
            throw new Error("ChatGPT is not logged in in the connected browser. Log in to chatgpt.com and retry.");
        }
        return page;
    }

    async createResponse(
        request: ChatGPTBrowserRequest,
        threadId = this.defaultThread,
        signal?: AbortSignal,
    ): Promise<ChatGPTBrowserStreamResult> {
        const responseId = id("resp");
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start: controller => {
                const key = threadId || this.defaultThread;
                const previous = this.threadQueues.get(key) ?? Promise.resolve();
                const task = previous.catch(() => undefined).then(() =>
                    this.runResponse(request, key, responseId, controller, signal)
                );
                this.threadQueues.set(key, task);
                void task.catch(error => {
                    if (signal?.aborted) {
                        try { controller.close(); } catch { /* stream already closed */ }
                        return;
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    try {
                        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "browser_error", message } })}\n\n`));
                        controller.close();
                    } catch { /* consumer already cancelled the stream */ }
                }).finally(() => {
                    if (this.threadQueues.get(key) === task) this.threadQueues.delete(key);
                });
            },,
        });
        return { body, responseId };
    }

    private async runResponse(
        request: ChatGPTBrowserRequest,
        threadId: string,
        responseId: string,
        controller: ReadableStreamDefaultController<Uint8Array>,
        signal?: AbortSignal,
    ): Promise<void> {
        let sequenceNumber = 0;
        const send = (event: ResponseEvent) => controller.enqueue(sse({ ...event, sequence_number: sequenceNumber++ }));
        const now = Math.floor(Date.now() / 1000);
        if (request.generate === false || !Array.isArray(request.input) || request.input.length === 0) {
            send({ type: "response.created", response: { id: responseId, object: "response", created_at: now, status: "in_progress", model: request.model, output: [] } });
            send({
                type: "response.completed",
                response: {
                    id: responseId, object: "response", created_at: now, completed_at: now,
                    status: "completed", model: request.model, output: [],
                    output_text: "", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                },
            });
            controller.close();
            return;
        }
        const outputItemId = id("msg");
        const outputTextId = id("part");
        const tools = Array.isArray(request.tools) ? request.tools.filter((t: any) => t && (t.type === "function" || t.name)) : [];
        let prompt = inputToPrompt(Array.isArray(request.input) ? request.input : []);
        const instructions = typeof request.instructions === "string" ? request.instructions : "";
        if (tools.length) {
            prompt += `

IMPORTANT TOOL-CALL PROTOCOL:
The caller has these tools:
${JSON.stringify(tools)}
If you need to call one, do not claim to execute it. Reply with ONLY a JSON object in this exact shape:
{"tool_call":{"name":"EXACT_TOOL_NAME","arguments":{}}}
Use the tool's declared JSON schema. Do not wrap it in markdown.
If no tool is needed, reply normally. Do not produce a tool_call unless calling a listed tool.`;
        }
        const fullPrompt = [instructions, prompt].filter(Boolean).join("\n\n");
        const page = await this.pageFor(threadId);
        signal?.throwIfAborted();
        const stopOnAbort = () => {
            void page.locator('button[data-testid="stop-button"], button[aria-label*="Stop generating"]').last()
                .click({ timeout: 1500 }).catch(() => undefined);
        };
        signal?.addEventListener("abort", stopOnAbort, { once: true });

        const messageSelector = 'main [data-message-author-role="assistant"]';
        const before = await page.locator(messageSelector).count().catch(() => 0);
        const editor = page.locator('#prompt-textarea, textarea[placeholder], [contenteditable="true"][data-placeholder]').last();
        await editor.waitFor({ state: "visible", timeout: 30000 });
        const tag = await editor.evaluate(el => el.tagName.toLowerCase());
        if (tag === "textarea" || tag === "input") await editor.fill(fullPrompt);
        else await editor.fill(fullPrompt);

        const sendButton = page.locator('button[data-testid="send-button"], button[aria-label*="Send prompt"], button[aria-label="Send"]').last();
        await sendButton.waitFor({ state: "visible", timeout: 15000 });
        await sendButton.click();

        send({ type: "response.created", sequence_number: 0, response: { id: responseId, object: "response", created_at: now, status: "in_progress", model: request.model, output: [] } });
        if (!tools.length) {
            send({ type: "response.output_item.added", output_index: 0, item: { id: outputItemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
            send({ type: "response.content_part.added", item_id: outputItemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        }

        let previous = "";
        let stableSince = Date.now();
        let sawNewAssistant = false;
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
            signal?.throwIfAborted();
            const count = await page.locator(messageSelector).count().catch(() => 0);
            const last = page.locator(messageSelector).last();
            const text = count > before ? (await last.innerText().catch(() => "")) : "";
            if (text && text !== previous) {
                sawNewAssistant = true;
                const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
                // Buffer tool-enabled output until its Responses item type is known.
                if (!tools.length && delta) {
                    send({ type: "response.output_text.delta", sequence_number: 3, item_id: outputItemId, output_index: 0, content_index: 0, delta });
                }
                previous = text;
                stableSince = Date.now();
            }
            const stopButton = page.locator('button[data-testid="stop-button"], button[aria-label*="Stop generating"]').last();
            const stopVisible = await stopButton.isVisible().catch(() => false);
            if (sawNewAssistant && !stopVisible && Date.now() - stableSince > 1300) break;
            await new Promise(resolve => setTimeout(resolve, 180));
        }
        if (!sawNewAssistant) throw new Error("No assistant response appeared in ChatGPT within 5 minutes.");
        if (Date.now() >= deadline) throw new Error("Timed out waiting for ChatGPT to finish generating a response.");

        const functionCall = tools.length ? extractFunctionCall(previous) : undefined;
        let output: Record<string, unknown>[];
        if (functionCall && tools.some((tool: any) => tool.name === functionCall.name || tool.function?.name === functionCall.name)) {
            const callId = id("call");
            const item = { id: callId, call_id: callId, type: "function_call", name: functionCall.name, arguments: JSON.stringify(functionCall.arguments), status: "completed" };
            send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } });
            if (item.arguments) {
                send({ type: "response.function_call_arguments.delta", item_id: callId, output_index: 0, delta: item.arguments });
                send({ type: "response.function_call_arguments.done", item_id: callId, output_index: 0, arguments: item.arguments });
            }
            send({ type: "response.output_item.done", output_index: 0, item });
            output = [item];
        } else {
            const item = {
                id: outputItemId, type: "message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: previous, annotations: [] }],
            };
            if (tools.length) {
                send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
                send({ type: "response.content_part.added", item_id: outputItemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
                if (previous) send({ type: "response.output_text.delta", item_id: outputItemId, output_index: 0, content_index: 0, delta: previous });
            }
            send({ type: "response.output_text.done", item_id: outputItemId, output_index: 0, content_index: 0, text: previous });
            send({ type: "response.content_part.done", item_id: outputItemId, output_index: 0, content_index: 0, part: item.content[0] });
            send({ type: "response.output_item.done", output_index: 0, item });
            output = [item];
        }
        send({
            type: "response.completed", sequence_number: 6,
            response: {
                id: responseId, object: "response", created_at: now, completed_at: Math.floor(Date.now() / 1000),
                status: "completed", model: request.model, output,
                output_text: functionCall ? "" : previous,
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            },
        });
        signal?.removeEventListener("abort", stopOnAbort);
        controller.close();
    }

    async close(): Promise<void> {
        // Do not close the user's browser. Only detach this CDP client.
        this.pages.clear();
        this.threadQueues.clear();
        await this.browser?.close();
        this.browser = undefined;
        this.context = undefined;
    }
}
