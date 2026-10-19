import { jsonrepair } from 'jsonrepair';    // 有时会少掉尾部的大括号 修复一下
function safeJsonRepair(value: string): string {
    try {
        return jsonrepair(value);
    } catch {
        return value;
    }
}

import { ToolChoice } from "./completions/completionsType.js";

export interface ToolDescription {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
}

export function autoToolChoice(tools?: Array<any>): ToolChoice {
    if (!tools || tools.length === 0) return 'none';
    return 'auto';
}

export function shouldParseToolCall(toolChoice: ToolChoice, tools?: Array<any>): boolean {
    if (toolChoice === 'none') return false;
    // tools 为空时无需解析工具调用，避免对纯文本输出误判 tool_call。
    return Array.isArray(tools) && tools.length > 0;
}

export function buildToolPrompt(toolChoice: ToolChoice, tools?: ToolDescription[]): string {
    if (!tools || tools.length === 0 || toolChoice === 'none') return `[tool instruction]:\n${buildToolChoicePrompt(toolChoice)}`;

    const INSTRUCTION = `
[tool instruction]:
You will receive a JSON string containing a list of callable tools. Use the tools when needed.

Now you have access to the following tools:

${JSON.stringify(tools)}

IMPORTANT TOOL OUTPUT FORMAT:
When you need to call a tool, use this exact format:
<tool_call>tool_name<params>{"argument": value}</params></tool_call>

Rules:
- The tool name MUST be exactly the callable tool name.
- Put all tool arguments inside the <params> JSON object.
- You may output multiple <tool_call> blocks in one response.
- You may first explain what you are going to do in normal text, then output the tool call.
- Do not output DeepSeek DSML tags when using this format.
- If no tool is needed, answer normally without any tool_call tags.

${buildToolChoicePrompt(toolChoice)}

When the user communicates with you in a language other than English, you need to communicate with the user in the same language.`;

    return INSTRUCTION;
}
function buildToolChoicePrompt(toolChoice?: ToolChoice): string {
    if (toolChoice === 'auto') return 'Please choose the appropriate tools according to the user’s question. If you don’t need to call it, please reply directly to the user’s question.';
    if (toolChoice === 'required') return 'You must choose one of the tools according to the user’s question.';
    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
        return `You must call the function ${toolChoice.function.name} according to the user’s question.`;
    } return 'You can\'t call any tools. Please answer the user\'s question directly in the same language.';
}

// 模型往往犯蠢，不按照格式输出，所以设计了多种标签
const canonicalBeginTag = '<tool_call>';
const canonicalEndTag = '</tool_call>';
const beginTags = [
    '<｜｜DSML｜｜tool_call>',
    '<｜DSML｜tool_calls>',
    '<｜tool▁call▁begin｜>',
    canonicalBeginTag,
    '<tool>',
    '<tool_use>',
    '<call>',
    '<call_exec>',
    '<function_call>',
];
const endTags = ['<｜tool▁call▁end｜>', canonicalEndTag, '</tool>', '</tool_use>', '</call>', '</function_call>'];

// DeepSeek V4.1 使用 DSML 的 calls/invoke/parameter 格式。
// 网页端实际返回过两种前缀：<｜DSML｜ ...> 和 <｜｜DSML｜｜ ...>，两者都兼容。
const dsmlCallsBeginTags = [
    '<｜DSML｜ calls>',
    '<｜｜DSML｜｜ calls>',
    '<｜DSML｜calls>',
    '<｜｜DSML｜｜calls>',
];
const maxBeginTagLength = Math.max(
    ...beginTags.map(tag => tag.length),
    ...dsmlCallsBeginTags.map(tag => tag.length),
    ...endTags.map(tag => tag.length),
    '<｜｜DSML｜｜ invoke name="exec_command">'.length,
);
const paramsBeginTag = '<params>';
const paramsBeginTag2 = '{';
const paramsEndTag = '</params>';
const maxClosingTagLength = Math.max(
    paramsEndTag.length,
    ...endTags.map(tag => tag.length),
    '<\/｜｜DSML｜｜ calls>'.length,
);

export const toolCallFormat = `[important]:
When you need to call a tool, use ONLY this format:
<tool_call>tool_name<params>{"argument": value}</params></tool_call>
You may output normal text before the tool call.
You may output multiple tool_call blocks.
Do not use DeepSeek DSML tags when using this format.`;

const toolCallPattern = /(?:<｜｜DSML｜｜tool_call>|<｜DSML｜tool_calls>|<｜tool▁call▁begin｜>|<tool_call>)\s*([\s\S]*?)\s*<params>\s*([\s\S]*?)\s*<\/params>\s*(?:<｜tool▁call▁end｜>|<\/tool_call>)/gs;

// DSML V4.1 的完整调用格式：
// <｜DSML｜ calls>
//   <｜DSML｜ invoke name="exec_command">
//     <｜DSML｜ parameter name="cmd" string="true">...</｜DSML｜ parameter>
//   </｜DSML｜ invoke>
// </｜DSML｜ calls>
// 实际网页链路可能把 <｜DSML｜> 显示/传成 <｜｜DSML｜｜>，所以统一用正则兼容。
const dsmlCallsBeginPattern = /<｜(?:｜)?DSML(?:｜)?(?:｜)?\s*(?:calls|_call)\s*>/;
const dsmlCallsEndPattern = /<\/｜(?:｜)?DSML(?:｜)?(?:｜)?\s*(?:calls|_call)\s*>/;
const dsmlInvokeBeginPattern = /<｜(?:｜)?DSML(?:｜)?(?:｜)?\s*invoke\b([^>]*)>/;
const dsmlInvokeEndPattern = /<\/｜(?:｜)?DSML(?:｜)?(?:｜)?\s*invoke\s*>/;
const dsmlParameterBeginPattern = /<｜(?:｜)?DSML(?:｜)?(?:｜)?\s*parameter\b([^>]*)>/;
const dsmlParameterEndPattern = /<\/｜(?:｜)?DSML(?:｜)?(?:｜)?\s*parameter\s*>/;
const dsmlStandaloneInvokeBeginPattern = /<｜(?:｜)?DSML(?:｜)?(?:｜)?\s*invoke\b([^>]*)>/;


// DeepSeek Web/Agent 还会返回这种非 DSML 的工具调用包装：
// <call_exec>exec_command<params>{"cmd":"..."}</params></call>
// 以及少量兼容格式：<function_call name="xxx"><arguments>{...}</arguments></function_call>。
// 这些格式只在结构完整时识别，避免把普通回答中的文字误判成工具调用。
// DeepSeek Web/Agent 的 wrapper 名称并不稳定，实际见过 <call_exec>、<call_call> 等。
// 不要只写死某一个前缀：真正有用的信息是 wrapper 内的 tool name + params。
// 只接受结构完整的 <call_xxx> ... </call>，避免普通文本误触发。
// 通用 Web Agent 工具调用包装器：
// 不关心外层标签叫什么。只利用稳定的结构：
//   <任意包装标签>工具名<params>JSON</params>...</任意结束标签>
// 例如 <call_exec>、<call_call>、<call_xxx> 都按同一规则处理。
// 注意：结束标签不要求和开始标签同名，因为 DeepSeek Web 实际返回过
// <call_call> ... </call> 这种形式。
const genericParamsWrapperPattern =
    /<([A-Za-z][A-Za-z0-9_.:-]*)>\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*<params>\s*([\s\S]*?)\s*<\/params>/;

