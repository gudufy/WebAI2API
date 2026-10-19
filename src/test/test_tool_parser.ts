import { ToolCallParser, buildToolPrompt } from '../server/toolPrompt.js';

function assertCall(input: string, expectedTool: string, expected: Record<string, unknown>) {
    const calls = ToolCallParser.parseToolCalls(input);
    if (calls.length !== 1) throw new Error(`expected 1 call, got ${calls.length}: ${input}`);
    if (calls[0].tool !== expectedTool) throw new Error(`tool mismatch: ${calls[0].tool}`);
    const actual = JSON.parse(calls[0].parameters);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`params mismatch: ${calls[0].parameters}`);
    }
}

assertCall('<tool_call>exec_command<params>{"cmd":"git status","workdir":"D:\\\\kingda\\\\wsx"}</params></tool_call>', 'exec_command', {
    cmd: 'git status', workdir: 'D:\\kingda\\wsx'
});

assertCall('<call_exec>exec_command<params>{"cmd":"git status"}</params></call>', 'exec_command', {
    cmd: 'git status'
});

assertCall('<call_call>exec_command<params>{"cmd":"git status"}</params></call>', 'exec_command', {
    cmd: 'git status'
});

assertCall('<call_anything>exec_command<params>{"timeout_ms":60000</｜｜DSML｜｜ parameter>}</params></call>', 'exec_command', {
    timeout_ms: 60000
});

const multi = ToolCallParser.parseToolCalls(
    '<call_exec>exec_command<params>{"cmd":"one"}</params></call>' +
    '<call_call>exec_command<params>{"cmd":"two"}</params></call>'
);
if (multi.length !== 2) throw new Error(`expected 2 calls, got ${multi.length}`);

const parser = new ToolCallParser();
const chunks = [
    '<call_ex', 'ec>exec_command<pa', 'rams>{"cmd":"git ', 'status"}</params>', '</call>'
];
const events = chunks.flatMap(x => parser.push(x));
events.push(...parser.finishAll());
const streamed = events.filter(x => x.type === 'tool_call');
if (streamed.length !== 1 || streamed[0].type !== 'tool_call' || streamed[0].data.name !== 'exec_command') {
    throw new Error(`stream parse failed: ${JSON.stringify(events)}`);
}


// v17：未知 wrapper 不应要求预先知道协议；自动从结构中发现工具名和参数。
const unknownStructured = `<something>
  <action>exec_command</action>
  <input>
    <cmd>Get-ChildItem -LiteralPath 'D:\\kingda\\wsx'</cmd>
    <workdir>D:\\kingda\\wsx</workdir>
    <yield_time_ms>10000</yield_time_ms>
  </input>
</something>`;
const unknownCalls = ToolCallParser.extractFromCompleteResponse(unknownStructured);
if (unknownCalls.length !== 1) throw new Error(`v17 unknown wrapper parse failed: ${JSON.stringify(unknownCalls)}`);
if (unknownCalls[0].tool !== 'exec_command') throw new Error(`v17 tool inference failed: ${JSON.stringify(unknownCalls[0])}`);
const unknownArgs = JSON.parse(unknownCalls[0].parameters);
if (unknownArgs.cmd !== `Get-ChildItem -LiteralPath 'D:\\kingda\\wsx'`) throw new Error(`v17 cmd inference failed: ${JSON.stringify(unknownArgs)}`);
if (unknownArgs.workdir !== 'D:\\kingda\\wsx') throw new Error(`v17 workdir inference failed: ${JSON.stringify(unknownArgs)}`);

// v17：工具名也可能通过 action/tool/function 的 name 属性提供。
const attributeToolWrapper = `<something><action name="exec_command"><arguments>{"cmd":"git status"}</arguments></action></something>`;
const attributeToolCalls = ToolCallParser.extractFromCompleteResponse(attributeToolWrapper);
if (attributeToolCalls.length !== 1 || attributeToolCalls[0].tool !== 'exec_command') {
    throw new Error(`v17 attribute tool inference failed: ${JSON.stringify(attributeToolCalls)}`);
}

// v17：工具名也可能直接成为 wrapper 名称。
const unknownToolWrapper = `<exec_command><input><cmd>git status</cmd><workdir>D:\\kingda\\wsx</workdir></input></exec_command>`;
const unknownToolCalls = ToolCallParser.extractFromCompleteResponse(unknownToolWrapper);
if (unknownToolCalls.length !== 1 || unknownToolCalls[0].tool !== 'exec_command') {
    throw new Error(`v17 direct tool wrapper parse failed: ${JSON.stringify(unknownToolCalls)}`);
}

