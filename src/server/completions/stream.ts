import { parseResultFromStream, type StreamReadOptions } from "../../deepseekStreamParser.js";
import { estimateUsage } from "../responses/responsesType.js";
import { ToolCallDelta, ToolCallParser, type ToolDescription, validateToolCallArguments } from "../toolPrompt.js";
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
    const toolParser = useTool ? new ToolCallParser() : null;
    const builder = new StreamResponseBuilder(send, requestId, model);
    builder.initSend();
    const pendingToolCalls: Array<{ name: string; parameters: string }> = [];
    let completeResponse = '';

    function addToolCall(name: string, parameters: string) {
        if (!name || !parameters) return;
        const key = `${name}\0${parameters}`;
        if (pendingToolCalls.some(x => `${x.name}\0${x.parameters}` === key)) return;
        pendingToolCalls.push({ name, parameters });
    }

    function parseToolEvent(ev: ToolCallDelta) {
        switch (ev.type) {
            case 'tool_call':
                addToolCall(ev.data.name, ev.data.parameters);
                break;
            case 'text_delta':
                builder.sendText(ev.data);
                break;
            default:
                break;
        }
    }

    const result = await parseResultFromStream(stream, (type, delta) => {
        if (type === 'THINK') {
            builder.sendText(delta, true);
        } else if (type === 'RESPONSE') {
            completeResponse += delta;
            if (toolParser) {
                for (const ev of toolParser.push(delta)) parseToolEvent(ev);
            } else {
                builder.sendText(delta);
            }
        }
    }, options);

    if (toolParser) {
        for (const ev of toolParser.finishAll()) parseToolEvent(ev);

        // 流式状态机没识别到的异常/混合协议，再用完整响应解析一次。
        // 只补充尚未识别的调用，不影响正常的实时文本输出。
        for (const call of ToolCallParser.extractFromCompleteResponse(completeResponse, toolSchemas)) {
            addToolCall(call.tool, call.parameters);
        }
    }

    // 工具调用统一在 DeepSeek EOF 后发给 Codex，避免 Codex 在第一条调用后
    // 提前结束本轮；但普通中文文本仍然在 DeepSeek 输出过程中实时显示。
    for (const call of pendingToolCalls) {
        if (!validateToolCallArguments(call.name, call.parameters, toolSchemas)) continue;
        builder.sendFunctionToolCall({
            id: ToolCallParser.buildCallId(call.name, call.parameters),
            type: 'function',
            function: { name: call.name, arguments: call.parameters }
        });
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