const functionCallCompletePattern = /<function_call\b([^>]*)>\s*(?:<arguments>|<params>)\s*([\s\S]*?)\s*(?:<\/arguments>|<\/params>)\s*<\/function_call>/;

/**
 * DeepSeek Web 偶尔把 DSML 协议碎片泄漏进 params。
 * 这些碎片不是参数的一部分，必须在 JSON repair 前去掉，否则例如
 * `60000</｜｜DSML｜｜ parameter>` 会直接变成非法 JSON。
 */
function sanitizeToolParameters(value: string): string {
    return value
        .replace(/<\/?｜(?:｜)?DSML(?:｜)?(?:｜)?\s*(?:calls|invoke|parameter)(?:\b[^>]*)?>/g, '')
        .replace(/<\/?｜(?:｜)?DSML(?:｜)?(?:｜)?\s*(?:calls|invoke|parameter)\b[^>]*>/g, '')
        .replace(/｜(?:｜)?DSML(?:｜)?(?:｜)?\s*(?:calls|invoke|parameter)\s*>/g, '')
        .trim();
}

function tryParseParameters(value: string): string | null {
    const sanitized = sanitizeToolParameters(value);
    try {
        const repaired = safeJsonRepair(sanitized);
        JSON.parse(repaired);
        return repaired;
    } catch {
        return null;
    }
}

/**
 * 结构优先的 params 解析器。
 * 不关心外层到底叫 <call_exec>、<call_call>、<tool_call> 还是别的名字。
 * 唯一依赖的是：`工具名 + <params> + JSON`。
 */
