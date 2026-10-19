import { Browser, Page, Route } from "playwright-core";
import { detectMimeType } from "./utils.js";
import type { ServerChatRequest } from "./deepseekWebClient.js";

interface QueuedTask<T> {
    runner: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

interface ChatCompletionResult {
    sessionId: string;
    body: string;
}

export class DeepSeekSessionError extends Error {
    readonly sessionId: string;
    constructor(message: string, sessionId: string) {
        super(message);
        this.name = 'DeepSeekSessionError';
        this.sessionId = sessionId;
    }
}

export class DeepSeekBrowserClient {
    verbose = true;  // 是否输出调试日志

    browser: Browser;
    page: Promise<Page>;
    private running = false;
    private queue: QueuedTask<unknown>[] = [];
    // 浏览器进程重启后，当前 URL 可能仍指向旧会话，但页面内部未必已经重新激活该 Session。
    // 第一次真正使用某个持久化 Session 时强制重新加载一次，模拟网页端点击历史会话后的激活。
    private activatedSessionId: string | null = null;
    constructor(
        browser: Browser
    ) {
        this.browser = browser;
        this.page = this.initPage();
    }

    private async initPage() {
        const context = this.browser.contexts()[0] || (await this.browser.newContext());  // 浏览器新账户
        const page = context.pages().find((p) => p.url().includes("deepseek.com")) ?? (await context.newPage());
        return page;
    }

    private createAbortError() {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        return error;
    }

