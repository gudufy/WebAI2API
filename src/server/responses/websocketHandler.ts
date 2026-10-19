// https://developers.openai.com/api/docs/guides/websocket-mode

import { WebSocket } from "ws";
import {
    hasRunnableUserInput,
    type ResponsesCreateRequest,
    asResponsesCreateRequest,
} from "./responsesType.js";
import { parseResponseId } from "../responseId.js";
import { getModelConfig } from "../models.js";
import { shouldParseToolCall } from "../toolPrompt.js";
import type { ServerClient } from "../serverClient.js";
import { DeepSeekSessionError } from "../../deepseekBrowserClient.js";
import { READY_RESPONSE_ID } from "./responsesType.js";
import { streamEventsFromStream } from "./stream.js";
import { clearResponseSessionState, enqueueDeepSeekRequest, rememberResponseSessionMessageId, resolveQueuedParentMessageId } from "./sessionQueue.js";
import { clearResponseSessionTools, normalizeResponsesRequest, rememberResponseSessionTools } from "./responsesType.js";
import { getInstallationSessionId, getResponseSessionId, isResponseSessionShared, isSessionReferencedByAnyKey, rememberInstallationSession, rememberResponseSession } from "./responseSessionRegistry.js";

export interface WebSocketMessage {
    type: "response.create";
    data?: ResponsesCreateRequest;
    requestId?: string;
    event_id?: string;
    response?: ResponsesCreateRequest;
}

export interface WebSocketResponse {
    type: "response" | "error";
    requestId?: string;
    data?: unknown;
    error?: Record<string, unknown> | string;
    status?: number;
}

/**
 * 管理 WebSocket 连接状态。
 * WebSocket 连接不是 Codex 会话边界，真正的会话由 client_metadata.thread_id 关联。
 */
function parseCodexTurnMetadata(value: string | undefined): Record<string, string> | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const result: Record<string, string> = {};
        for (const [key, item] of Object.entries(parsed)) {
            if (typeof item === "string" && item.trim()) result[key] = item.trim();
        }
        return result;
    } catch {
        return null;
    }
}

export class WebSocketSessionManager {
    private readonly ws: WebSocket;
    private readonly client: ServerClient;
    private sessionId: string | null = null;    // 当前连接看到的 DeepSeek session
    private responseSessionKey: string | null = null; // Codex thread_id/session_id
    private readonly abortControllers = new Map<string, AbortController>();
    private readonly pendingRequests = new Set<Promise<void>>();
    // 管理instructions
    private instructions: string | undefined;   // 防止每次都发送
    private lastInstructionMessageId: number = -114514;
    private loggedClientMetadata = false;

    private getRequestEnvelope(message: WebSocketMessage): {
        request: ResponsesCreateRequest;
        codexProtocol: boolean;
    } | null {
        if (message.type === "response.create") {   // Codex 协议特有的请求类型
            const payload = asResponsesCreateRequest(message);
            return {
                request: payload,
                codexProtocol: true,    // 标记为 Codex 的请求
            };
        }
        return null;
    }

    private sendCodexFailed(message: string) {
        this.sendRaw({
            type: "response.failed",
            response: {
                status: "failed",
                error: {
                    type: "server_error",
                    code: "server_error",
                    message,
                }
            }
        });
    }

    constructor(ws: WebSocket, client: ServerClient) {
        this.ws = ws;
        this.client = client;

        ws.on("message", (data) => {
            const request = this.handleMessage(data);
            this.pendingRequests.add(request);
            void request.then(
                () => this.pendingRequests.delete(request),
                () => this.pendingRequests.delete(request),
            );
        });
        ws.on("close", (code, reason) => {
            this.cleanup().catch(error => { });
        }); // 连接断开的时机: archive该session或者关闭codex
        ws.on("error", (error) => this.handleError(error));
    }

