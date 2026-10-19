import { parseArgs } from "node:util";
import { authChatGPT } from "../chatgptAuth.js";

const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
        browser: { type: "boolean", default: true },
        cdp: { type: "string" },
        "user-data-dir": { type: "string" },
        output: { type: "string", short: "o" },
    },
    allowPositionals: false,
    strict: true,
});

authChatGPT({
    launchBrowser: parsed.values.browser && !parsed.values.cdp,
    cdp: parsed.values.cdp,
    userDataDir: parsed.values["user-data-dir"],
    outputPath: parsed.values.output,
    onProgress: message => console.log(`[ChatGPT Auth] ${message}`),
}).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
