type QueuedRunner<T> = {
    runner: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error?: unknown) => void;
};

interface SessionQueueState {
    queue: QueuedRunner<any>[];
    lastMessageId: number | null;
    processing: boolean;
}

const MAX_SESSION_QUEUE_SIZE = 8;
const sessionStates = new Map<string, SessionQueueState>();

function getOrCreateSessionState(sessionId: string): SessionQueueState {
    let state = sessionStates.get(sessionId);
    if (!state) {
        state = {
            queue: [],
            lastMessageId: null,
            processing: false,
        };
        sessionStates.set(sessionId, state);
    }
    return state;
}

async function processSessionQueue(sessionId: string): Promise<void> {
    const state = sessionStates.get(sessionId);
    if (!state || state.processing) return;
    state.processing = true;
    try {
        while (state.queue.length > 0) {
            const item = state.queue.shift()!;
            try {
                const value = await item.runner();
                item.resolve(value);
            } catch (error) {
                item.reject(error);
            }
        }
    } finally {
        state.processing = false;
        if (state.queue.length > 0) {
            const error = new Error(`Session ${sessionId} queue processor stopped`);
            for (const pending of state.queue.splice(0)) {
                try {
                    pending.reject(error);
                } catch {
                    // ignore
                }
            }
        }
    }
}

export function enqueueResponseSessionRequest<T>(sessionId: string, runner: () => Promise<T>): Promise<T> {
    if (!sessionId) return Promise.reject(new Error("sessionId required for response session queueing"));
    const state = getOrCreateSessionState(sessionId);
    if (state.queue.length >= MAX_SESSION_QUEUE_SIZE) {
        return Promise.reject(new Error(`Session ${sessionId} queue full (max ${MAX_SESSION_QUEUE_SIZE})`));
    }
    return new Promise<T>((resolve, reject) => {
        state.queue.push({ runner, resolve, reject });
        void processSessionQueue(sessionId).catch((error) => {
            console.error(`[ResponsesSessionQueue] queue processor error for ${sessionId}:`, error);
        });
    });
}

export function resolveQueuedParentMessageId(sessionId: string, requestedParentMessageId: number | null | undefined): number | null {
    const state = sessionStates.get(sessionId);
    if (!state) return requestedParentMessageId ?? null;
    // 在队列中的任务默认顺序，不能覆盖
    return state.lastMessageId ?? requestedParentMessageId ?? null;
}

export function rememberResponseSessionMessageId(sessionId: string, messageId: number | null): void {
    if (!sessionId) return;
    const state = getOrCreateSessionState(sessionId);
    state.lastMessageId = messageId;
}

export function clearResponseSessionState(sessionId: string): void {
    sessionStates.delete(sessionId);
}
// DeepSeek 网页端对同一账号的请求频率有限制。
// 不同 session / 不同 WebSocket 不能绕过这个限制，所以这里做全局节流。
// 只限制“请求开始时间”，不会把整个 SSE 流串行化。
const MIN_DEEPSEEK_REQUEST_INTERVAL_MS = 1500;
let lastDeepSeekRequestStartedAt = 0;
let deepSeekRequestTail: Promise<void> = Promise.resolve();

function delay(ms: number): Promise<void> {
    return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function enqueueDeepSeekRequest<T>(runner: () => Promise<T>): Promise<T> {
    const previous = deepSeekRequestTail;
    let release!: () => void;
    deepSeekRequestTail = new Promise<void>(resolve => {
        release = resolve;
    });

    await previous;

    try {
        const wait = MIN_DEEPSEEK_REQUEST_INTERVAL_MS - (Date.now() - lastDeepSeekRequestStartedAt);
        await delay(Math.max(0, wait));
        lastDeepSeekRequestStartedAt = Date.now();
        return await runner();
    } finally {
        release();
    }
}