console.log('tool parser tests passed');


const chained = ToolCallParser.parseToolCalls(
    '<tool_tool>\nexec_command\n<params>{"cmd":"one"}</params>\n</tool_tool>\n' +
    '继续追加连接和 DI 注册。\n' +
    '<call_call>\n<params>{"cmd":"two","workdir":"D:\\\kingda\\wsx","yield_time_ms":10000}</params>\n</call_call>'
);
if (chained.length !== 2) throw new Error(`expected 2 chained calls, got ${chained.length}: ${JSON.stringify(chained)}`);
if (chained[0].tool !== 'exec_command' || chained[1].tool !== 'exec_command') {
    throw new Error(`expected inherited exec_command, got ${JSON.stringify(chained)}`);
}

const chainedStream = new ToolCallParser();
const chainedChunks = [
    '<tool_tool>exec_command<params>{"cmd":"one"}</params></tool_tool>继续追加连接和 DI 注册。',
    '<call_call><params>{"cmd":"two"}</params></call_call>'
];
const chainedEvents = chainedChunks.flatMap(x => chainedStream.push(x));
chainedEvents.push(...chainedStream.finishAll());
const chainedCalls = chainedEvents.filter(x => x.type === 'tool_call');
if (chainedCalls.length !== 2) throw new Error(`expected 2 streamed chained calls, got ${chainedCalls.length}: ${JSON.stringify(chainedEvents)}`);
if (chainedCalls.some(x => x.type === 'tool_call' && x.data.name !== 'exec_command')) {
    throw new Error(`stream inherited tool failed: ${JSON.stringify(chainedCalls)}`);
}

// DSML calls 容器里嵌套多个 <tool_call>：必须全部解析，不能在第一个后中断。
const nestedDsml = `<｜｜DSML｜｜ calls>
<tool_call>
exec_command
<params>{"cmd":"one"}</params>
</tool_call>
<tool_call>
exec_command
<params>{"cmd":"two"}</params>
</tool_call>
<tool_call>
exec_command
<params>{"cmd":"three"}</params>
</tool_call>
</｜｜DSML｜｜ calls>`;
const nestedDsmlCalls = ToolCallParser.parseToolCalls(nestedDsml);
if (nestedDsmlCalls.length !== 3) throw new Error(`expected 3 nested DSML calls, got ${nestedDsmlCalls.length}: ${JSON.stringify(nestedDsmlCalls)}`);

const nestedDsmlStream = new ToolCallParser();
const nestedDsmlChunks = [
    '<｜｜DSML｜｜ calls>\n<tool_call>\nexec_command\n<params>{"cmd":"one"}</params>\n</tool_call>\n',
    '<tool_call>\nexec_command\n<params>{"cmd":"two"}</params>\n</tool_call>\n',
    '<tool_call>\nexec_command\n<params>{"cmd":"three"}</params>\n</tool_call>\n</｜｜DSML｜｜ calls>',
];
const nestedDsmlEvents = nestedDsmlChunks.flatMap(x => nestedDsmlStream.push(x));
nestedDsmlEvents.push(...nestedDsmlStream.finishAll());
const nestedDsmlStreamCalls = nestedDsmlEvents.filter(x => x.type === 'tool_call');
if (nestedDsmlStreamCalls.length !== 3) throw new Error(`expected 3 streamed nested DSML calls, got ${nestedDsmlStreamCalls.length}: ${JSON.stringify(nestedDsmlEvents)}`);


// v11：完整响应收集后一次性提取，不依赖流式 chunk 边界。
const completeDeepseekResponse = `<｜｜DSML｜｜ calls>
<tool_call>
exec_command
<params>
{"cmd":"one","workdir":"D:\\\\kingda\\\\wsx","yield_time_ms":10000}
</params>
</tool_call>
<tool_call>
exec_command
<params>
{"cmd":"two","workdir":"D:\\\\kingda\\\\wsx","yield_time_ms":10000}
</params>
</tool_call>
<tool_call>
exec_command
<params>
{"cmd":"three","workdir":"D:\\\\kingda\\\\wsx","yield_time_ms":10000}
</params>
</tool_call>
<tool_call>
exec_command
<params>
{"cmd":"four","workdir":"D:\\\\kingda\\\\wsx","yield_time_ms":10000}
</params>
</tool_call>
<tool_call>
exec_command
<params>
{"cmd":"five","workdir":"D:\\\\kingda\\\\wsx","yield_time_ms":10000}
</params>
</tool_call>
</｜｜DSML｜｜ calls>
</tool_call>`;
const completeCalls = ToolCallParser.extractFromCompleteResponse(completeDeepseekResponse);
assert.equal(completeCalls.length, 5);
assert.deepEqual(completeCalls.map(x => x.tool), [
    'exec_command', 'exec_command', 'exec_command', 'exec_command', 'exec_command'
]);
assert.deepEqual(completeCalls.map(x => JSON.parse(x.parameters).cmd), [
    'one', 'two', 'three', 'four', 'five'
]);

