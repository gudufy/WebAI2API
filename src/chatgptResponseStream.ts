export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
                const dataLines = block.split(/\r?\n/).filter(line => line.startsWith("data:"));
                if (!dataLines.length) continue;
                const data = dataLines.map(line => line.slice(5).trim()).join("\n");
                if (!data || data === "[DONE]") continue;
                try {
                    const event = JSON.parse(data) as unknown;
                    if (event && typeof event === "object") yield event as Record<string, unknown>;
                } catch {
                    // Ignore malformed telemetry/non-JSON SSE frames.
                }
            }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
            const dataLines = buffer.split(/\r?\n/).filter(line => line.startsWith("data:"));
            const data = dataLines.map(line => line.slice(5).trim()).join("\n");
            if (data && data !== "[DONE]") {
                try {
                    const event = JSON.parse(data) as unknown;
                    if (event && typeof event === "object") yield event as Record<string, unknown>;
                } catch { }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

function responseFromCompleted(event: Record<string, unknown>): Record<string, unknown> | undefined {
    const response = event.response;
    return response && typeof response === "object" ? { ...(response as Record<string, unknown>) } : undefined;
}

export async function collectResponse(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
    const output: Record<string, Record<string, unknown>> = {};
    const outputOrder: string[] = [];
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    let completed: Record<string, unknown> | undefined;
    let failed: Record<string, unknown> | undefined;

    for await (const event of parseSseStream(stream)) {
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
            textParts.push(event.delta);
        } else if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
            reasoningParts.push(event.delta);
        } else if (type === "response.output_item.added" || type === "response.output_item.done") {
            const item = event.item;
            if (item && typeof item === "object") {
                const value = item as Record<string, unknown>;
                const id = typeof value.id === "string" ? value.id : `output_${outputOrder.length}`;
                if (!output[id]) outputOrder.push(id);
                output[id] = { ...output[id], ...value };
            }
        } else if (type === "response.completed") {
            completed = responseFromCompleted(event);
        } else if (type === "response.failed" || type === "error") {
            failed = event;
        }
    }

    if (failed) {
        const error = failed.error && typeof failed.error === "object" ? failed.error : failed;
        throw new Error(typeof (error as any)?.message === "string" ? (error as any).message : "ChatGPT response failed.");
    }

    const result: Record<string, unknown> = completed ?? {};
    const assembledOutput = outputOrder.map(id => output[id]);
    const existingOutput = Array.isArray(result.output) ? result.output : [];

    // ChatGPT/Codex occasionally sends output: [] or output: null on response.completed.
    // Rebuild the output from output_item.done, which is the authoritative stream-level data.
    if (assembledOutput.length > 0) {
        result.output = assembledOutput;
    } else if (existingOutput.length === 0 && textParts.length > 0) {
        result.output = [{
            id: "msg_assembled",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{
                type: "output_text",
                text: textParts.join(""),
                annotations: [],
            }],
        }];
    } else {
        result.output = existingOutput;
    }

    if (typeof result.output_text !== "string" && textParts.length > 0) {
        result.output_text = textParts.join("");
    }
    if (reasoningParts.length > 0 && !result.reasoning_summary) {
        result.reasoning_summary = reasoningParts.join("");
    }
    return result;
}

export async function forwardSseStream(
    stream: ReadableStream<Uint8Array>,
    send: (event: Record<string, unknown>) => void,
): Promise<void> {
    for await (const event of parseSseStream(stream)) {
        send(event);
    }
}