function parseGenericParamsToolCall(value: string): { tool: string; parameters: string; raw: string; index: number } | null {
    const paramsRe = /<params>\s*([\s\S]*?)\s*<\/params>/g;
    let match: RegExpExecArray | null;

    while ((match = paramsRe.exec(value))) {
        const paramsStart = match.index;
        // 只看 <params> 前面最近的一小段结构文本，避免从普通回答的很远处
        // 把单词误认成工具名。支持：<call_xxx>tool<params>...。
        const prefixStart = Math.max(0, paramsStart - 512);
        const prefix = value.slice(prefixStart, paramsStart);
        const tokenMatches = [...prefix.matchAll(/(?:^|[<>\s\n\r])([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/g)];
        if (tokenMatches.length === 0) continue;

        const tool = tokenMatches[tokenMatches.length - 1][1];
        if (!tool || /^(tool|call|params|arguments|function_call)$/i.test(tool)) continue;

        const parameters = tryParseParameters(match[1]);
        if (parameters === null) continue;

        // 从外层 wrapper 的开头开始消费；没有可靠的结束标签时，消费到 </params> 即可。
        const wrapperMatch = prefix.match(/<([A-Za-z][A-Za-z0-9_.:-]*)>\s*[^<>\s]+\s*$/);
        const start = wrapperMatch && wrapperMatch.index !== undefined
            ? prefixStart + wrapperMatch.index
            : paramsStart - (prefix.match(/[A-Za-z_][A-Za-z0-9_.:-]*\s*$/)?.[0].length ?? 0);

        return {
            tool,
            parameters,
            raw: value.slice(start, paramsRe.lastIndex),
            index: start,
        };
    }

    return null;
}

function parseParamsOnlyToolCall(value: string, fallbackTool?: string): { tool: string; parameters: string; raw: string; index: number } | null {
    if (!fallbackTool) return null;
    const match = value.match(/<([A-Za-z][A-Za-z0-9_.:-]*)>\s*<params>\s*([\s\S]*?)\s*<\/params>/);
    if (!match || match.index === undefined) return null;
    const parameters = tryParseParameters(match[2]);
    if (parameters === null) return null;
    return {
        tool: fallbackTool,
        parameters,
        raw: match[0],
        index: match.index,
    };
}

function parseExplicitWrappedToolCall(value: string, fallbackTool?: string): { tool: string; parameters: string; raw: string; index: number } | null {
    const generic = value.match(genericParamsWrapperPattern);
    const structural = parseGenericParamsToolCall(value);
    const paramsOnly = parseParamsOnlyToolCall(value, fallbackTool);
    const functionCall = value.match(functionCallCompletePattern);

    let selected: { raw: string; index: number } | null = null;
    let tool = '';
    let parameters = '';

    if (generic && generic.index !== undefined) {
        const parsed = tryParseParameters(generic[3]);
        if (parsed !== null) {
            selected = { raw: generic[0], index: generic.index };
            tool = generic[2].trim();
            parameters = parsed;
        }
    }

    if (structural && (!selected || structural.index < selected.index)) {
        selected = structural;
        tool = structural.tool;
        parameters = structural.parameters;
    }

    if (paramsOnly && (!selected || paramsOnly.index < selected.index)) {
        selected = paramsOnly;
        tool = paramsOnly.tool;
        parameters = paramsOnly.parameters;
    }

    if (functionCall && functionCall.index !== undefined &&
        (!selected || functionCall.index < selected.index)) {
        const parsed = tryParseParameters(functionCall[2]);
        if (parsed !== null) {
            selected = { raw: functionCall[0], index: functionCall.index };
            tool = readXmlAttribute(functionCall[1], 'name')?.trim() ?? '';
            parameters = parsed;
        }
    }

    if (!selected || !tool) return null;

    return { tool, parameters, raw: selected.raw, index: selected.index };
}

function readXmlAttribute(attributes: string, name: string): string | undefined {
    const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
    return match?.[2];
}

function decodeXmlText(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function parseDsmlParameterValue(value: string, isString: boolean): unknown {
    // 若 DeepSeek 漏了 parameter 结束标签，后续参数/调用标签可能被吞进当前值。
    // 参数值一旦遇到这些协议边界，就只保留边界之前的内容；绝不把协议残片交给 shell。
    const protocolBoundary = /<\s*\/?\s*(?:｜{0,2})?DSML(?:｜{0,2})?\s+(?:calls|invoke|parameter)\b[^>]*>/i;
    const boundary = protocolBoundary.exec(value);
    const boundedValue = boundary ? value.slice(0, boundary.index) : value;
    const text = decodeXmlText(boundedValue).trim();
    if (isString) return text;
    if (!text) return '';
    try {
        return JSON.parse(jsonrepair(text));
    } catch {
        // 某些模型虽然声明 string=false，实际仍输出普通文本；不要让整个 tool call 失效。
        return text;
    }
}

function buildDsmlParameters(parameters: Record<string, unknown>): string {
    return JSON.stringify(parameters);
}

function isLikelyToolName(value: string): boolean {
    const name = value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{1,127}$/.test(name)) return false;
    if (/^(action|tool|function|name|input|inputs|params|parameters|arguments|argument|request|response|result|data|value|content|text|message)$/i.test(name)) return false;
    return true;
}

/**
 * 不认识的新协议也不要立即失败。
 *
 * 这是一个“结构推断”兜底解析器，而不是针对某个具体协议的 parser：
 * 1. 从 XML/类 XML 中寻找 action/tool/function/name 等位置的工具名；
 * 2. 再寻找 input/arguments/params/parameters 下的 JSON 或 key/value 参数；
 * 3. 如果结构足够完整，就生成一个候选调用。
 *
 * 它故意不直接执行，只返回候选结果；调用方还会和其他 parser 的结果一起去重、排序。
 */
function parseUnknownStructuredToolCalls(value: string): parsedToolCall[] {
    const results: parsedToolCall[] = [];
    if (!value || !/[<][A-Za-z]/.test(value)) return results;

    const tagRe = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9_.:-]*)\b([^>]*)>/g;
    const tags: Array<{ start: number; end: number; close: boolean; name: string; attrs: string }> = [];
    let tag: RegExpExecArray | null;
    while ((tag = tagRe.exec(value))) {
        tags.push({
            start: tag.index,
            end: tagRe.lastIndex,
            close: !!tag[1],
            name: tag[2],
            attrs: tag[3] ?? '',
        });
    }

    const stack: Array<typeof tags[number]> = [];
    const nodes: Array<{ open: typeof tags[number]; close?: typeof tags[number]; start: number; end: number; body: string }> = [];
    for (const current of tags) {
        if (!current.close) {
            stack.push(current);
            continue;
        }
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].name.toLowerCase() !== current.name.toLowerCase()) continue;
            const open = stack[i];
            stack.splice(i);
            nodes.push({ open, close: current, start: open.start, end: current.end, body: value.slice(open.end, current.start) });
            break;
        }
    }

    const candidates = new Map<string, parsedToolCall>();
    const toolCarrier = /^(action|tool|function|call|operation|method|command|name)$/i;
    const argumentCarrier = /^(input|inputs|args|arguments|params|parameters|payload|request)$/i;

    for (const node of nodes) {
        if (!toolCarrier.test(node.open.name)) continue;
        const attributeTool = readXmlAttribute(node.open.attrs, 'name') ?? readXmlAttribute(node.open.attrs, 'tool') ?? readXmlAttribute(node.open.attrs, 'function');
        const tool = (attributeTool ?? node.body.replace(/<[^>]+>/g, '')).trim();
        if (!isLikelyToolName(tool)) continue;

        // 在工具名节点后面的一小段范围寻找参数容器，避免把普通叙述中的 action/name 误判。
        const tail = value.slice(node.end, Math.min(value.length, node.end + 4096));
        const argMatch = tail.match(/<\s*(?:input|inputs|args|arguments|params|parameters|payload|request)\b[^>]*>([\s\S]*?)<\s*\/\s*(?:input|inputs|args|arguments|params|parameters|payload|request)\s*>/i);
        if (!argMatch) continue;

        const rawArgs = argMatch[1].trim();
        let parameters: string | null = tryParseParameters(rawArgs);

        // 新协议常见的 <input><cmd>...</cmd><workdir>...</workdir></input>。
        if (parameters === null) {
            const object: Record<string, unknown> = {};
            const fieldRe = /<\s*([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/g;
            let field: RegExpExecArray | null;
            while ((field = fieldRe.exec(rawArgs))) {
                const fieldValue = field[2].replace(/<[^>]+>/g, '').trim();
                if (fieldValue) object[field[1]] = fieldValue;
            }
            if (Object.keys(object).length > 0) parameters = JSON.stringify(object);
        }
        if (parameters === null) continue;

        const start = node.start;
        const raw = value.slice(start, node.end + argMatch.index + argMatch[0].length);
        const key = `${start}\0${tool}\0${parameters}`;
        candidates.set(key, { tool, parameters, start, raw });
    }

    // 另一种新格式：<exec_command><input>...</input></exec_command>。
    // 此时工具名就是参数容器的父节点名。
    for (const node of nodes) {
        if (!argumentCarrier.test(node.open.name)) continue;
        const parent = nodes.find(x => x.start < node.start && x.end >= node.end && x.open.name !== node.open.name);
        if (!parent || !isLikelyToolName(parent.open.name)) continue;
        const parameters = tryParseParameters(node.body.trim()) ?? (() => {
            const object: Record<string, unknown> = {};
            const fieldRe = /<\s*([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/g;
            let field: RegExpExecArray | null;
            while ((field = fieldRe.exec(node.body))) object[field[1]] = field[2].replace(/<[^>]+>/g, '').trim();
            return Object.keys(object).length ? JSON.stringify(object) : null;
        })();
        if (parameters === null) continue;
        const key = `${parent.start}\0${parent.open.name}\0${parameters}`;
        candidates.set(key, { tool: parent.open.name, parameters, start: parent.start, raw: value.slice(parent.start, Math.max(parent.end, node.end)) });
    }

    return [...candidates.values()];
}

// ===== 流式解析 =====
interface ToolCallDeltaToolInfo {
    type: 'tool_call';
    data: {
        name: string;
        parameters: string;
    };
}
interface ToolCallDeltaStr {
    type: 'tool_call_name' | 'tool_call_parameters_delta' | 'text_delta';
    data: string;
}
export type ToolCallDelta = ToolCallDeltaToolInfo | ToolCallDeltaStr;

// 实际上由于本项目的 call_id 是调用的源码，因此应该忽略 tool_call_name 和 tool_call_parameters_delta 这两种增量事件直接等到 tool_call 事件才进行调用
enum ToolCallParseState {
    Normal,
    InToolCall,
    InParams,
    WatchingEndTag,
    DsmlInCalls,
    DsmlInInvoke,
    DsmlInParameter,
    DsmlWatchingInvokeEnd,
}
interface parsedToolCall {
    tool: string;
    parameters: string;
    start: number;
    raw: string;
}

export class ToolCallParser {
    /**
     * 将 DeepSeek Web 实际出现过的 DSML 标签变体归一化。
     *
     * 这里只修复标签本身，不修改参数内容，避免误伤 PowerShell、JSON、XML 等命令文本。
     */
    static normalizeDsmlMarkup(value: string): string {
        if (!value) return value;

        return value.replace(
            /<\s*(\/?)\s*(?:｜{0,2})?DSML(?:｜{0,2})?\s+(calls|invoke|parameter)\b([^>]*)>/g,
            (_full, slash: string, kind: string, attrs: string) =>
                `<${slash ? '/' : ''}｜｜DSML｜｜ ${kind}${attrs}>`
        );
    }

    // 一次性解析完整响应中的所有工具调用。
    // 这里是非流式解析入口：调用方必须先拿到 DeepSeek 的完整 RESPONSE 文本，
    // 再一次性提取工具调用，避免模型中途输出任何 wrapper 都影响 Codex 生命周期。
    static parseToolCalls(responseContent: string): parsedToolCall[] {
        const results: parsedToolCall[] = [];

        // 这里故意只对“完整 RESPONSE”做解析，不依赖流式状态。
        // DeepSeek Web 的外层包装经常变化，因此解析器只关注两种稳定结构：
        // 1. <wrapper>toolName<params>JSON</params>...</wrapper>
        // 2. DSML: <... invoke name="toolName"><... parameter name="x">value</... parameter>...</... invoke>
        // 外层 calls / tool_call / call_call 等标签全部只是包装，不参与生命周期控制。

        // ---------- A. 通用 tool + params ----------
        const paramsRe = /<params>\s*([\s\S]*?)\s*<\/params>/g;
        let paramsMatch: RegExpExecArray | null;
        let lastToolName = '';
        while ((paramsMatch = paramsRe.exec(responseContent))) {
            const paramsStart = paramsMatch.index;
            const prefixStart = Math.max(0, paramsStart - 1024);
            const prefix = responseContent.slice(prefixStart, paramsStart);

            // 优先寻找最近的“标签 + 工具名”。支持：
            // <tool_call>exec_command<params>...</params>
            // <call_call>exec_command<params>...</params>
            // <call_call><params>...</params>  （沿用上一次工具名）
            const explicit = prefix.match(/<([A-Za-z][A-Za-z0-9_.:-]*)>\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/);
            const paramsOnly = prefix.match(/<([A-Za-z][A-Za-z0-9_.:-]*)>\s*$/);

            let tool = '';
            let start = paramsStart;
            if (explicit) {
                tool = explicit[2];
                start = prefixStart + (explicit.index ?? 0);
            } else if (paramsOnly && lastToolName) {
                tool = lastToolName;
                start = prefixStart + (paramsOnly.index ?? 0);
            } else {
                // 也允许最普通的：toolName <params>...</params>
                const bare = prefix.match(/([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/);
                if (bare) {
                    tool = bare[1];
                    start = paramsStart - bare[0].length;
                }
            }

            if (!tool || /^(tool|call|params|arguments|function_call)$/i.test(tool)) continue;

            const parameters = tryParseParameters(paramsMatch[1]);
            if (parameters === null) continue;

            results.push({
                tool,
                parameters,
                start,
                raw: responseContent.slice(start, paramsRe.lastIndex),
            });
            lastToolName = tool;
        }

            // ---------- B. DSML invoke / parameter ----------
        // DeepSeek Web 的 DSML 标记并不稳定：实际可能出现
    // <｜｜DSML｜｜ ...>、<｜DSML｜｜ ...>、<｜DSML｜ ...>、<DSML｜｜ ...>
    // 甚至结束标签会变成 </DSML｜｜ calls>。
        // 这里先把“只损坏标签、结构仍可判断”的变体归一化，再做结构解析。
        // 不要求模型严格遵守某一种 DSML 拼写。
    const normalizedResponse = ToolCallParser.normalizeDsmlMarkup(responseContent);

        // 不要求外面存在 <calls>。只要完整响应中出现 invoke，就直接解析。
        // 同时兼容 DeepSeek 实际出现过的：
        //   <｜｜DSML｜｜ invoke ...>
        //   <｜DSML｜ invoke ...>
        // 以及空格差异。
        const dsmlInvokeOpen = /<\s*(?:｜｜DSML｜｜|｜DSML｜)\s*invoke\b([^>]*)>/g;
        const dsmlInvokeClose = /<\s*\/(?:｜｜DSML｜｜|｜DSML｜)\s*invoke\s*>/g;
        const dsmlParameterOpen = /<\s*(?:｜｜DSML｜｜|｜DSML｜)\s*parameter\b([^>]*)>/g;
        const dsmlParameterClose = /<\s*\/(?:｜｜DSML｜｜|｜DSML｜)\s*parameter\s*>/g;

        let invokeMatch: RegExpExecArray | null;
        while ((invokeMatch = dsmlInvokeOpen.exec(normalizedResponse))) {
            const tool = readXmlAttribute(invokeMatch[1], 'name')?.trim();
            if (!tool) continue;

            // 找这个 invoke 后面的第一个对应结束标签。因为这里已经拿到完整响应，
            // 不需要维护跨 chunk 状态；即使外面没有 calls 容器也一样工作。
            dsmlInvokeClose.lastIndex = invokeMatch.index + invokeMatch[0].length;
            const closeMatch = dsmlInvokeClose.exec(normalizedResponse);
            const bodyEnd = closeMatch?.index ?? normalizedResponse.length;
            const body = normalizedResponse.slice(invokeMatch.index + invokeMatch[0].length, bodyEnd);

            const parameters: Record<string, unknown> = {};
            dsmlParameterOpen.lastIndex = 0;
            let parameterMatch: RegExpExecArray | null;
            while ((parameterMatch = dsmlParameterOpen.exec(body))) {
                dsmlParameterClose.lastIndex = parameterMatch.index + parameterMatch[0].length;
                const parameterClose = dsmlParameterClose.exec(body);
                if (!parameterClose) break;

                const name = readXmlAttribute(parameterMatch[1], 'name');
                if (name) {
                    const isString = (readXmlAttribute(parameterMatch[1], 'string') ?? 'true').toLowerCase() === 'true';
                    const valueStart = parameterMatch.index + parameterMatch[0].length;
                    const value = body.slice(valueStart, parameterClose.index);
                    parameters[name] = parseDsmlParameterValue(value, isString);
                }

                dsmlParameterOpen.lastIndex = parameterClose.index + parameterClose[0].length;
            }

            results.push({
                tool,
                parameters: buildDsmlParameters(parameters),
                start: invokeMatch.index,
                raw: normalizedResponse.slice(invokeMatch.index, closeMatch ? closeMatch.index + closeMatch[0].length : bodyEnd),
            });
        }

        // ---------- C. DeepSeek 原生“直接工具标签” ----------
        // Web 端还会出现一种没有 invoke 的 DSML 形式，例如：
        // <｜｜DSML｜｜ apply_patch>
        // <｜｜DSML｜｜ parameter name="patch" string="true">...</｜｜DSML｜｜ parameter>
        // </｜｜DSML｜｜>
        // 这种格式同样是真实工具调用，不能因为没有 `invoke name=` 就漏掉。
        // 这里按“工具标签 + parameter 列表”解析，并允许尾部结束标签损坏/缺失。
        const directDsmlToolRe = /<\s*(?:｜｜DSML｜｜|｜DSML｜|DSML｜｜)\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*>/g;
        const directDsmlEndRe = /<\s*\/\s*(?:｜｜DSML｜｜|｜DSML｜|DSML｜｜)\s*>/g;
        let directToolMatch: RegExpExecArray | null;
        while ((directToolMatch = directDsmlToolRe.exec(normalizedResponse))) {
            const tool = directToolMatch[1].trim();
            if (!tool || /^(calls|invoke|parameter)$/i.test(tool)) continue;

            const bodyStart = directToolMatch.index + directToolMatch[0].length;
            directDsmlEndRe.lastIndex = bodyStart;
            const endMatch = directDsmlEndRe.exec(normalizedResponse);
            const bodyEnd = endMatch?.index ?? normalizedResponse.length;
            const body = normalizedResponse.slice(bodyStart, bodyEnd);

            const parameters: Record<string, unknown> = {};
            const directParameterOpen = /<\s*(?:｜｜DSML｜｜|｜DSML｜|DSML｜｜)\s+parameter\b([^>]*)>/g;
            const directParameterClose = /<\s*\/\s*(?:｜｜DSML｜｜|｜DSML｜|DSML｜｜)\s+parameter\s*>/g;
            let parameterMatch: RegExpExecArray | null;
            while ((parameterMatch = directParameterOpen.exec(body))) {
                directParameterClose.lastIndex = parameterMatch.index + parameterMatch[0].length;
                const parameterClose = directParameterClose.exec(body);
                if (!parameterClose) break;

                const name = readXmlAttribute(parameterMatch[1], 'name');
                if (name) {
                    const isString = (readXmlAttribute(parameterMatch[1], 'string') ?? 'true').toLowerCase() === 'true';
                    const valueStart = parameterMatch.index + parameterMatch[0].length;
                    const value = body.slice(valueStart, parameterClose.index);
                    parameters[name] = parseDsmlParameterValue(value, isString);
                }
                directParameterOpen.lastIndex = parameterClose.index + parameterClose[0].length;
            }

            if (Object.keys(parameters).length > 0) {
                results.push({
                    tool,
                    parameters: buildDsmlParameters(parameters),
                    start: directToolMatch.index,
                    raw: normalizedResponse.slice(directToolMatch.index, endMatch ? endMatch.index + endMatch[0].length : bodyEnd),
                });
            }
        }

        // ---------- D. function_call name="xxx" ----------
        const functionCallRe = /<function_call\b([^>]*)>\s*(?:<arguments>|<params>)\s*([\s\S]*?)\s*(?:<\/arguments>|<\/params>)\s*<\/function_call>/g;
        let functionCallMatch: RegExpExecArray | null;
        while ((functionCallMatch = functionCallRe.exec(responseContent))) {
            const tool = readXmlAttribute(functionCallMatch[1], 'name')?.trim();
            const parameters = tryParseParameters(functionCallMatch[2]);
            if (!tool || parameters === null) continue;
            results.push({
                tool,
                parameters,
                start: functionCallMatch.index,
                raw: functionCallMatch[0],
            });
        }

        // ---------- E. 未知协议自动结构推断 ----------
        // 到这里仍未被已知 parser 覆盖时，不中断；尝试从类 XML 结构中自动发现
        // action/tool/function/name + input/arguments/params 的新组合。
        // 这使 DeepSeek 换一种 wrapper 时不需要再次手工增加 parser。
        results.push(...parseUnknownStructuredToolCalls(responseContent));

        // 不同解析分支可能看到同一个调用。位置 + 工具 + 参数去重，再按原文位置排序。
        const unique = new Map<string, parsedToolCall>();
        for (const item of results) {
            const key = `${item.start}\0${item.tool}\0${item.parameters}`;
            if (!unique.has(key)) unique.set(key, item);
        }
        return [...unique.values()].sort((a, b) => a.start - b.start);
    }

    /** 从完整 RESPONSE 文本提取工具调用。 */
    static extractFromCompleteResponse(responseContent: string): parsedToolCall[] {
        return this.parseToolCalls(responseContent);
    }

    static shortCallParamLen = 200;
    static buildCallId(toolName: string, parameters: string): string {
        if (parameters.length > this.shortCallParamLen + 3) {
            parameters = parameters.slice(0, this.shortCallParamLen) + '...';
        }
        return `${canonicalBeginTag}${toolName}${paramsBeginTag}${parameters}${paramsEndTag}${canonicalEndTag}`;
    }

    private buffer = '';
    private name = '';
    private parameters = '';
    private state: ToolCallParseState = ToolCallParseState.Normal;
    private dsmlName = '';
    private dsmlParameters: Record<string, unknown> = {};
    private dsmlParameterName = '';
    private dsmlParameterIsString = true;
    private dsmlStandaloneInvoke = false;
    private suppressDuplicateEndTag = false;
    // 某些 Web Agent 调用后续 wrapper 不再重复工具名：<call_call><params>...</params>。
    // 记住最近一次成功解析的工具名，用于这种连续调用。
    private lastToolName = '';

    private findFirstDsmlInvoke(): { index: number; match: RegExpMatchArray } | null {
        const match = this.buffer.match(dsmlStandaloneInvokeBeginPattern);
        if (!match || match.index === undefined) return null;
        return { index: match.index, match };
    }

    private findFirstTag(tags: string[]): { index: number; tag: string } | null {
        let index = -1;
        let tag = '';
        for (const candidate of tags) {
            const candidateIndex = this.buffer.indexOf(candidate);
            if (candidateIndex >= 0 && (index < 0 || candidateIndex < index)) {
                index = candidateIndex;
                tag = candidate;
            }
        }
        return index < 0 ? null : { index, tag };
    }

    /**
     * 流式输出时，一个 DSML 标签经常会被拆到多个 chunk。
     * Normal 状态不能像普通文本一样把 buffer 尾部直接 flush 掉，否则
     * `<｜｜DSML｜｜ calls>` 可能被拆成 `<｜｜DSML｜｜ c` + `alls>`，前半段
     * 会先被当成普通文本发送给 Codex，后面的完整标签也就永远匹配不上了。
     *
     * 这里只保留“当前 buffer 尾部、且可能成为协议标签前缀”的部分；
     * 前面的确定性普通文本可以安全输出。
     */
    private flushNormalTextSafely(events: ToolCallDelta[]) {
        if (!this.buffer) return;

        const protocolTags = [
            ...beginTags,
            ...endTags,
            ...dsmlCallsBeginTags,
            '<｜DSML｜ calls>',
            '<｜｜DSML｜｜ calls>',
            '<｜DSML｜calls>',
            '<｜｜DSML｜｜calls>',
            '<｜DSML｜ invoke',
            '<｜｜DSML｜｜ invoke',
            '<｜DSML｜ parameter',
            '<｜｜DSML｜｜ parameter',
            '<call_exec>',
            '<call_call>',
            '<call_',
            '<function_call>',
            '<function_call',
            '</｜DSML｜ calls>',
            '</｜｜DSML｜｜ calls>',
            '</｜DSML｜ invoke>',
            '</｜｜DSML｜｜ invoke>',
            '</｜DSML｜ parameter>',
            '</｜｜DSML｜｜ parameter>',
        ];

        let keep = '';
        for (const tag of protocolTags) {
            const max = Math.min(tag.length, this.buffer.length);
            for (let len = 1; len <= max; len++) {
                const suffix = this.buffer.slice(-len);
                if (tag.startsWith(suffix) && suffix.length > keep.length) {
                    keep = suffix;
                }
            }
        }

        const flushLength = this.buffer.length - keep.length;
        if (flushLength > 0) {
            events.push({ type: 'text_delta', data: this.buffer.slice(0, flushLength) });
            this.buffer = this.buffer.slice(flushLength);
        }
    }

    private emitDsmlToolCall(events: ToolCallDelta[]) {
        if (!this.dsmlName) return;
        events.push({
            type: 'tool_call',
            data: {
                name: this.dsmlName,
                parameters: buildDsmlParameters(this.dsmlParameters),
            },
        });
        this.dsmlName = '';
        this.dsmlParameters = {};
        this.dsmlParameterName = '';
        this.dsmlParameterIsString = true;
        this.suppressDuplicateEndTag = true;
    }

    push(chunk: string): ToolCallDelta[] {
        if (chunk) this.buffer += chunk;
        const events: ToolCallDelta[] = [];

        while (true) {
            switch (this.state) {
                case ToolCallParseState.Normal: {
                    // 先处理 DeepSeek Web 明确的完整 wrapper。完整匹配后一次性消费，
                    // 不让后续的普通文本/增量解析器把 wrapper 内部内容打散。
                    const wrapped = parseExplicitWrappedToolCall(this.buffer, this.lastToolName);
                    if (wrapped) {
                        const textBefore = this.buffer.slice(0, wrapped.index);
                        if (textBefore) events.push({ type: 'text_delta', data: textBefore });
                        events.push({
                            type: 'tool_call',
                            data: { name: wrapped.tool, parameters: wrapped.parameters },
                        });
                        this.lastToolName = wrapped.tool;
                        this.buffer = this.buffer.slice(wrapped.index + wrapped.raw.length);
                        this.suppressDuplicateEndTag = true;
                        continue;
                    }

                    // 任意 <call_xxx> wrapper 都按结构处理；名称本身没有语义。
                    // 例如 <call_call><params>...</params></call>。
                    const genericWrapper = this.buffer.match(/<([A-Za-z][A-Za-z0-9_.:-]*)>/);
                    if (genericWrapper && genericWrapper.index === 0 && /^call(?:_|$)/i.test(genericWrapper[1])) {
                        this.buffer = this.buffer.slice(genericWrapper[0].length);
                        this.state = ToolCallParseState.InToolCall;
                        continue;
                    }

                    // 不要在进入 DSML 状态机前删除 DSML 标签.DeepSeek V4.1 的
                    // <｜｜DSML｜｜ calls/invoke/parameter> 本身就是合法的 tool-call 协议；
                    // 这里如果先 replace，会把完整的 DSML 调用清空，导致后续只能作为普通文本
                    // 返回给 Codex。由下面的 DSML 状态机统一消费这些标签。
                    const legacy = this.findFirstTag(beginTags);
                    const dsml = this.findFirstTag(dsmlCallsBeginTags);
                    const standaloneInvoke = this.findFirstDsmlInvoke();
                    const orphanEnd = this.findFirstTag(endTags);
                    const dsmlCallsEnd = this.buffer.match(dsmlCallsEndPattern);
                    const firstIndex = Math.min(
                        legacy?.index ?? Infinity,
                        dsml?.index ?? Infinity,
                        standaloneInvoke?.index ?? Infinity,
                        orphanEnd?.index ?? Infinity,
                        dsmlCallsEnd?.index ?? Infinity,
                    );
                    if (dsmlCallsEnd && dsmlCallsEnd.index === firstIndex &&
                        (!legacy || dsmlCallsEnd.index <= legacy.index) &&
                        (!dsml || dsmlCallsEnd.index <= dsml.index) &&
                        (!standaloneInvoke || dsmlCallsEnd.index <= standaloneInvoke.index) &&
                        (!orphanEnd || dsmlCallsEnd.index <= orphanEnd.index)) {
                        // 流式场景下，calls 开始标签和 invoke 可能跨 chunk，导致 invoke 被当成 standalone invoke 处理。
                        // 如果后续仍然收到 calls 的结束标签，它已经没有任何业务意义，不能把协议标签泄露给 Codex。
                        const textBefore = this.buffer.slice(0, dsmlCallsEnd.index);
                        if (textBefore.trim()) {
                            events.push({ type: 'text_delta', data: textBefore });
                        }
                        this.buffer = this.buffer.slice(dsmlCallsEnd.index + dsmlCallsEnd[0].length);
                        continue;
                    }
                    if (this.suppressDuplicateEndTag && orphanEnd && orphanEnd.index === firstIndex &&
                        (!legacy || orphanEnd.index <= legacy.index) &&
                        (!dsml || orphanEnd.index <= dsml.index) &&
                        (!standaloneInvoke || orphanEnd.index <= standaloneInvoke.index)) {
                        // DeepSeek 偶尔会在已经完成一次 tool_call 后重复输出
                        // </tool_call>（有时连续输出两个）。这是协议噪声，不能再作为普通文本返回给 Codex。
                        const textBefore = this.buffer.slice(0, orphanEnd.index);
                        if (textBefore.trim()) {
                            events.push({ type: 'text_delta', data: textBefore });
                            this.suppressDuplicateEndTag = false;
                        }
                        this.buffer = this.buffer.slice(orphanEnd.index + orphanEnd.tag.length);
                        continue;
                    }
                    if (firstIndex !== Infinity && (!orphanEnd || orphanEnd.index !== firstIndex)) {
                        this.suppressDuplicateEndTag = false;
                    }
                    if (firstIndex === Infinity) {
                        // 不要按固定长度直接截断。协议标签可能跨 chunk，必须保留
                        // 尾部可能是 DSML/tool-call 标签前缀的字符。
                        this.flushNormalTextSafely(events);
                        break;
                    }
                    if (standaloneInvoke && standaloneInvoke.index === firstIndex && (!dsml || standaloneInvoke.index < dsml.index)) {
                        const textBefore = this.buffer.slice(0, standaloneInvoke.index);
                        if (textBefore) events.push({ type: 'text_delta', data: textBefore });
                        this.dsmlName = readXmlAttribute(standaloneInvoke.match[1], 'name')?.trim() ?? '';
                        this.buffer = this.buffer.slice(standaloneInvoke.index + standaloneInvoke.match[0].length);
                        this.dsmlStandaloneInvoke = true;
                        this.suppressDuplicateEndTag = false;
                        this.state = ToolCallParseState.DsmlInInvoke;
                        continue;
                    }
                    const first = legacy && legacy.index === firstIndex ? legacy : dsml;
                    if (!first) break;
                    if (first.tag === (dsml?.tag ?? '')) {
                        const textBefore = this.buffer.slice(0, first.index);
                        if (textBefore) events.push({ type: 'text_delta', data: textBefore });
                        this.buffer = this.buffer.slice(first.index + first.tag.length);
                        this.dsmlStandaloneInvoke = false;
                        this.suppressDuplicateEndTag = false;
                        this.state = ToolCallParseState.DsmlInCalls;
                        continue;
                    }
                    const textBefore = this.buffer.slice(0, first.index);
                    if (textBefore) events.push({ type: 'text_delta', data: textBefore });
                    this.buffer = this.buffer.slice(first.index + first.tag.length);
                    this.suppressDuplicateEndTag = false;
                    this.state = ToolCallParseState.InToolCall;
                    continue;
                }

                case ToolCallParseState.InToolCall: {
                    // DeepSeek/Web 链路还可能使用 <call_exec>tool<params>...</params></call>
                    // 这种包装格式。进入 InToolCall 后按原有 <params> 逻辑解析即可。
                    // DeepSeek 有时会把 DSML calls 再包一层 <tool_call>。
                    // 例如：<tool_call>\n<｜｜DSML｜｜ calls>...。
                    // 这种情况下不能继续等待 <params>，否则整个 DSML 调用会被当成普通参数文本。
                    const dsmlCalls = this.buffer.match(dsmlCallsBeginPattern);
                    const paramsIndex = this.buffer.indexOf(paramsBeginTag);
                    const jsonIndex = this.buffer.indexOf(paramsBeginTag2);
                    const dsmlIndex = dsmlCalls?.index ?? -1;
                    if (dsmlIndex >= 0 && (paramsIndex < 0 || dsmlIndex < paramsIndex) &&
                        (jsonIndex < 0 || dsmlIndex < jsonIndex)) {
                        this.buffer = this.buffer.slice(dsmlIndex + dsmlCalls[0].length);
                        this.dsmlStandaloneInvoke = false;
                        this.state = ToolCallParseState.DsmlInCalls;
                        continue;
                    }

                    let len = paramsBeginTag.length;
                    let i = paramsIndex;
                    if (i < 0) {
                        i = jsonIndex;
                        if (i < 0) break;
                        len = paramsBeginTag2.length;
                        i -= len;
                    }
                    this.state = ToolCallParseState.InParams;
                    const parsedName = this.buffer.slice(0, i).trim();
                    const toolName = this.name = parsedName || this.lastToolName;
                    if (!toolName) break;
                    this.lastToolName = toolName;
                    events.push({ type: 'tool_call_name', data: toolName });
                    this.buffer = this.buffer.slice(i + len);
                    continue;
                }

                case ToolCallParseState.InParams: {
                    let i = this.buffer.indexOf(paramsEndTag);
                    if (i < 0) {
                        const end = this.findFirstTag(endTags);
                        if (!end) {
                            if (this.buffer.length >= maxClosingTagLength) {
                                const paramsDeltaEndIndex = this.buffer.length - maxClosingTagLength + 1;
                                const paramsDelta = this.buffer.slice(0, paramsDeltaEndIndex);
                                events.push({ type: 'tool_call_parameters_delta', data: paramsDelta });
                                this.buffer = this.buffer.slice(paramsDeltaEndIndex);
                                this.parameters += paramsDelta;
                            }
                            break;
                        }
                        i = end.index;
                    } else {
                        this.parameters = safeJsonRepair(this.parameters + this.buffer.slice(0, i)).trim();
                        events.push({ type: 'tool_call', data: { name: this.name, parameters: this.parameters } });
                        this.suppressDuplicateEndTag = true;
                        this.name = this.parameters = '';
                        this.buffer = this.buffer.slice(i + paramsEndTag.length);
                        this.state = ToolCallParseState.WatchingEndTag;
                        continue;
                    }
                    this.state = ToolCallParseState.WatchingEndTag;
                    continue;
                }

                case ToolCallParseState.WatchingEndTag: {
                    const end = this.findFirstTag(endTags);
                    if (!end) break;
                    if (this.name) {
                        this.parameters = safeJsonRepair(this.parameters + this.buffer.slice(0, end.index)).trim();
                        events.push({ type: 'tool_call', data: { name: this.name, parameters: this.parameters } });
                        this.suppressDuplicateEndTag = true;
                        this.name = this.parameters = '';
                    }
                    this.buffer = this.buffer.slice(end.index + end.tag.length);
                    this.state = ToolCallParseState.Normal;
                    continue;
                }

                case ToolCallParseState.DsmlInCalls: {
                    // DeepSeek 有时把标准 <tool_call>...</tool_call> 再包在
                    // <｜｜DSML｜｜ calls>...</｜｜DSML｜｜ calls> 容器里面。
                    // 这种情况下，里面的 <tool_call> 本身就是完整的结构化调用，
                    // 不应该继续等待 DSML <invoke>。否则流式解析会卡在 DsmlInCalls，
                    // 导致第一个/后续 tool_call 被当成普通协议内容而中断。
                    const nestedWrapped = parseExplicitWrappedToolCall(this.buffer, this.lastToolName);
                    if (nestedWrapped) {
                        const textBefore = this.buffer.slice(0, nestedWrapped.index);
                        if (textBefore.trim()) {
                            events.push({ type: 'text_delta', data: textBefore });
                        }
                        events.push({
                            type: 'tool_call',
                            data: { name: nestedWrapped.tool, parameters: nestedWrapped.parameters },
                        });
                        this.lastToolName = nestedWrapped.tool;
                        this.buffer = this.buffer.slice(nestedWrapped.index + nestedWrapped.raw.length);
                        this.suppressDuplicateEndTag = true;
                        // 仍然处于 DSML calls 容器中，继续扫描下一个调用。
                        continue;
                    }

                    const invoke = this.buffer.match(dsmlInvokeBeginPattern);
                    const callsEnd = this.buffer.match(dsmlCallsEndPattern);
                    if (callsEnd && (invoke === null || (callsEnd.index ?? Infinity) < (invoke.index ?? Infinity))) {
                        this.buffer = this.buffer.slice((callsEnd.index ?? 0) + callsEnd[0].length);
                        this.state = ToolCallParseState.Normal;
                        // DSML calls 可能嵌套在 <tool_call>...</tool_call> 中。
                        // 完成 DSML 后，外层结束标签只是包装层，不应泄露给 Codex。
                        this.suppressDuplicateEndTag = true;
                        continue;
                    }
                    if (!invoke || invoke.index === undefined) {
                        if (this.buffer.length >= maxBeginTagLength) {
                            // DSML 内部标签也可能跨 chunk，保留尾部。
                            const keep = Math.max(maxBeginTagLength, 32);
                            const flush = this.buffer.length - keep + 1;
                            if (flush > 0) {
                                // DSML 尚未完整解析，不能把标签碎片输出给客户端；这里只保留整个 buffer。
                                // 只有明显不是标签的前导空白才丢弃。
                                if (/^\s+$/.test(this.buffer.slice(0, flush))) {
                                    this.buffer = this.buffer.slice(flush);
                                }
                            }
                        }
                        break;
                    }
                    this.dsmlName = readXmlAttribute(invoke[1], 'name')?.trim() ?? '';
                    this.buffer = this.buffer.slice(invoke.index + invoke[0].length);
                    this.state = ToolCallParseState.DsmlInInvoke;
                    continue;
                }

                case ToolCallParseState.DsmlInInvoke: {
                    const parameter = this.buffer.match(dsmlParameterBeginPattern);
                    const invokeEnd = this.buffer.match(dsmlInvokeEndPattern);
                    if (invokeEnd && (parameter === null || (invokeEnd.index ?? Infinity) < (parameter.index ?? Infinity))) {
                        this.emitDsmlToolCall(events);
                        this.buffer = this.buffer.slice((invokeEnd.index ?? 0) + invokeEnd[0].length);
                        this.state = this.dsmlStandaloneInvoke ? ToolCallParseState.Normal : ToolCallParseState.DsmlInCalls;
                        this.dsmlStandaloneInvoke = false;
                        continue;
                    }
                    if (!parameter || parameter.index === undefined) break;
                    this.dsmlParameterName = readXmlAttribute(parameter[1], 'name')?.trim() ?? '';
                    this.dsmlParameterIsString = (readXmlAttribute(parameter[1], 'string') ?? 'true').toLowerCase() === 'true';
                    this.buffer = this.buffer.slice(parameter.index + parameter[0].length);
                    this.state = ToolCallParseState.DsmlInParameter;
                    continue;
                }

                case ToolCallParseState.DsmlInParameter: {
                    const end = this.buffer.match(dsmlParameterEndPattern);
                    // 容错：有些响应漏掉当前 parameter 的结束标签，却直接开始下一个
                    // parameter，或者结束 invoke/calls。把这些标签视为隐式边界，避免
                    // 后续 workdir/yield_time_ms 等参数被拼进 cmd。
                    const nextBoundaryPattern = /<\s*\/?\s*(?:｜{0,2})DSML(?:｜{0,2})\s+(?:parameter|invoke|calls)\b[^>]*>/i;
                    const nextBoundary = nextBoundaryPattern.exec(this.buffer);
                    const endIndex = end?.index !== undefined && (!nextBoundary || end.index <= nextBoundary.index)
                        ? end.index
                        : nextBoundary?.index;
                    if (endIndex === undefined) break;
                    const value = this.buffer.slice(0, endIndex);
                    if (this.dsmlParameterName) {
                        this.dsmlParameters[this.dsmlParameterName] = parseDsmlParameterValue(value, this.dsmlParameterIsString);
                    }
                    const consumedLength = end?.index === endIndex ? endIndex + end[0].length : endIndex;
                    this.buffer = this.buffer.slice(consumedLength);
                    this.state = ToolCallParseState.DsmlInInvoke;
                    continue;
                }

                case ToolCallParseState.DsmlWatchingInvokeEnd:
                    this.state = ToolCallParseState.DsmlInInvoke;
                    continue;
            }
            break;
        }
        return events;
    }

    /**
     * Flush all pending events at end-of-stream.
     *
     * A response can contain more than one tool call.  Do not expose only the
     * first pending event to the caller: drain the parser and return every
     * complete tool call that can still be recovered from the final buffer.
     */
    finishAll(): ToolCallDelta[] {
        const events: ToolCallDelta[] = [];

        // First let the normal streaming state machine consume anything that
        // became complete only with the final chunk.
        if (this.buffer) {
            const pushed = this.push('');
            events.push(...pushed);
        }

        switch (this.state) {
            case ToolCallParseState.Normal:
                if (this.buffer) {
                    events.push({ type: 'text_delta', data: this.buffer });
                    this.buffer = '';
                }
                break;

            case ToolCallParseState.InToolCall:
            case ToolCallParseState.WatchingEndTag:
                if (this.name) {
                    this.parameters = safeJsonRepair(this.parameters + this.buffer).trim();
                    events.push({ type: 'tool_call', data: { name: this.name, parameters: this.parameters } });
                    this.name = '';
                    this.parameters = '';
                    this.buffer = '';
                } else if (this.buffer) {
                    events.push({ type: 'text_delta', data: this.buffer });
                    this.buffer = '';
                }
                this.state = ToolCallParseState.Normal;
                break;

            case ToolCallParseState.InParams:
                this.parameters = safeJsonRepair(this.parameters + this.buffer).trim();
                if (this.name) {
                    events.push({ type: 'tool_call', data: { name: this.name, parameters: this.parameters } });
                }
                this.name = '';
                this.parameters = '';
                this.buffer = '';
                this.state = ToolCallParseState.Normal;
                break;

            case ToolCallParseState.DsmlInParameter:
                if (this.dsmlParameterName) {
                    this.dsmlParameters[this.dsmlParameterName] =
                        parseDsmlParameterValue(this.buffer, this.dsmlParameterIsString);
                }
                if (this.dsmlName) {
                    events.push({
                        type: 'tool_call',
                        data: {
                            name: this.dsmlName,
                            parameters: buildDsmlParameters(this.dsmlParameters),
                        },
                    });
                }
                this.dsmlName = '';
                this.dsmlParameters = {};
                this.dsmlParameterName = '';
                this.dsmlStandaloneInvoke = false;
                this.buffer = '';
                this.state = ToolCallParseState.Normal;
                break;

            case ToolCallParseState.DsmlInInvoke:
            case ToolCallParseState.DsmlWatchingInvokeEnd:
                if (this.dsmlName) {
                    events.push({
                        type: 'tool_call',
                        data: {
                            name: this.dsmlName,
                            parameters: buildDsmlParameters(this.dsmlParameters),
                        },
                    });
                }
                this.dsmlName = '';
                this.dsmlParameters = {};
                this.dsmlParameterName = '';
                this.dsmlStandaloneInvoke = false;
                this.buffer = '';
                this.state = ToolCallParseState.Normal;
                break;

            case ToolCallParseState.DsmlInCalls:
                // An incomplete <calls> block is not safe to execute. Drop it.
                this.buffer = '';
                break;
        }

        return events;
    }

    /**
     * Backwards-compatible single-event API.
     * New stream handlers should use finishAll().
     */
    finish(): ToolCallDelta | null {
        return this.finishAll()[0] ?? null;
    }
}
