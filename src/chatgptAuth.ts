import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { getDefaultCdpUrl, launchChromeForDebugging, waitForDebuggerUrl } from "./browser.js";
import { normalizeChatGPTCredentials, type ChatGPTCredentials } from "./chatgptResponsesClient.js";

export function getDefaultChatGPTCredentialPath(): string {
    return path.join(process.cwd(), ".data", "chatgpt-credentials.json");
}

function getCodexAuthPath(): string {
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
}

export function loadChatGPTCredentials(inputPath = getDefaultChatGPTCredentialPath()): ChatGPTCredentials {
    const candidates = [
        inputPath,
        getCodexAuthPath(),
    ];

    for (const candidate of candidates) {
        try {
            const json = JSON.parse(fs.readFileSync(candidate, "utf8")) as any;
            const token = json?.accessToken || json?.access_token || json?.tokens?.access_token;
            if (!token || typeof token !== "string") continue;
            const accountId = json?.accountId || json?.account_id || json?.tokens?.account_id;
            const credentials = normalizeChatGPTCredentials({
                accessToken: token,
                accountId: typeof accountId === "string" ? accountId : undefined,
                userAgent: typeof json?.userAgent === "string" ? json.userAgent : undefined,
                cookie: typeof json?.cookie === "string" ? json.cookie : undefined,
            });
            return credentials;
        } catch { }
    }

    const envToken = process.env.CHATGPT_ACCESS_TOKEN;
    if (envToken) {
        return normalizeChatGPTCredentials({
            accessToken: envToken,
            accountId: process.env.CHATGPT_ACCOUNT_ID,
        });
    }

    throw new Error(
        `ChatGPT credentials not found. Put access_token in ${getDefaultChatGPTCredentialPath()} ` +
        `or ${getCodexAuthPath()}, or set CHATGPT_ACCESS_TOKEN.`
    );
}

export function saveChatGPTCredentials(credentials: ChatGPTCredentials, outputPath = getDefaultChatGPTCredentialPath()): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(normalizeChatGPTCredentials(credentials), null, 2)}\n`, "utf8");
}

export async function captureChatGPTCredentials(browser: Browser, onProgress?: (message: string) => void): Promise<ChatGPTCredentials> {
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages().find(p => p.url().includes("chatgpt.com")) || await context.newPage();

    await page.goto("https://chatgpt.com", { waitUntil: "domcontentloaded" });
    onProgress?.("Waiting for ChatGPT login/session...");

    for (let i = 0; i < 30; i++) {
        try {
            const session = await page.evaluate(async () => {
                const response = await fetch("/api/auth/session", { credentials: "include" });
                if (!response.ok) return null;
                return await response.json();
            }) as any;
            const token = session?.accessToken || session?.access_token;
            if (typeof token === "string" && token) {
                const cookies = await context.cookies("https://chatgpt.com");
                return normalizeChatGPTCredentials({
                    accessToken: token,
                    userAgent: await page.evaluate(() => navigator.userAgent),
                    cookie: cookies.map(c => `${c.name}=${c.value}`).join("; "),
                });
            }
        } catch { }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error("Timed out waiting for a logged-in ChatGPT session.");
}

export async function authChatGPT(params?: {
    launchBrowser?: boolean;
    cdp?: string | number;
    userDataDir?: string;
    closeAfterAuth?: boolean;
    outputPath?: string;
    onProgress?: (message: string) => void;
}): Promise<ChatGPTCredentials> {
    const onProgress = params?.onProgress ?? console.log;
    let cdpUrl: string;
    let close: (() => Promise<void>) | undefined;
    let launchedProcess: { kill: () => void; killed: boolean; exitCode: number | null } | undefined;

    if (params?.cdp !== undefined) {
        cdpUrl = typeof params.cdp === "number" ? `http://127.0.0.1:${params.cdp}` : params.cdp;
        await waitForDebuggerUrl(cdpUrl);
    } else if (params?.launchBrowser) {
        const launched = await launchChromeForDebugging({
            userDataDir: params.userDataDir,
            headless: false,
            detached: false,
        });
        cdpUrl = launched.cdpUrl;
        launchedProcess = launched.process;
        close = async () => {
            try {
                const browser = chromium.connectOverCDP(cdpUrl);
                const cdpSession = await (await browser).newBrowserCDPSession();
                await cdpSession.send("Browser.close");
            } catch { }
            if (launchedProcess && !launchedProcess.killed && launchedProcess.exitCode === null) launchedProcess.kill();
        };
    } else {
        cdpUrl = getDefaultCdpUrl();
        await waitForDebuggerUrl(cdpUrl);
    }

    const browser = await chromium.connectOverCDP(cdpUrl);
    try {
        const credentials = await captureChatGPTCredentials(browser, onProgress);
        saveChatGPTCredentials(credentials, params?.outputPath);
        onProgress?.(`Saved ChatGPT credentials to ${params?.outputPath || getDefaultChatGPTCredentialPath()}`);
        return credentials;
    } finally {
        if (params?.closeAfterAuth !== false) {
            await browser.close().catch(() => { });
            await close?.();
        }
    }
}

export async function getChatGPTAuthPage(): Promise<Page> {
    const browser = await chromium.connectOverCDP(getDefaultCdpUrl());
    return browser.contexts()[0]?.pages()[0] ?? await browser.contexts()[0].newPage();
}
