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
    private readonly inputSnapshots = new Map<string, string[]>();
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
        const context = this.context!;
        const isChatGPTPage = (candidate: Page) => {
            try { return /(^|\.)chatgpt\.com$/i.test(new URL(candidate.url()).hostname); }
            catch { return false; }
        };
        const pageLooksReady = async (candidate: Page): Promise<boolean> => {
            try {
                const title = await candidate.title();
                const state = await candidate.evaluate(() => ({
                    bodyText: document.body?.innerText || "",
                    hasComposer: Boolean(document.querySelector("#prompt-textarea, [contenteditable=\"true\"], textarea[placeholder]")),
                }));
                const challenge = /just a moment|verify you are human|checking your browser|cloudflare|请稍候|正在检查您的浏览器|验证您是人类/i.test(title + " " + state.bodyText)
                    || /\/cdn-cgi\/|challenge-platform/i.test(new URL(candidate.url()).pathname);
                return !challenge && (state.hasComposer || state.bodyText.trim().length > 0);
            } catch { return false; }
        };
        const cached = this.pages.get(key);
        const openPages = context.pages().filter(candidate => !candidate.isClosed() && isChatGPTPage(candidate));
        console.log(`[ChatGPT Browser] CDP tabs: ${JSON.stringify(context.pages().map((candidate, index) => ({ index, url: candidate.url(), closed: candidate.isClosed() })))}`);
        // CDP can expose multiple ChatGPT tabs. Do not blindly reuse the first tab:
        // an older hidden tab may remain on Cloudflare while the visible tab works.
        // Prefer the cached tab only if it is healthy; otherwise scan newest tabs first.
        let page: Page | undefined;
        if (cached && !cached.isClosed() && isChatGPTPage(cached) && await pageLooksReady(cached)) {
            page = cached;
        } else {
            for (const candidate of [...openPages].reverse()) {
                if (await pageLooksReady(candidate)) { page = candidate; break; }
            }
        }
        if (!page && cached && !cached.isClosed() && isChatGPTPage(cached)) page = cached;
        if (!page && openPages.length) page = openPages[openPages.length - 1];
        if (page) {
            console.log(`[ChatGPT Browser] Selected ChatGPT tab for thread ${key}; url=${page.url()}; healthy=${await pageLooksReady(page)}; openChatGPTTabs=${openPages.length}.`);
        } else {
            console.log(`[ChatGPT Browser] No existing ChatGPT tab found; creating browser tab for thread ${key}.`);
            page = await context.newPage();
            console.log(`[ChatGPT Browser] Browser tab created; initialUrl=${page.url() || "(empty)"}.`);
        }
        this.pages.set(key, page);
        if (!page.url().includes("chatgpt.com")) {
            console.log("[ChatGPT Browser] Navigating to https://chatgpt.com/ (timeout 25s).");
            try {
                await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 25000 });
                console.log(`[ChatGPT Browser] Navigation finished; url=${page.url()}`);
            } catch (error) {
                const currentUrl = page.url();
                const title = await page.title().catch(() => "");
                console.error(`[ChatGPT Browser] Navigation did not finish; url=${currentUrl}; title=${title}; error=${error instanceof Error ? error.message : String(error)}`);
                if (/challenge-platform|__cf_chl|cdn-cgi/i.test(currentUrl + " " + title)) {
                    throw new Error("ChatGPT is showing a Cloudflare verification page in the WebAI2API Edge window. Complete the verification there, then retry.");
                }
                throw new Error(`Could not load ChatGPT within 25 seconds (url=${currentUrl}, title=${title}). Check the Edge window/network and retry.`);
            }
        }
        // goto(domcontentloaded) above has already waited for the initial document.
        // Do not wait for another load-state here: Cloudflare interstitials can keep
        // the page in a navigation state and make the request look permanently hung.
        let currentUrl = page.url();
        console.log(`[ChatGPT Browser] Checking initial URL before waiting for page state; url=${currentUrl}`);
        const inspectPage = async () => {
            const url = page.url();
            const challengePath = /\/cdn-cgi\/|challenge-platform/i.test(new URL(url).pathname);
            const title = await page.title().catch(() => "");
            const pageState = await page.evaluate(() => ({
                bodyText: (document.body?.innerText || "").slice(0, 1000),
                readyState: document.readyState,
                hasComposer: Boolean(document.querySelector('#prompt-textarea, textarea[placeholder], [contenteditable="true"], [role="textbox"]')),
            })).then(state => ({ ...state, inspectionFailed: false }))
                .catch(error => ({
                    bodyText: "",
                    readyState: "unknown",
                    hasComposer: false,
                    inspectionFailed: true,
                    inspectionError: String(error),
                }));
            // A destroyed execution context usually means Cloudflare is navigating.
            // Never treat that transient inspection failure as a cleared challenge.
            const challenge = challengePath
                || pageState.inspectionFailed
                || (!pageState.bodyText.trim() && !pageState.hasComposer)
                || /just a moment|verify you are human|checking your browser|cloudflare|请稍候|正在检查您的浏览器|验证您是人类/i.test(title + " " + pageState.bodyText);
            return { url, title, pageState, challenge };
        };
        let inspected = await inspectPage();
        console.log(`[ChatGPT Browser] Page state inspected; url=${inspected.url}; title=${inspected.title}; readyState=${inspected.pageState.readyState}; bodyPreview=${JSON.stringify(inspected.pageState.bodyText.slice(0, 300))}`);
        if (inspected.challenge) {
            console.warn("[ChatGPT Browser] Cloudflare challenge detected; waiting up to 90 seconds for the browser page to clear. If a verification prompt appears, complete it in the Edge window.");
            const deadline = Date.now() + 90000;
            let lastProgress = 0;
            while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                inspected = await inspectPage();
                currentUrl = inspected.url;
                if (inspected.pageState.hasComposer && !inspected.challenge) {
                    console.log(`[ChatGPT Browser] ChatGPT composer is available after verification; url=${inspected.url}; title=${inspected.title}; readyState=${inspected.pageState.readyState}`);
                    break;
                }
                const elapsed = Math.floor((Date.now() - (deadline - 90000)) / 1000);
                if (elapsed - lastProgress >= 10) {
                    lastProgress = elapsed;
                    const status = inspected.challenge ? "Cloudflare challenge/navigation" : "ChatGPT page loading";
                    console.log(`[ChatGPT Browser] Still waiting for ${status} (${elapsed}/90s); url=${inspected.url}; title=${inspected.title}; bodyChars=${inspected.pageState.bodyText.length}; composer=${inspected.pageState.hasComposer}; inspectionFailed=${inspected.pageState.inspectionFailed}`);
                }
            }
            if (!inspected.pageState.hasComposer || inspected.challenge) {
                throw new Error("ChatGPT did not expose a usable prompt composer within 90 seconds (title=" + inspected.title + ", bodyChars=" + inspected.pageState.bodyText.length + ", inspectionFailed=" + inspected.pageState.inspectionFailed + "). The page may still be navigating after Cloudflare verification. Check the WebAI2API Edge tab and retry once ChatGPT has fully loaded.");
            }
        }
        const loginRequired = await page.locator('input[name="email"], input[type="password"]').count().catch(() => 0);
        if (loginRequired || /\/auth\/login|\/log-in/.test(currentUrl)) {
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
            },
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
        signal?.throwIfAborted();
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
        console.log(`[ChatGPT Browser] Starting response ${responseId}; thread=${threadId}; input=${Array.isArray(request.input) ? request.input.length : 0}`);
        const outputItemId = id("msg");
        const tools = request.tool_choice === "none"
            ? []
            : Array.isArray(request.tools) ? request.tools.filter((t: any) => t && (t.type === "function" || t.name)) : [];
        const input = Array.isArray(request.input) ? request.input : [];
        const inputSignatures = input.map(item => JSON.stringify(item) ?? String(item));
        const sessionKey = threadId || this.defaultThread;
        const previousInput = this.inputSnapshots.get(sessionKey);
        let incrementalInput = input;
        if (previousInput?.length) {
            let commonPrefix = 0;
            while (commonPrefix < previousInput.length
                && commonPrefix < inputSignatures.length
                && previousInput[commonPrefix] === inputSignatures[commonPrefix]) {
                commonPrefix += 1;
            }
            if (commonPrefix > 0) {
                incrementalInput = input.slice(commonPrefix);
            } else {
                const lastKnown = previousInput[previousInput.length - 1];
                const lastKnownIndex = inputSignatures.lastIndexOf(lastKnown);
                if (lastKnownIndex >= 0) incrementalInput = input.slice(lastKnownIndex + 1);
            }
        }
        // The browser already retains earlier turns. Send only the newly appended
        // Responses input when the caller supplies full history, to avoid replaying
        // the original user prompt after a function_call_output.
        let prompt = inputToPrompt(incrementalInput.length ? incrementalInput : input);
        const instructions = typeof request.instructions === "string" ? request.instructions : "";
        if (tools.length) {
            const choice = request.tool_choice;
            const forcedName = choice && typeof choice === "object"
                ? String((choice as Record<string, unknown>).name
                    ?? ((choice as Record<string, unknown>).function as Record<string, unknown> | undefined)?.name
                    ?? "")
                : "";
            const mustCallTool = choice === "required" || Boolean(forcedName);
            prompt += `

IMPORTANT TOOL-CALL PROTOCOL:
The caller has these tools:
${JSON.stringify(tools)}
${mustCallTool ? `A tool call is required${forcedName ? ` and you must call "${forcedName}"` : ""}. Do not answer in natural language instead.` : "If you need to call one, do not claim to execute it."}
Reply with ONLY a JSON object in this exact shape:
{"tool_call":{"name":"EXACT_TOOL_NAME","arguments":{}}}
Use the tool's declared JSON schema. Do not wrap it in markdown.
${mustCallTool ? "You must return a tool_call now." : "If no tool is needed, reply normally. Do not produce a tool_call unless calling a listed tool."}`;
        }
        const fullPrompt = [instructions, prompt].filter(Boolean).join("\n\n");
        console.log(`[ChatGPT Browser] Opening/reusing browser tab for thread ${threadId}; promptChars=${fullPrompt.length}`);
        const page = await this.pageFor(threadId);
        console.log(`[ChatGPT Browser] ChatGPT page ready: ${page.url()}`);
        signal?.throwIfAborted();
        const stopOnAbort = () => {
            void page.locator('button[data-testid="stop-button"], button[aria-label*="Stop generating"]').last()
                .click({ timeout: 1500 }).catch(() => undefined);
        };
        signal?.addEventListener("abort", stopOnAbort, { once: true });

        const messageSelector = 'main [data-message-author-role="assistant"]';
        const before = await page.locator(messageSelector).count().catch(() => 0);
        // ChatGPT has used several editor DOMs, including a ProseMirror textbox with
        // a localized aria-label (e.g. "询问 ChatGPT"). Include these selectors rather
        // than waiting forever on the older #prompt-textarea/data-placeholder DOM.
        // Apply :visible to EACH selector before combining them. Applying .last()
        // to an unfiltered selector list can select a hidden legacy textarea that
        // appears later in the DOM than ChatGPT's real contenteditable composer.
        const editor = page.locator(
            '#prompt-textarea:visible, textarea[placeholder]:visible, ' +
            '[contenteditable="true"][data-placeholder]:visible, ' +
            '[contenteditable="true"][aria-label]:visible, ' +
            'div.ProseMirror[contenteditable="true"]:visible, ' +
            '[role="textbox"][contenteditable="true"]:visible'
        ).last();
        console.log("[ChatGPT Browser] Locating visible prompt editor.");
        // Cloudflare can render its localized "请稍候…" interstitial after the
        // initial document inspection. Keep checking for up to 60 seconds so a
        // user can complete any visible verification in the Edge window, rather
        // than failing after the old 12-second editor-only wait.
        const editorDeadline = Date.now() + 60000;
        let editorFound = false;
        let challengeNoticeLogged = false;
        while (Date.now() < editorDeadline) {
            try {
                await editor.waitFor({ state: "visible", timeout: 2000 });
                editorFound = true;
                break;
            } catch {
                const state = await page.evaluate(() => ({
                    title: document.title || "",
                    bodyText: (document.body?.innerText || "").slice(0, 500),
                    url: location.href,
                })).catch(() => ({ title: "", bodyText: "", url: page.url() }));
                if (/just a moment|verify you are human|checking your browser|cloudflare|请稍候|正在检查您的浏览器|验证您是人类/i.test(state.title + " " + state.bodyText)) {
                    if (!challengeNoticeLogged) {
                        console.warn("[ChatGPT Browser] Cloudflare verification/wait page detected. Complete it in the opened Edge tab; waiting up to 60 seconds for the prompt editor.");
                        challengeNoticeLogged = true;
                    }
                } else if (challengeNoticeLogged) {
                    console.log("[ChatGPT Browser] Verification page no longer detected; continuing to wait for the prompt editor.");
                    challengeNoticeLogged = false;
                }
            }
        }
        if (!editorFound) {
            const diagnostics = await page.evaluate(() => {
                const selectors = [
                    '#prompt-textarea', 'textarea[placeholder]',
                    '[contenteditable="true"][data-placeholder]',
                    '[contenteditable="true"][aria-label]',
                    'div.ProseMirror[contenteditable="true"]',
                    '[role="textbox"][contenteditable="true"]',
                ];
                return {
                    url: location.href,
                    title: document.title,
                    readyState: document.readyState,
                    bodyText: (document.body?.innerText || "").slice(0, 1200),
                    candidates: selectors.map(selector => ({
                        selector,
                        count: document.querySelectorAll(selector).length,
                        visible: [...document.querySelectorAll(selector)].filter(el => {
                            const rect = el.getBoundingClientRect();
                            const style = getComputedStyle(el);
                            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
                        }).length,
                    })),
                };
            }).catch(() => ({ url: page.url(), title: "(diagnostics unavailable)" }));
            console.error(`[ChatGPT Browser] Prompt editor not found within 60 seconds; diagnostics=${JSON.stringify(diagnostics)}`);
            if (/just a moment|verify you are human|checking your browser|cloudflare|请稍候|正在检查您的浏览器|验证您是人类/i.test(String((diagnostics as any).title || "") + " " + String((diagnostics as any).bodyText || ""))) {
                throw new Error("ChatGPT is still showing a Cloudflare verification/wait page. Complete the verification in the opened Edge tab, then retry.");
            }
            throw new Error(`Could not find a visible ChatGPT prompt editor after 60 seconds. Check that ChatGPT finished loading and is logged in. Page: ${page.url()}`);
        }
        const editorInfo = await editor.evaluate(element => ({
            tag: element.tagName,
            role: element.getAttribute("role"),
            ariaLabel: element.getAttribute("aria-label"),
            placeholder: element.getAttribute("placeholder"),
        })).catch(() => null);
        console.log(`[ChatGPT Browser] Prompt editor found; metadata=${JSON.stringify(editorInfo)}; chars=${fullPrompt.length}. Filling editor in 8000-character chunks.`);
        // A single fill() with a ~100k-character Codex prompt can stall the ChatGPT
        // composer. Clear it first, then insert bounded chunks so progress is observable.
        await editor.fill("", { timeout: 15000 });
        await editor.click({ timeout: 10000 });
        const chunkSize = 8000;
        for (let offset = 0; offset < fullPrompt.length; offset += chunkSize) {
            signal?.throwIfAborted();
            const chunk = fullPrompt.slice(offset, offset + chunkSize);
            console.log(`[ChatGPT Browser] Inserting prompt chunk ${Math.floor(offset / chunkSize) + 1}/${Math.ceil(fullPrompt.length / chunkSize)}; chars=${Math.min(offset + chunkSize, fullPrompt.length)}/${fullPrompt.length}.`);
            await page.keyboard.insertText(chunk);
        }
        console.log("[ChatGPT Browser] Prompt entered; submitting to ChatGPT.");

        const sendButton = page.locator(
            'button[data-testid="send-button"], ' +
            'button[aria-label*="Send prompt" i], button[aria-label="Send" i], ' +
            'button[aria-label*="发送" i]'
        ).last();
        if (await sendButton.isVisible().catch(() => false)) {
            await sendButton.click();
        } else {
            // Fallback for localized/changed ChatGPT buttons.
            await editor.press("Enter");
        }
        console.log("[ChatGPT Browser] Prompt submitted; waiting for assistant response.");

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
        console.log(`[ChatGPT Browser] Assistant response captured; chars=${previous.length}`);
        if (Date.now() >= deadline) throw new Error("Timed out waiting for ChatGPT to finish generating a response.");

        const functionCall = tools.length ? extractFunctionCall(previous) : undefined;
        let output: Record<string, unknown>[];
        if (functionCall && tools.some((tool: any) => tool.name === functionCall.name || tool.function?.name === functionCall.name)) {
            const itemId = id("fc");
            const callId = id("call");
            const item = { id: itemId, call_id: callId, type: "function_call", name: functionCall.name, arguments: JSON.stringify(functionCall.arguments), status: "completed" };
            send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
            if (item.arguments) {
                send({ type: "response.function_call_arguments.delta", item_id: itemId, output_index: 0, delta: item.arguments });
                send({ type: "response.function_call_arguments.done", item_id: itemId, output_index: 0, arguments: item.arguments });
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
        this.inputSnapshots.set(sessionKey, inputSignatures);
        signal?.removeEventListener("abort", stopOnAbort);
        controller.close();
    }

    async close(): Promise<void> {
        // Do not close the user's browser. Only detach this CDP client.
        this.pages.clear();
        this.threadQueues.clear();
        this.inputSnapshots.clear();
        await this.browser?.close();
        this.browser = undefined;
        this.context = undefined;
    }
}