const chainedCompleteResponse = `<tool_tool>
exec_command
<params>{"cmd":"one"}</params>
</tool_tool>
继续追加连接和 DI 注册。
<call_call>
<params>{"cmd":"two","workdir":"D:\\\\kingda\\\\wsx","yield_time_ms":10000}</params>
</call_call>`;
const chainedCompleteCalls = ToolCallParser.extractFromCompleteResponse(chainedCompleteResponse);
assert.equal(chainedCompleteCalls.length, 2);
assert.deepEqual(chainedCompleteCalls.map(x => JSON.parse(x.parameters).cmd), ['one', 'two']);

// v12：DeepSeek 原生 DSML invoke/parameter 完整响应，外层 calls 不是必需条件。
const pureDsmlCompleteResponse = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="exec_command">
<｜｜DSML｜｜ parameter name="cmd" string="true">Get-Content D:\\yyq\\EasyAdminBlazor\\Extensions\\EasyAdminBlazor.Cms\\Infrastructure\\CmsDataService.cs | Select-Object -First 130</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="justification" string="true"></｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="login" string="false">true</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="max_output_tokens" string="false">20000</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="prefix_rule" string="false">[]</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="sandbox_permissions" string="true">use_default</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="shell" string="true">powershell</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="tty" string="false">false</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="workdir" string="true">D:\\kingda\\wsx</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="yield_time_ms" string="false">10000</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ invoke name="exec_command">
<｜｜DSML｜｜ parameter name="cmd" string="true">Get-Content D:\\kingda\\EasyAdminBlazor.ElectronicComponent\\Components\\Pages\\Home.razor -Encoding UTF8 | Select-Object -First 25</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="login" string="false">true</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="workdir" string="true">D:\\kingda\\wsx</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="yield_time_ms" string="false">10000</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
const pureDsmlCalls = ToolCallParser.extractFromCompleteResponse(pureDsmlCompleteResponse);
assert.equal(pureDsmlCalls.length, 2);
assert.deepEqual(pureDsmlCalls.map(x => x.tool), ['exec_command', 'exec_command']);
assert.equal(JSON.parse(pureDsmlCalls[0].parameters).login, true);
assert.equal(JSON.parse(pureDsmlCalls[0].parameters).max_output_tokens, 20000);
assert.equal(JSON.parse(pureDsmlCalls[1].parameters).workdir, 'D:\\kingda\\wsx');

// v15：主提示恢复 <tool_call>，DSML 仅作为兼容解析。
const v15Prompt = buildToolPrompt('auto', [{
    name: 'exec_command',
    description: 'execute a command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
}]);
if (!v15Prompt.includes('<tool_call>tool_name<params>')) throw new Error('v15 prompt must use the legacy-compatible tool_call format');
if (v15Prompt.includes('use ONLY this format:')) { /* expected compatibility prompt */ }

// v14：DSML 标签损坏/变体也必须归一化后解析。
const dsmlVariants = [
    `<｜DSML｜｜ calls><｜DSML｜｜ invoke name="exec_command"><｜DSML｜｜ parameter name="cmd" string="true">Get-ChildItem</｜DSML｜｜ parameter><｜DSML｜｜ parameter name="workdir" string="true">D:\\kingda\\wsx</｜DSML｜｜ parameter></｜DSML｜｜ invoke></DSML｜｜ calls>`,
    `<｜DSML｜ invoke name="exec_command"><｜DSML｜ parameter name="cmd" string="true">Get-ChildItem</｜DSML｜ parameter></｜DSML｜ invoke>`,
    `<DSML｜｜ invoke name="exec_command"><DSML｜｜ parameter name="cmd" string="true">Get-ChildItem</DSML｜｜ parameter></DSML｜｜ invoke>`,
    `</DSML｜｜ calls><｜｜DSML｜｜ invoke name="exec_command"><｜｜DSML｜｜ parameter name="cmd" string="true">Get-ChildItem</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`,
];
for (const input of dsmlVariants) {
    const calls = ToolCallParser.extractFromCompleteResponse(input);
    if (calls.length !== 1) throw new Error(`DSML variant parse failed: ${input}: ${JSON.stringify(calls)}`);
    const args = JSON.parse(calls[0].parameters);
    if (calls[0].tool !== 'exec_command' || args.cmd !== 'Get-ChildItem') {
        throw new Error(`DSML variant values failed: ${JSON.stringify(calls)}`);
    }
}