    private withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
        if (!signal) return promise;
        if (signal.aborted) {
            void promise.catch(() => undefined);
            return Promise.reject(this.createAbortError());
        }
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(this.createAbortError());
            signal.addEventListener("abort", onAbort, { once: true });
            promise.then(
                (value) => {
                    signal.removeEventListener("abort", onAbort);
                    resolve(value);
                },
                (error) => {
                    signal.removeEventListener("abort", onAbort);
                    reject(error);
                },
            );
        });
    }

    private parseJsonSafely(text: string): Record<string, unknown> | null {
        if (!text) return null;
        try {
            const parsed = JSON.parse(text) as unknown;
            return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
        } catch {
            return null;
        }
    }

    // 任务队列管理
    private enqueueTask<T>(runner: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ runner, resolve, reject } as QueuedTask<unknown>);
            void this.dequeeue();
        });
    }

    async dequeeue() {
        if (this.running) return;
        this.running = true;
        while (this.queue.length > 0) {
            const queued = this.queue.shift();
            if (!queued) break;
            try {
                const value = await queued.runner();
                queued.resolve(value);
            } catch (error) {
                queued.reject(error);
            }
        }
        this.running = false;
    }

    // 跳转到对应的对话 若不存在则新建 新建会话拿不到sessionId
    private async _switchSession(sessionId: string = "", forceReload = false) {
        const page = await this.page;
        let url = 'https://chat.deepseek.com';
        if (sessionId?.length > 10) {
            url += `/a/chat/s/${sessionId}`;
        }

        // 已经在目标会话页面时不要重复 goto。重复导航会触发一次完整的
        // DeepSeek 页面加载，网络稍慢时容易在 30 秒后直接抛出 timeout。
        const currentUrl = page.url();
        const currentSessionId = currentUrl.split('/a/chat/s/')[1]?.split('?')[0] ?? '';
        const alreadyAtTarget = currentUrl.startsWith('https://chat.deepseek.com')
            && (sessionId.length > 10 ? currentSessionId === sessionId : currentSessionId.length === 0);

        if (!alreadyAtTarget || forceReload) {
            try {
                if (forceReload && alreadyAtTarget) {
                    await page.reload({ waitUntil: 'commit', timeout: 60000 });
                } else {
                    // 先等到导航提交即可，不要求整个页面在 goto 阶段完成加载。
                    await page.goto(url, { waitUntil: "commit", timeout: 60000 });
                }
            } catch (error) {
                // DeepSeek 页面经常还有长连接/慢资源。commit 已成功但后续 load
                // 超时并不代表页面不可用，因此只有真正无法导航时才继续抛错。
                if (this.verbose) {
                    console.warn('[DeepSeekBrowserClient] DeepSeek navigation warning:', error);
                }
                if (!page.url().startsWith('https://chat.deepseek.com')) {
                    throw error;
                }
            }
        }

        // 不再用固定 300ms 猜页面什么时候准备好，交给 textInput 等待真实 textarea。
        // 如果 DOMContentLoaded 尚未完成也不要阻塞请求。
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);

        const finalUrl = page.url();
        return finalUrl.split('/a/chat/s/')[1]?.split('?')[0] ?? '';
    }

    async switchSession(sessionId: string = "") {
        return this.enqueueTask<string>(() => this._switchSession(sessionId));
    }

    /**
     * 激活一个已经存在的 DeepSeek 会话。
     *
     * DeepSeek 网页端重启后，历史会话仍然存在，但当前页面不一定已经把它
     * 重新加载为 active session；用户在左侧点击历史会话时，本质上就是重新
     * 进入该 session 页面。这里对每个 session 在当前浏览器生命周期第一次使用
     * 时做一次强制 reload，避免把“持久化 sessionId”误当成“当前页面已激活”。
     */
    private async _activateSession(sessionId: string, signal?: AbortSignal): Promise<void> {
        const normalized = sessionId.trim();
        if (!normalized) return;
        if (this.activatedSessionId === normalized) return;

        await this.withAbort(this._switchSession(normalized, true), signal);
        this.activatedSessionId = normalized;
        if (this.verbose) {
            console.log(`[DeepSeekBrowserClient] Activated persisted session=${normalized}`);
        }
    }

    // 发送按钮
    private async send(): Promise<boolean> {
        const page = await this.page;
        try {
            // 依赖input进行定位
            const target = page.locator('input[type="file"][multiple] + *').first();
            if (!await target.count()) {
                // 如果找不到启用的按钮，尝试按回车作为兜底
                await page.keyboard.press('Enter');
                return true;
            }
            await target.scrollIntoViewIfNeeded();
            await target.click();
        } catch {
            return false;
        } return true;
    }

    // 输入消息
    private async textInput(text: string): Promise<boolean> {
        const page = await this.page;
        const selector = 'textarea[name="search"][autocomplete="off"]';
        // HTMLTextAreaElement 会把 CRLF/CR 规范化成 LF，不能直接用原字符串比较。
        const normalizedText = text.replace(/\r\n?/g, "\n");

        try {
            const input = page.locator(selector).first();
            await input.waitFor({ state: 'visible', timeout: 30000 });
            await input.scrollIntoViewIfNeeded();
            await input.click();

            // DeepSeek 的 textarea 是 React 受控组件。Codex 上下文变大后，消息可能达到数十万字符，
            // Playwright fill() 会在清空/写入这个超大 textarea 时长时间卡住并最终触发 30 秒超时。
            // 大消息直接使用 textarea 原生 value setter + input/change 事件，只触发一次前端状态同步。
            // 小消息继续走原来的 Playwright fill() 路径，保持原有行为。
            let actual = await input.inputValue();
            if (text.length >= 32768) {
                const directResult = await page.evaluate(({ selector, text, normalizedText }) => {
                    const element = document.querySelector(selector);
                    if (!(element instanceof HTMLTextAreaElement)) {
                        return { ok: false, reason: 'textarea not found' };
                    }
                    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                    if (!setter) {
                        return { ok: false, reason: 'textarea value setter not found' };
                    }

                    element.focus();
                    setter.call(element, text);
                    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

                    const value = element.value;
                    return {
                        ok: value.replace(/\r\n?/g, "\n") === normalizedText,
                        valueLength: value.length,
                        expectedLength: normalizedText.length,
                    };
                }, { selector, text, normalizedText });

                if (directResult.ok) {
                    return true;
                }

                if (this.verbose) {
                    console.warn('[DeepSeekBrowserClient] Direct textarea input failed; falling back to Playwright fill.', directResult);
                }
            } else {
                await input.fill(text);
                actual = await input.inputValue();
                if (actual.replace(/\r\n?/g, "\n") === normalizedText) {
                    return true;
                }
            }

            // 如果 DeepSeek 前端把 fill 后的值重新同步回去，使用浏览器键盘事件再次输入。
            await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
            await page.keyboard.press('Backspace');
            await page.keyboard.insertText(text);
            actual = await input.inputValue();
            if (actual.replace(/\r\n?/g, "\n") === normalizedText) {
                return true;
            }

            // 最后使用原生 setter，并用规范化后的 value 判断成功与否。
            const result = await page.evaluate(({ selector, text, normalizedText }) => {
                const element = document.querySelector(selector);
                if (!(element instanceof HTMLTextAreaElement)) {
                    return { ok: false, reason: 'textarea not found' };
                }
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                if (!setter) {
                    return { ok: false, reason: 'textarea value setter not found' };
                }

                element.focus();
                setter.call(element, text);
                element.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    composed: true,
                    inputType: 'insertText',
                    data: text,
                }));
                element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

                const actual = element.value;
                const normalizedActual = actual.replace(/\r\n?/g, "\n");
                return {
                    ok: normalizedActual === normalizedText,
                    valueLength: actual.length,
                    expectedLength: normalizedText.length,
                };
            }, { selector, text, normalizedText });

            if (result.ok) {
                return true;
            }

            if (this.verbose) {
                console.error('[DeepSeekBrowserClient] Message input failed.', {
                    expectedLength: normalizedText.length,
                    actualLength: actual.length,
                    result,
                });
            }
            return false;
        } catch (error) {
            if (this.verbose) {
                const diagnostics = await page.evaluate<{
                    url: string;
                    title: string;
                    readyState: string;
                    textareaCount: number;
                    targetCount: number;
                    target: string | null;
                }, string>((selector) => ({
                    url: location.href,
                    title: document.title,
                    readyState: document.readyState,
                    textareaCount: document.querySelectorAll('textarea').length,
                    targetCount: document.querySelectorAll(selector).length,
                    target: document.querySelector(selector)?.outerHTML ?? null,
                }), selector).catch(() => null);
                console.error('[DeepSeekBrowserClient] Failed to input message.', { error, diagnostics });
            }
            return false;
        }
    }

    private async _uploadFile(
        fileData: Buffer, fileName: string,
        modelType: ServerChatRequest["modelType"] = "default"
    ): Promise<string> {
        if (this.verbose) console.log(`[DeepSeekBrowserClient] Starting file upload for ${fileName}`);
        const page = await this.page;
        // 如果当前页面不是deepseek则先跳转
        if (!page.url().includes("deepseek.com")) {
            await page.goto('https://chat.deepseek.com');
        }
        let fileId: string | null = null;
        let upload_status: string | undefined = undefined;

        // 监听上传响应获取 fileId
        const uploadHandler = (response: { url: () => string; ok: () => boolean; json: () => Promise<unknown> }) => {
            if (!response.url().includes("/api/v0/file/upload_file")) return;
            if (!response.ok()) return;
            response.json().then((data: unknown) => {
                const parsed = data as { data?: { biz_data?: { id?: string, file_name?: string, status?: string } } };
                if (parsed.data?.biz_data?.file_name !== fileName) {
                    return; // 文件名不匹配，可能不是目标响应
                }
                fileId = parsed.data?.biz_data?.id ?? null;
                upload_status = parsed.data?.biz_data?.status;
                page.off("response", uploadHandler);
            }).catch(() => {
                // 忽略解析错误
            });
        };

        page.on("response", uploadHandler);

        try {
            // 触发上传
            await page.setInputFiles('input[type="file"][multiple]', {
                name: fileName,
                buffer: fileData,
                mimeType: detectMimeType(fileData, fileName),
            });

            // 等待获取 fileId
            let attempts = 0;
            while (!fileId && attempts < 30) {
                await new Promise((r) => setTimeout(r, 200));
                attempts++;
            }
            page.off("response", uploadHandler);
            if (!fileId) throw new Error("Failed to get fileId from upload response");
            if (upload_status === "SUCCESS") return fileId;
            if (upload_status === "FAILED") throw new Error(`File upload failed for ${fileName} with fileId ${fileId}`);
            if (upload_status === "CONTENT_EMPTY") throw new Error(`File upload failed due to empty content for ${fileName} with fileId ${fileId}`);

            // 监听 fetch_files 响应直到文件处理完成
            const { promise, resolve, reject } = Promise.withResolvers<void>();
            const fetchFilesHandler = (response: { url: () => string; ok: () => boolean; json: () => Promise<unknown> }) => {
                const url = response.url();
                if (!url.includes("fetch_files") || !url.includes(fileId!)) return;
                if (!response.ok()) return;
                response.json().then((data: unknown) => {
                    const parsed = data as { data?: { biz_data?: { files?: Array<{ id: string; status: string }> } } };
                    for (const file of parsed.data?.biz_data?.files ?? []) {
                        if (file.id !== fileId) continue;
                        if (file.status === "PARSING") continue;
                        if (file.status === "SUCCESS") {
                            resolve();
                            return;
                        }
                        if (file.status === "FAILED") {
                            reject(new Error(`File processing failed for ${fileName} with fileId ${fileId}`));
                            return;
                        }
                        if (file?.status === "CONTENT_EMPTY") {
                            reject(new Error(`File processing failed due to empty content for ${fileName} with fileId ${fileId}`));
                            return;
                        }
                    }
                }).catch(() => {
                    // 忽略解析错误
                });
            };
            page.on("response", fetchFilesHandler);

            try {
                // 等待文件处理完成，超时为60秒
                await Promise.race([
                    promise,
                    new Promise<void>((_, reject) =>
                        setTimeout(() => reject(new Error(`File upload polling timed out for ${fileId}`)), 60000)
                    )
                ]);
                return fileId;
            } catch (error) {
                // 失败则取消上传的文件 其实没必要因为每次对话都会刷新页面 文件是可以跨对话的
                await page.evaluate(() => {
                    const container = document.querySelector('._75e1990');
                    if (!container) window.location.reload(); // 无法找到删除按钮，刷新页面重试
                    // 删除最后一个 由于本函数只上传一个 所以删除最后一个就是刚上传的那个
                    (container!.children[container!.childElementCount - 1]?.querySelector('.ds-icon') as HTMLElement)?.click();
                });
                throw error;
            } finally {
                page.off("response", fetchFilesHandler);
            }
        } finally {
            page.off("response", uploadHandler);
        }
    }

    async uploadFile(
        fileData: Buffer, fileName: string,
        modelType: ServerChatRequest["modelType"] = "default"
    ): Promise<string> {
        return this.enqueueTask<string>(() => this._uploadFile(fileData, fileName, modelType));
    }

    // 删除会话
    private async _deleteSession(sessionId: string): Promise<boolean | null> {
        if (this.verbose) console.log(`[DeepSeekBrowserClient] Deleting session: ${sessionId}`);
        const page = await this.page;

        // 监听请求，判断是否删除成功
        const { promise, resolve, reject } = Promise.withResolvers<boolean>();
        const onResponse = (response: { url: () => string; request: () => { method: () => string; }; ok: () => boolean; }) => {
            if (!response.url().includes("/api/v0/chat_session/delete")) return;
            page.off("response", onResponse);
            resolve(response.ok());
        };
        page.on("response", onResponse);

        let result = await page.evaluate(async (id: string) => {
            // 1. 打开菜单
            const target = document.querySelector(`[href="/a/chat/s/${id}"]`)
                ?.lastElementChild
                ?.querySelector('[aria-disabled="false"]');
            if (!target) return null;

            (target as HTMLElement).click();
            await new Promise(r => setTimeout(r, 300));

            // 2. 点击删除选项
            let found = false;
            const deleteOptions = document.querySelectorAll('.ds-dropdown-menu-option__label');
            for (let i = 0; i < deleteOptions.length; i += 1) {
                const option = deleteOptions[i];
                if (option.textContent?.includes('删除')) {
                    (option as HTMLElement).click();
                    found = true;
                    await new Promise(r => setTimeout(r, 300));
                    break;
                }
            }
            if (!found) return false;

            // 3. 定位并点击删除确认按钮
            const confirmDeleteBtn = document.querySelector('button[role="button"][aria-disabled="false"].ds-basic-button--danger');
            if (!confirmDeleteBtn) return false;
            (confirmDeleteBtn as HTMLElement).click();
            return true;
        }, sessionId);

        if (!result) {
            page.off("response", onResponse);
            return result;
        }

        const t = setTimeout(() => reject(false), 3000);
        try {
            return await promise;
        } catch {
            return false;
        } finally {
            clearTimeout(t);
            page.off("response", onResponse);
        }
    }

    async deleteSession(sessionId: string): Promise<boolean | null> {
        return this.enqueueTask<boolean | null>(() => this._deleteSession(sessionId));
    }

    async continueChat(params: { sessionId: string; messageId: number; signal?: AbortSignal }): Promise<string> {
        return this.enqueueTask(async () => {
            params.signal?.throwIfAborted();
            await this.withAbort(this._switchSession(params.sessionId), params.signal);
            return this._continueChat(params);
        });
    }

    private async _continueChat(params: { sessionId: string; messageId: number; signal?: AbortSignal }): Promise<string> {
        const page = await this.page;
        params.signal?.throwIfAborted();
        const responsePromise = page.waitForResponse(response => {
            if (new URL(response.url()).pathname !== '/api/v0/chat/continue') return false;
            const payload = this.parseJsonSafely(response.request().postData() ?? '{}');
            return payload?.chat_session_id === params.sessionId && payload?.message_id === params.messageId;
        });
        const pendingBody = responsePromise.then(response => response.text());
        void pendingBody.catch(() => undefined);
        let generating = true;
        try {
            await this.withAbort(page.getByRole('button', { name: '继续生成', exact: true }).last().click(), params.signal);
            const response = await this.withAbort(responsePromise, params.signal);
            const body = await this.withAbort(pendingBody, params.signal);
            generating = false;
            if (!response.ok()) {
                throw new Error(`Chat continue failed: ${response.status()} ${body}`);
            }
            const contentType = response.headers()['content-type'] ?? '';
            if (!contentType.includes('text/event-stream')) {
                throw new Error(`Unexpected content type[${contentType}] for chat continue response: ${body}`);
            }
            return body;
        } catch (error) {
            if (params.signal?.aborted && generating) {
                // 内部终止就算报错也不管
                await this._stopChat({ sessionId: params.sessionId }).catch(() => undefined);
                await pendingBody;
            }
            throw error;
        }
    }

    async stopChat(params: { sessionId: string }): Promise<void> {
        return this.enqueueTask(async () => {
            await this._switchSession(params.sessionId);
            await this._stopChat(params);
        });
    }

    private async _stopChat(params: { sessionId: string }): Promise<void> {
        const page = await this.page;
        const responsePromise = page.waitForResponse(response => {
            if (new URL(response.url()).pathname !== '/api/v0/chat/stop_stream') return false;
            const payload = this.parseJsonSafely(response.request().postData() ?? '{}');
            return payload?.chat_session_id === params.sessionId;
        });
        void responsePromise.catch(() => undefined);
        await page.locator('[role="button"]:has(svg path[d^="M2 4.88C2 3.68009"])').click();
        const response = await responsePromise;
        if (!response.ok()) throw new Error(`Chat stop failed: ${response.status()} ${await response.text()}`);
    }

    private extractChatSessionId(payload: unknown): string {
        if (!payload || typeof payload !== 'object') return '';
        const data = payload as Record<string, any>;
        const id = data?.data?.biz_data?.chat_session?.id
            ?? data?.data?.biz_data?.id
            ?? data?.data?.id
            ?? data?.biz_data?.chat_session?.id
            ?? data?.biz_data?.id;
        return typeof id === 'string' ? id.trim() : '';
    }

    /**
     * DeepSeek 网页打开新对话时，会提前调用 chat_session/create。
     * 必须在导航前挂 response 监听，把网页自己创建的“待命会话”拿下来；
     * 不能自己再调用一次 create，否则网页端会多出一个空会话。
     */
    private async _createSessionFromPage(signal?: AbortSignal): Promise<string> {
        const page = await this.page;
        signal?.throwIfAborted();

        let capturedSessionId = '';
        const responseHandler = async (response: {
            url: () => string;
            ok: () => boolean;
            text: () => Promise<string>;
        }) => {
            try {
                if (new URL(response.url()).pathname !== '/api/v0/chat_session/create' || !response.ok()) return;
                const text = await response.text();
                const id = this.extractChatSessionId(JSON.parse(text));
                if (id) {
                    capturedSessionId = id;
                    if (this.verbose) {
                        console.log(`[DeepSeekBrowserClient] Captured pre-created session=${id}`);
                    }
                }
            } catch {
                // 忽略非目标/非JSON响应，继续等待网页创建会话。
            }
        };

        page.on('response', responseHandler);
        try {
            // 强制回到首页，确保本次“待命会话”的 create 请求发生在监听器之后。
            try {
                await page.goto('https://chat.deepseek.com', { waitUntil: 'commit', timeout: 60000 });
            } catch (error) {
                if (!page.url().startsWith('https://chat.deepseek.com')) throw error;
                if (this.verbose) console.warn('[DeepSeekBrowserClient] DeepSeek new-session navigation warning:', error);
            }

            for (let i = 0; i < 100 && !capturedSessionId; i += 1) {
                signal?.throwIfAborted();
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            if (capturedSessionId) return capturedSessionId;

            // 页面 create 可能只是比等待窗口稍晚返回。兜底前再给一小段宽限期，
            // 避免“页面已经创建、我们又主动 create 一次”造成双建会话。
            for (let i = 0; i < 30 && !capturedSessionId; i += 1) {
                signal?.throwIfAborted();
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (capturedSessionId) return capturedSessionId;

            // 极少数情况下页面复用已有文档而没有重新触发 create。
            // 此时才允许最后兜底主动创建一次，避免再次出现“没有 sessionId”。
            // 兜底 create 与页面 create 可能并发：以先拿到 ID 的一方为准，
            // 若页面在兜底期间抢先生成，则丢弃兜底结果，避免留下空会话。
            const sessionId = await this.withAbort(page.evaluate(async () => {
                const response = await fetch('/api/v0/chat_session/create', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    credentials: 'include',
                    body: '{}',
                });
                const text = await response.text();
                if (!response.ok) {
                    throw new Error(`DeepSeek create session failed: ${response.status} ${text}`);
                }
                let payload: any;
                try {
                    payload = JSON.parse(text);
                } catch {
                    throw new Error(`DeepSeek create session returned invalid JSON: ${text}`);
                }
                const id = payload?.data?.biz_data?.chat_session?.id
                    ?? payload?.data?.biz_data?.id
                    ?? payload?.data?.id
                    ?? payload?.biz_data?.chat_session?.id
                    ?? payload?.biz_data?.id;
                if (typeof id !== 'string' || !id.trim()) {
                    throw new Error(`DeepSeek create session returned no sessionId: ${text}`);
                }
                return id.trim();
            }), signal);

            // 兜底 create 期间，页面自身的 create 也可能返回。
            // 若页面先拿到 ID，则优先用页面的，避免双建。
            if (capturedSessionId) {
                if (this.verbose) console.log(`[DeepSeekBrowserClient] Page session won over fallback: ${capturedSessionId}`);
                return capturedSessionId;
            }
            if (this.verbose) console.log(`[DeepSeekBrowserClient] Created fallback session=${sessionId}`);
            return sessionId;
        } finally {
            page.off('response', responseHandler);
        }
    }

    async chatCompletions(params: ServerChatRequest) {
        return this.enqueueTask<ChatCompletionResult>(async () => {
            params.signal?.throwIfAborted();
            if (this.verbose) console.log(`[DeepSeekBrowserClient] Starting chat completion.`);

            // Codex 首次 user turn 没有 DeepSeek sessionId。
            // 不再依赖 DeepSeek 页面“预创建”的空会话，也不再从 completion 请求里猜 sessionId。
            // 直接通过当前登录浏览器创建一个真实会话，然后整个 Codex thread 一直复用它。
            const requestedSessionId = params.sessionId?.trim() ?? '';
            const capturedSessionId = requestedSessionId || await this._createSessionFromPage(params.signal);
            if (requestedSessionId) {
                // Registry 中恢复出来的 session 必须先真正激活，再发送消息。
                // 这对应 DeepSeek 网页端“点击左侧历史会话后继续聊天”的行为。
                await this._activateSession(capturedSessionId, params.signal);
            } else {
                await this.withAbort(this._switchSession(capturedSessionId), params.signal);
                this.activatedSessionId = capturedSessionId;
            }

            const page = await this.page;
            // 监听请求，强制把我们已经确定的 sessionId 写进 DeepSeek completion 请求。
            const routePattern = "**/api/v0/chat/completion";
            if (!capturedSessionId.trim()) {
                throw new Error("DeepSeek sessionId is empty after session creation");
            }

            // DeepSeek 偶尔会直接返回“消息发送过于频繁”或
            // “parallel_chat_limit_by_queue”。这种情况通常没有真正生成回复，
            // 可以安全地等待后重试当前消息，而不是立即把 500 返回给 Codex。
            const retryDelays = [0, 3000, 6000, 12000];
            let lastFrequencyLimitBody = "";

            for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
                params.signal?.throwIfAborted();
                if (retryDelays[attempt] > 0) {
                    console.warn(
                        `[DeepSeekBrowserClient] DeepSeek rate limited, retrying in ${retryDelays[attempt]}ms ` +
                        `(attempt ${attempt + 1}/${retryDelays.length})`
                    );
                    await this.withAbort(new Promise<void>(resolve => setTimeout(resolve, retryDelays[attempt])), params.signal);
                }

                let generating = false;
                let pendingBody: Promise<string> | undefined;
                const routeHandler = async (route: Route) => {
                    const request = route.request();
                    const payload = this.parseJsonSafely(request.postData() ?? "{}") ?? {};
                    // 检查prompt是否和要求的一致，来判断是否为目标请求
                    if (!payload.prompt || (payload.prompt as string).trimStart()[0] !== params.message.trimStart()[0]) return;
                    payload.chat_session_id = capturedSessionId;
                    payload.model_type = params.modelType ?? "default";
                    if (params.fileIds !== undefined) payload.ref_file_ids = params.fileIds;
                    if (params.searchEnabled !== undefined) payload.search_enabled = params.searchEnabled;
                    if (params.thinkingEnabled !== undefined) payload.thinking_enabled = params.thinkingEnabled;
                    if (params.parentMessageId !== undefined) payload.parent_message_id = params.parentMessageId;
                    if (params.preempt !== undefined) payload.preempt = params.preempt;
                    await route.continue({ postData: JSON.stringify(payload) });
                    await page.unroute(routePattern, routeHandler);
                };

                try {
                    await page.route(routePattern, routeHandler);
                    let inputOk = await this.withAbort(this.textInput(params.message), params.signal);
                    if (!inputOk) {
                        console.warn(
                            `[DeepSeekBrowserClient] DeepSeek textbox input failed; reloading current session page and retrying.` +
                            ` session=${capturedSessionId}`
                        );
                        await this.withAbort(this._switchSession(capturedSessionId, true), params.signal);
                        inputOk = await this.withAbort(this.textInput(params.message), params.signal);
                    }
                    if (!inputOk) throw new Error("Failed to input message into DeepSeek textbox.");
                    params.signal?.throwIfAborted();

                    const responsePromise = page.waitForResponse((response) => {
                        if (!response.url().includes("/api/v0/chat/completion")) return false;
                        const postData = this.parseJsonSafely(response.request().postData() ?? "{}") ?? {};
                        return postData.chat_session_id === capturedSessionId;
                    });
                    pendingBody = responsePromise.then(response => response.text());
                    void pendingBody.catch(() => undefined);
                    generating = true;
                    console.log(
                        `[DeepSeekBrowserClient] sending /api/v0/chat/completion ` +
                        `session=${capturedSessionId} at=${new Date().toISOString()}`
                    );
                    const sent = await this.withAbort(this.send(), params.signal);
                    if (!sent) {
                        generating = false;
                        throw new Error("Failed to click DeepSeek send button.");
                    }

                    const response = await this.withAbort(responsePromise, params.signal);
                    const contentType = response.headers()["content-type"] ?? "";
                    const body = await this.withAbort(pendingBody, params.signal);
                    generating = false;
                    if (!contentType.includes("text/event-stream")) {
                        throw new Error(`Unexpected content type[${contentType}] for chat completion response: ${body}`);
                    }

                    const lowerBody = body.toLowerCase();
                    const isFrequencyLimit =
                        body.includes("消息发送过于频繁")
                        || body.includes("请求过于频繁")
                        || lowerBody.includes("parallel_chat_limit_by_queue")
                        || lowerBody.includes("too frequent");

                    if (isFrequencyLimit) {
                        lastFrequencyLimitBody = body;
                        if (attempt < retryDelays.length - 1) continue;
                        throw new Error("Deepseek API Error: 消息发送过于频繁，请稍后重试");
                    }

                    return {
                        sessionId: capturedSessionId,
                        body,
                    };
                } catch (error) {
                    if (params.signal?.aborted && generating) {
                        await this._stopChat({ sessionId: capturedSessionId }).catch(() => undefined);
                        if (pendingBody) await pendingBody.catch(() => undefined);
                    }
                    throw error;
                } finally {
                    await page.unroute(routePattern, routeHandler);
                }
            }

            throw new DeepSeekSessionError(
                lastFrequencyLimitBody || "Deepseek API Error: 消息发送过于频繁，请稍后重试",
                capturedSessionId,
            );
        });
    }
}
