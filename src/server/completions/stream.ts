import { parseResultFromStream, type StreamReadOptions } from "../../deepseekStreamParser.js";
import { estimateUsage } from "../responses/responsesType.js";
import { ToolCallParser, type ToolDescription, validateToolCallArguments } from "../toolPrompt.js";
import { ChatCompletionMessageFunctionToolCall, CompletionsFinishReason } from "./completionsType.js";

export interface CompletionsChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: {
        index: number;
        delta: CompletionsDelta;
        finish_reason: CompletionsFinishReason;
        logprobs: null; // 目前不支持logprobs
    }[];
    usage?: {
        total_tokens: number;
        prompt_tokens: number;
        completion_tokens: number;
    } | null;
}

export interface CompletionsDelta {
    content?: string;
    reasoning_content?: string;
    refusal?: string;
    role?: 'assistant';
    tool_calls?: CompletionStreamFunctionToolCall[];
}

export interface CompletionStreamFunctionToolCall extends ChatCompletionMessageFunctionToolCall {
    index: number;  // 调用顺序
}


class StreamResponseBuilder {
    send: (chunk: any) => void;
    requestId: string;
    model: string;
    private toolCallNumber = 0;
    constructor(send: (chunk: any) => void, requestId: string, model: string) {
        this.send = send;
        this.requestId = requestId;
        this.model = model;
    }

    initSend() {
        const chunk = this.buildCompletionsChunk({
            role: 'assistant',
        });
        this.send(chunk);
    }

    buildCompletionsChunk(
        delta: CompletionsDelta,
        finishReason: CompletionsFinishReason = null
    ): CompletionsChunk {
        return {
            id: this.requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [{
                index: 0,
                delta: delta,
                finish_reason: finishReason,
                logprobs: null,
            }],
            usage: null
        };
    }

    sendText(text: string, reason = false) {
        const chunk = this.buildCompletionsChunk(
            reason ? { reasoning_content: text } : { content: text }
        );
        this.send(chunk);
    }

    sendFunctionToolCall(toolCall: ChatCompletionMessageFunctionToolCall) {
        const chunk = this.buildCompletionsChunk({
            tool_calls: [{
                ...toolCall,
                index: this.toolCallNumber++,
            }]
        });
        this.send(chunk);
    }

    finish(usage?: { total_tokens: number; prompt_tokens: number; completion_tokens: number }) {
        const reason = this.toolCallNumber > 0 ? 'tool_calls' : 'stop';
        const chunk = this.buildCompletionsChunk({}, reason);
        if (usage) chunk.usage = usage;
        this.send(chunk);
    }
}

export async function streamEventsFromStream(
    stream: ReadableStream<Uint8Array>,
    useTool: boolean,
    requestId: string,
    model: string,
    inputLength: number,
    send: (data: any) => void,
    options: StreamReadOptions = {},
    toolSchemas?: ToolDescription[],
) {
    const builder = new StreamResponseBuilder(send, requestId, model);
    builder.initSend();
    let completeResponse = '';

    const result = await parseResultFromStream(stream, (type, delta) => {
        if (type === 'THINK') {
            builder.sendText(delta, true);
        } else if (type === 'RESPONSE') {
            completeResponse += delta;
            // Tool-enabled responses are buffered until the whole protocol is parsed.
            if (!useTool) builder.sendText(delta);
        }
    }, options);

    if (useTool) {
        const calls = ToolCallParser.extractFromCompleteResponse(completeResponse, toolSchemas);
        let cursor = 0;
        const emitCleanText = (text: string) => {
            const clean = ToolCallParser.stripProtocolMarkup(text);
            if (clean) builder.sendText(clean);
        };

        for (const call of calls) {
            if (call.start < cursor) continue;
            emitCleanText(completeResponse.slice(cursor, call.start));
            if (validateToolCallArguments(call.tool, call.parameters, toolSchemas)) {
                builder.sendFunctionToolCall({
                    id: ToolCallParser.buildCallId(call.tool, call.parameters),
                    type: 'function',
                    function: { name: call.tool, arguments: call.parameters }
                });
            }
            cursor = call.start + call.raw.length;
        }
        emitCleanText(completeResponse.slice(cursor));
    }

    const usage = estimateUsage(
        result.accumulated_token_usage,
        inputLength,
        result.text.length + result.thinking.length
    );
    builder.finish({
        total_tokens: usage.total_tokens,
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
    });
    return result;
}