// v16：DeepSeek Web 还会直接输出“DSML 工具名 + parameter”，没有 invoke：
// <｜｜DSML｜｜ apply_patch>
//   <｜｜DSML｜｜ parameter name="patch" string="true">...</｜｜DSML｜｜ parameter>
// </｜｜DSML｜｜>
// 这种情况必须被识别为 apply_patch，而不是漏掉整个工具调用。
const directDsmlApplyPatch = `刚才的补丁还没完成；我继续补齐 CMS 写方法和差异摘要，随后统一编译检查。

<｜｜DSML｜｜ apply_patch>
<｜｜DSML｜｜ parameter name="patch" string="true">*** Begin Patch
*** Update File: D:\\yyq\\EasyAdminBlazor\\Extensions\\EasyAdminBlazor.Cms\\Infrastructure\\CmsDataService.cs
@@
-    public async Task Delete(long id)
+    [OperationLog("删除CMS内容")]
+    public async Task Delete(long id)
@@
*** End Patch
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜>
</｜｜DSML｜｜ calls>`;
const directDsmlCalls = ToolCallParser.extractFromCompleteResponse(directDsmlApplyPatch);
assert.equal(directDsmlCalls.length, 1);
assert.equal(directDsmlCalls[0].tool, 'apply_patch');
assert.ok(JSON.parse(directDsmlCalls[0].parameters).patch.includes('Begin Patch'));

// v18：DSML 参数边界损坏时，不能把下一个参数或结束标签拼进 cmd/workdir。
const brokenDsmlBoundary = new ToolCallParser();
const brokenDsmlText = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="exec_command"><｜｜DSML｜｜ parameter name="cmd" string="true">git status<｜｜DSML｜｜ parameter name="workdir" string="true">D:\\yyq\\EasyAdminBlazorSite</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;
const brokenDsmlEvents = brokenDsmlBoundary.push(brokenDsmlText);
brokenDsmlEvents.push(...brokenDsmlBoundary.finishAll());
const brokenDsmlCalls = brokenDsmlEvents.filter(x => x.type === 'tool_call');
if (brokenDsmlCalls.length !== 1 || brokenDsmlCalls[0].type !== 'tool_call') {
    throw new Error(`v18 broken DSML boundary should recover one call: ${JSON.stringify(brokenDsmlEvents)}`);
}
const brokenDsmlArgs = JSON.parse(brokenDsmlCalls[0].data.parameters);
if (brokenDsmlArgs.cmd !== 'git status') {
    throw new Error(`v18 command was contaminated by next parameter: ${JSON.stringify(brokenDsmlArgs)}`);
}
if (brokenDsmlArgs.workdir !== 'D:\\yyq\\EasyAdminBlazorSite') {
    throw new Error(`v18 workdir was not recovered: ${JSON.stringify(brokenDsmlArgs)}`);
}

// v18：如果模型错误地把下一个参数写成“带属性的结束标签”，也必须截断 cmd，
// 绝不能把协议残片和工作目录拼成一条 shell 命令。
const brokenCloseDsml = new ToolCallParser();
const brokenCloseText = `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="exec_command"><｜｜DSML｜｜ parameter name="cmd" string="true">git diff</｜｜DSML｜｜ parameter name="workdir" string="true">D:\\yyq\\EasyAdminBlazorSite</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`;
const brokenCloseEvents = brokenCloseDsml.push(brokenCloseText);
brokenCloseEvents.push(...brokenCloseDsml.finishAll());
const brokenCloseCalls = brokenCloseEvents.filter(x => x.type === 'tool_call');
if (brokenCloseCalls.length !== 1 || brokenCloseCalls[0].type !== 'tool_call') {
    throw new Error(`v18 malformed close should recover one call: ${JSON.stringify(brokenCloseEvents)}`);
}
const brokenCloseArgs = JSON.parse(brokenCloseCalls[0].data.parameters);
if (String(brokenCloseArgs.cmd).includes('DSML') || String(brokenCloseArgs.cmd).includes('EasyAdminBlazorSite')) {
    throw new Error(`v18 malformed protocol leaked into command: ${JSON.stringify(brokenCloseArgs)}`);
}
