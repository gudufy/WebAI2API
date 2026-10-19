import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 跨 WebSocket 连接、跨 WebAI2API 重启复用 DeepSeek 会话。
 *
 * Codex 的一个用户操作可能建立多条 WS：例如 thread_title 和真正的 user turn。
 * WS 不能作为 DeepSeek 会话边界，真正的边界是 Codex installation_id + thread_id。
 *
 * 映射同时保存在 .data/response-sessions.json，避免 WebAI2API 重启后丢失
 * Codex thread -> DeepSeek session 的关系。
 */
interface ResponseSessionBinding {
    sessionId: string;
    lastUsedAt: number;
}

interface PersistedRegistry {
    version: 1;
    bindings?: Record<string, ResponseSessionBinding>;
    installationBindings?: Record<string, ResponseSessionBinding>;
}

const MAX_BINDINGS = 128;
const REGISTRY_PATH = path.join(process.cwd(), ".data", "response-sessions.json");
const bindings = new Map<string, ResponseSessionBinding>();
const installationBindings = new Map<string, ResponseSessionBinding>();

function normalizeKey(value: string | null | undefined): string | null {
    const key = value?.trim();
    return key ? key : null;
}

function trimToLimit(map: Map<string, ResponseSessionBinding>): void {
    while (map.size > MAX_BINDINGS) {
        const oldest = map.keys().next().value;
        if (!oldest) break;
        map.delete(oldest);
    }
}

function loadPersistedRegistry(): void {
    if (!existsSync(REGISTRY_PATH)) return;

    try {
        const text = readFileSync(REGISTRY_PATH, "utf8");
        const data = JSON.parse(text) as PersistedRegistry;
        if (data.version !== 1) return;

        for (const [key, binding] of Object.entries(data.bindings ?? {})) {
            if (!key || !binding || typeof binding.sessionId !== "string" || !binding.sessionId.trim()) continue;
            bindings.set(key, {
                sessionId: binding.sessionId.trim(),
                lastUsedAt: typeof binding.lastUsedAt === "number" ? binding.lastUsedAt : Date.now(),
            });
        }
        for (const [key, binding] of Object.entries(data.installationBindings ?? {})) {
            if (!key || !binding || typeof binding.sessionId !== "string" || !binding.sessionId.trim()) continue;
            installationBindings.set(key, {
                sessionId: binding.sessionId.trim(),
                lastUsedAt: typeof binding.lastUsedAt === "number" ? binding.lastUsedAt : Date.now(),
            });
        }

        trimToLimit(bindings);
        trimToLimit(installationBindings);
        console.log(
            `[ResponseSessionRegistry] Loaded persisted sessions: threads=${bindings.size}, installations=${installationBindings.size}`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ResponseSessionRegistry] Failed to load persisted sessions: ${message}`);
    }
}

function persistRegistry(): void {
    try {
        const directory = path.dirname(REGISTRY_PATH);
        mkdirSync(directory, { recursive: true });
        const data: PersistedRegistry = {
            version: 1,
            bindings: Object.fromEntries(bindings),
            installationBindings: Object.fromEntries(installationBindings),
        };
        writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[ResponseSessionRegistry] Failed to persist sessions: ${message}`);
    }
}

function touch(map: Map<string, ResponseSessionBinding>, key: string, binding: ResponseSessionBinding) {
    map.delete(key);
    map.set(key, binding);
}

loadPersistedRegistry();

export function getResponseSessionId(key: string | null | undefined): string | null {
    const normalized = normalizeKey(key);
    if (!normalized) return null;
    const binding = bindings.get(normalized);
    if (!binding) return null;
    binding.lastUsedAt = Date.now();
    touch(bindings, normalized, binding);
    return binding.sessionId;
}

export function getInstallationSessionId(installationId: string | null | undefined): string | null {
    const normalized = normalizeKey(installationId);
    if (!normalized) return null;
    const binding = installationBindings.get(normalized);
    if (!binding) return null;
    binding.lastUsedAt = Date.now();
    touch(installationBindings, normalized, binding);
    return binding.sessionId;
}

export function getLatestResponseSessionId(): string | null {
    const last = Array.from(bindings.values()).at(-1);
    return last?.sessionId ?? null;
}

export function rememberResponseSession(key: string | null | undefined, sessionId: string): void {
    const normalized = normalizeKey(key);
    const value = sessionId.trim();
    if (!normalized || !value) return;

    const existing = bindings.get(normalized);
    if (existing?.sessionId === value) {
        existing.lastUsedAt = Date.now();
        touch(bindings, normalized, existing);
        return;
    }

    bindings.delete(normalized);
    bindings.set(normalized, { sessionId: value, lastUsedAt: Date.now() });
    trimToLimit(bindings);
    persistRegistry();
}

export function rememberInstallationSession(installationId: string | null | undefined, sessionId: string): void {
    const normalized = normalizeKey(installationId);
    const value = sessionId.trim();
    if (!normalized || !value) return;

    const existing = installationBindings.get(normalized);
    if (existing?.sessionId === value) {
        existing.lastUsedAt = Date.now();
        touch(installationBindings, normalized, existing);
        return;
    }

    installationBindings.delete(normalized);
    installationBindings.set(normalized, { sessionId: value, lastUsedAt: Date.now() });
    trimToLimit(installationBindings);
    persistRegistry();
}

export function isSessionReferencedByAnyKey(sessionId: string): boolean {
    const value = sessionId.trim();
    if (!value) return false;
    for (const binding of bindings.values()) {
        if (binding.sessionId === value) return true;
    }
    for (const binding of installationBindings.values()) {
        if (binding.sessionId === value) return true;
    }
    return false;
}
export function isResponseSessionShared(key: string | null | undefined, sessionId: string): boolean {
    const normalized = normalizeKey(key);
    if (!normalized) return false;
    return bindings.get(normalized)?.sessionId === sessionId;
}