    private async handleMessage(rawData: unknown) {
        try {
            // 解析payload
            let payloadText: string;
            if (typeof rawData === "string") {
                payloadText = rawData;
            } else if (rawData instanceof Buffer) {
                payloadText = rawData.toString("utf8");
            } else if (Array.isArray(rawData)) {
                payloadText = Buffer.concat(rawData).toString("utf8");
            } else if (rawData instanceof ArrayBuffer) {
                payloadText = Buffer.from(rawData).toString("utf8");
            } else {
                console.warn(`[WebSocket] Unsupported message payload type: ${typeof rawData}`);
                this.sendError("Invalid message format", 400);
                return;
            }
            const message: WebSocketMessage = JSON.parse(payloadText);
            const envelope = this.getRequestEnvelope(message);
            if (envelope) {
                await this.handleRequest(envelope.request, envelope.codexProtocol);
                return;
            }

            console.warn(`[WebSocket] Unknown message type: ${String(message.type)}`);
            this.sendError("Unknown message type", 400);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[WebSocket] Failed to parse/process incoming message: ${msg}`);
            this.sendError(`Failed to parse message: ${msg}`, 400);
        }
    }

    private async handleRequest(
        rawInput: ResponsesCreateRequest,
        codexProtocol = false,
    ) {
        const requestId = Date.now().toString();    // 用于AbortController的管理
        let installationId: string | undefined;
        try {
            // Codex 可能使用本适配器未声明的模型名。实际后端只有 DeepSeek，
            // 因此统一把“协议模型名”映射成 DeepSeek，同时保留请求原始模型仅用于日志。
            let modelConfig;
            let effectiveInput = rawInput;
            try {
                modelConfig = getModelConfig(rawInput.model);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!codexProtocol || !message.includes("Unsupported model:")) throw error;
                console.warn(`[WebSocket] Unsupported model in codex mode, fallback to deepseek: ${rawInput.model ?? "<missing>"}`);
                modelConfig = getModelConfig("deepseek");
                effectiveInput = { ...rawInput, model: "deepseek" };
            }

            // warmup, input是空的, 不请求直接返回空的
            if (!hasRunnableUserInput(rawInput.input)) {
                if (codexProtocol) {
                    this.sendRaw({
                        type: "response.created",
                        response: {}    // codex源码说可以为空
                    });  // 其实created可以不必要
                    this.sendRaw({
                        type: "response.completed",
                        response: {
                            id: READY_RESPONSE_ID
                        }   // 实测不传id也没事
                    });
                    // warmup 不创建 DeepSeek 会话；真正的对话在后续请求中按 thread_id 复用。
                    return;
                }
                const message = "input must include at least one non-empty user message or function_call_output.";
                this.sendError(message, 400);
                return;
            }

            // 去重 Instructions
            let _tmp = parseResponseId(rawInput.previous_response_id ?? '');
            const rawInputMessageId = _tmp.messageId ?? 0;
            if (rawInput.instructions === this.instructions && rawInputMessageId - this.lastInstructionMessageId < 30) {
                rawInput.instructions = undefined;
            } else {
                this.instructions = rawInput.instructions;
            }
            // Codex 的 WebSocket 连接不是会话边界。
            // 一个 UI 窗口内可能同时出现 title turn、composer turn 以及多个 WS，
            // 因此不能单独用 thread_id/root_turn_id 作为 DeepSeek 会话键。
            const metadata = effectiveInput.client_metadata;
            const turnMetadata = parseCodexTurnMetadata(metadata?.["x-codex-turn-metadata"]);
            installationId = metadata?.["x-codex-installation-id"]?.trim()
                ?? turnMetadata?.installation_id?.trim();
            const rootTurnId = metadata?.root_turn_id?.trim()
                ?? turnMetadata?.root_turn_id?.trim();
            const threadId = metadata?.thread_id?.trim()
                ?? turnMetadata?.thread_id?.trim();
            const metadataSessionId = metadata?.session_id?.trim()
                ?? turnMetadata?.session_id?.trim();

            const threadSource = turnMetadata?.thread_source?.trim() ?? "";
            const turnTrigger = turnMetadata?.turn_trigger?.trim() ?? "";

            // Codex 的 thread_title 是标题生成请求，不应该创建 DeepSeek 会话。
            // 否则一次用户提问会先因为标题请求创建一个 DeepSeek chat，随后真正的 user turn
            // 再创建第二个 chat，最终网页端就会看到多个会话。
            if (codexProtocol && (threadSource === "thread_title" || turnTrigger === "thread_title")) {
                console.log(
                    `[WebSocket] Skip DeepSeek for Codex thread_title ` +
                    `thread=${threadId ?? "<none>"} turn=${rootTurnId ?? "<none>"}`
                );
                this.sendRaw({ type: "response.created", response: {} });
                this.sendRaw({
                    type: "response.completed",
                    response: { id: READY_RESPONSE_ID }
                });
                return;
            }

            // 真正的用户 turn 以 thread_id 作为会话边界。window_id/root_turn_id 会在
            // 同一轮内部变化（例如 title/composer/retry），不能拿它们创建 DeepSeek 会话。
            // 会话键必须稳定：只有 installationId + threadId 才是规范键。
            // 缺 threadId 时不要退化成 `codex:${installationId}`，否则同一 thread 的不同 WS
            // （title/composer/重试）会算出不同键，registry 查不到旧 session 而各建一个 DeepSeek chat。
            // 此时优先用 threadId/metadataSessionId 兜底，再退到 installation 级共享键。
            const canonicalSessionKey = installationId && threadId
                ? `codex:${installationId}:thread:${threadId}`
                : null;
            const responseSessionKey = canonicalSessionKey
                ?? (threadId ? `codex:thread:${threadId}` : null)
                ?? (metadataSessionId ? `codex:session:${metadataSessionId}` : null)
                ?? (installationId ? `codex:${installationId}` : null);
            const installationSessionId = installationId ? getInstallationSessionId(installationId) : null;
            if (codexProtocol && !this.loggedClientMetadata) {
                this.loggedClientMetadata = true;
                console.log(
                    `[WebSocket] client_metadata=${JSON.stringify(metadata ?? {})} ` +
                    `thread_id=${threadId ?? "<none>"} session_id=${metadataSessionId ?? "<none>"}`
                );
            }
            if (responseSessionKey) this.responseSessionKey = responseSessionKey;

            const sharedSessionId = getResponseSessionId(responseSessionKey) ?? installationSessionId;
            console.log(
                `[WebSocket] session lookup key=${responseSessionKey ?? "<unkeyed>"} ` +
                `previous=${_tmp.sessionId ?? "<none>"} shared=${sharedSessionId ?? "<none>"} ` +
                `installation=${installationSessionId ?? "<none>"}`
            );

            if (_tmp.sessionId && sharedSessionId && _tmp.sessionId !== sharedSessionId) {
                // previous_response_id 明确指定的链路优先；说明 Codex 正在从一个已知响应继续。
                console.warn(
                    `[WebSocket] Response session remap key=${responseSessionKey} ` +
                    `from=${sharedSessionId} to=${_tmp.sessionId}`,
                );
            }

            if (_tmp.sessionId && this.sessionId && _tmp.sessionId !== this.sessionId
                && !sharedSessionId) {
                this.sendError({
                    code: "previous_response_not_found",
                    message: `Previous response with id '${_tmp.sessionId}' not found, expected ${this.sessionId}.`,
                    param: "previous_response_id"
                }, 400);
                return;
            }

            // previous_response_id 明确指定的 DeepSeek session 优先。
            // 否则只使用当前 conversationKey 已经登记的 session。
            // 第一次请求允许 sessionId 为空，由 BrowserClient 创建 DeepSeek session；
            // 创建成功后立即登记到 registry，后续 WS 全部复用。
            const sessionHint = _tmp.sessionId ?? sharedSessionId ?? this.sessionId;
            const normalized = normalizeResponsesRequest(effectiveInput, sessionHint);
            if (!normalized.message) {
                this.sendError("messages must include at least one non-empty message.", 400);
                return;
            }

            const abortController = new AbortController();
            this.abortControllers.set(requestId, abortController);

            const execute = async () => {
                // session 的解析必须发生在全局队列内部。
                // 否则多个 WS 同时进入时都会看到“还没有 session”，然后各自创建新会话。
                const runResult = await enqueueDeepSeekRequest(async () => {
                    const executionSessionId = _tmp.sessionId
                        ?? getResponseSessionId(this.responseSessionKey)
                        ?? this.sessionId;

                    if (executionSessionId && executionSessionId.startsWith(READY_RESPONSE_ID)) {
                        throw new Error(`Invalid DeepSeek sessionId: ${executionSessionId}`);
                    }

                    const executionRequest = normalizeResponsesRequest(
                        effectiveInput,
                        executionSessionId,
                    );

                    if (!executionRequest.message) {
                        throw new Error("messages must include at least one non-empty message.");
                    }

                    console.log(
                        `[DeepSeekQueue] conversationKey=${this.responseSessionKey ?? "<unkeyed>"} ` +
                        `sessionId=${executionSessionId ?? "<new>"} startedAt=${new Date().toISOString()}`
                    );

                    const result = await this.client.runChatCompletion({
                        ...executionRequest,
                        parentMessageId: executionSessionId
                            ? resolveQueuedParentMessageId(executionSessionId, executionRequest.parentMessageId)
                            : executionRequest.parentMessageId,
                        modelType: modelConfig.modelType,
                        searchEnabled: modelConfig.searchEnabled,
                        thinkingEnabled: modelConfig.thinkingEnabled,
                        signal: abortController.signal,
                    });

                    if (!result.sessionId?.trim()) {
                        throw new Error("DeepSeek returned an empty sessionId");
                    }

                    // 创建成功后立即建立全局映射。下一个排队请求会读取到同一个 session。
                    this.sessionId = result.sessionId;
                    rememberResponseSession(this.responseSessionKey, result.sessionId);
                    if (installationId) {
                        rememberInstallationSession(installationId, result.sessionId);
                    }
                    console.log(
                        `[WebSocket] DeepSeek session=${result.sessionId} ` +
                        `key=${this.responseSessionKey ?? "<unkeyed>"}`
                    );
                    return result;
                });

                rememberResponseSessionTools(runResult.sessionId, effectiveInput.tool_choice, effectiveInput.tools?.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                })));

                const parsed = await streamEventsFromStream(
                    runResult.body,
                    shouldParseToolCall(effectiveInput.tool_choice, effectiveInput.tools),
                    runResult.sessionId,
                    modelConfig.model,
                    normalizeResponsesRequest(effectiveInput, runResult.sessionId).message.length,
                    (data) => {
                        if (abortController.signal.aborted) return;
                        this.sendRaw(data);
                    },
                    {
                        signal: abortController.signal,
                        continueChat: messageId => enqueueDeepSeekRequest(() =>
                            this.client.continueChat({ sessionId: runResult.sessionId, messageId, signal: abortController.signal })
                        ),
                        stopChat: messageId => this.client.stopChat({ sessionId: runResult.sessionId, messageId }),
                    },
                );
                rememberResponseSessionMessageId(runResult.sessionId, parsed.messageId);
                this.lastInstructionMessageId = parsed.messageId ?? -114514;
            };

            try {
                await execute();
            } finally {
                this.abortControllers.delete(requestId);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[WebSocket] Request failed requestId=${requestId} error=${message}`);
            // 限流等失败时 DeepSeek 会话其实已经创建。必须登记，否则“继续”会查不到而新建会话。
            if (error instanceof DeepSeekSessionError && error.sessionId) {
                this.sessionId = error.sessionId;
                rememberResponseSession(this.responseSessionKey, error.sessionId);
                if (installationId) {
                    rememberInstallationSession(installationId, error.sessionId);
                }
                console.warn(`[WebSocket] Registered session from failed request sessionId=${error.sessionId} key=${this.responseSessionKey ?? "<unkeyed>"}`);
            }
            if (codexProtocol) {
                this.sendCodexFailed(message);
            }
            if (message.includes("Unsupported model:")) {
                this.sendError(message, 400);
                return;
            }
            this.sendError(message, 500);
        }
    }

    private send(message: WebSocketResponse) {
        if (this.ws.readyState === 1) { // WebSocket.OPEN
            this.ws.send(JSON.stringify(message));
            return;
        }
        console.warn(`[WebSocket] Skip send because socket not open (readyState=${this.ws.readyState})`);
    }

    private sendRaw(message: Record<string, any>) {
        if (this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(message));
            return;
        }
        console.warn(`[WebSocket] Skip raw send because socket not open (readyState=${this.ws.readyState})`);
    }

    private sendError(message: any, code: number = 500) {
        console.warn(`[WebSocket] Send error code=${code} message=${message}`);
        this.send({
            type: "error",
            error: message,
            status: code,
        });
    }

    private handleError(error: Error) {
        console.error(`[WebSocket Error]: ${error.message}`);
    }

    /**
     * 请求结束后的清理
     */
    private async cleanup() {
        // 中止所有待处理请求
        for (const controller of this.abortControllers.values()) {
            controller.abort();
        }
        this.abortControllers.clear();
        await Promise.allSettled(this.pendingRequests);

        // 有 Codex thread 映射的会话属于跨 WebSocket 的共享会话，连接断开时不能删除。
        if (this.sessionId && !this.sessionId.startsWith(READY_RESPONSE_ID)) {
            const shared = isResponseSessionShared(this.responseSessionKey, this.sessionId);
            const referenced = isSessionReferencedByAnyKey(this.sessionId);
            if (shared || referenced) {
                console.log(
                    `[WebSocket] Keep shared session sessionId=${this.sessionId} key=${this.responseSessionKey}`,
                );
            } else {
                try {
                    await this.client.deleteSession(this.sessionId);
                    console.log(`[WebSocket] Session deleted sessionId=${this.sessionId}`);
                } catch (error) {
                    console.warn(`[WebSocket] Failed to delete session sessionId=${this.sessionId}:`, error);
                }
                clearResponseSessionState(this.sessionId);
                clearResponseSessionTools(this.sessionId);
            }
        }
        console.log("[WebSocket] Cleanup done");
    }
}
