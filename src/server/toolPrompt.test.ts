import assert from "node:assert/strict";
import test from "node:test";
import { ToolCallParser, validateToolCallArguments, type ToolDescription } from "./toolPrompt.js";

const tools: ToolDescription[] = [{
    name: "exec_command",
    parameters: {
        type: "object",
        properties: {
            cmd: { type: "string" },
            max_output_tokens: { type: "integer" },
        },
        required: ["cmd"],
        additionalProperties: false,
    },
}];

test("accepts valid arguments matching the declared schema", () => {
    assert.equal(validateToolCallArguments("exec_command", JSON.stringify({
        cmd: "pwd",
        max_output_tokens: 3000,
    }), tools), true);
});

test("rejects a missing required argument", () => {
    assert.equal(validateToolCallArguments("exec_command", JSON.stringify({
        max_output_tokens: 3000,
    }), tools), false);
});

test("rejects a string where an integer is required", () => {
    assert.equal(validateToolCallArguments("exec_command", JSON.stringify({
        cmd: "pwd",
        max_output_tokens: "3000</｜｜DSML｜｜>",
    }), tools), false);
});

test("rejects undeclared tools and additional properties", () => {
    assert.equal(validateToolCallArguments("unknown_tool", "{}", tools), false);
    assert.equal(validateToolCallArguments("exec_command", JSON.stringify({
        cmd: "pwd",
        unexpected: true,
    }), tools), false);
});

test("rejects malformed JSON and non-object arguments", () => {
    assert.equal(validateToolCallArguments("exec_command", "{", tools), false);
    assert.equal(validateToolCallArguments("exec_command", "[]", tools), false);
});


test("parses multiple DSML invokes from a complete response", () => {
    const response = [
        "Checking the repository.",
        "<｜｜DSML｜｜ calls>",
        '<｜｜DSML｜｜ invoke name="exec_command">',
        '<｜｜DSML｜｜ parameter name="cmd" string="true">pwd</｜｜DSML｜｜ parameter>',
        "</｜｜DSML｜｜ invoke>",
        '<｜｜DSML｜｜ invoke name="exec_command">',
        '<｜｜DSML｜｜ parameter name="cmd" string="true">git status --short</｜｜DSML｜｜ parameter>',
        "</｜｜DSML｜｜ invoke>",
        "</｜｜DSML｜｜ calls>",
    ].join("\n");

    const calls = ToolCallParser.extractFromCompleteResponse(response, tools);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[0].parameters).cmd, "pwd");
    assert.equal(JSON.parse(calls[1].parameters).cmd, "git status --short");

    const outsideCalls = response.slice(0, calls[0].start)
        + response.slice(calls[0].start + calls[0].raw.length, calls[1].start)
        + response.slice(calls[1].start + calls[1].raw.length);
    assert.equal(ToolCallParser.stripProtocolMarkup(outsideCalls).includes("DSML"), false);
});


test("parses escaped outer tool-call tags without changing command arguments", () => {
    const command = String.raw`Get-ChildItem -Force | Select-Object Mode,Name; Write-Output "C:\\Temp"`;
    const response = String.raw`I'll inspect the folder.
\\<tool_call>exec_command<params>{"cmd":${JSON.stringify(command)}}</params></tool_call>
`;
    const calls = ToolCallParser.extractFromCompleteResponse(response, tools);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "exec_command");
    assert.equal(JSON.parse(calls[0].parameters).cmd, command);
    assert.equal(calls[0].start, response.indexOf("\<tool_call>") + 1);
});

test("parses multiple mixed-format calls with repeated trailing tags", () => {
    const response = [
        "Checking the repository.",
        String.raw`\\<tool_call>exec_command<params>{"cmd":"Get-ChildItem -Force | Select-Object Mode,Name"}</params></tool_call>`,
        "I found the files.",
        String.raw`<｜DSML｜ calls>`,
        String.raw`<｜｜DSML｜｜ invoke name="exec_command">`,
        String.raw`<｜DSML｜ parameter name="cmd" string="true">git status --short</｜｜DSML｜｜ parameter>`,
        String.raw`</｜DSML｜ invoke>`,
        String.raw`</｜DSML｜ calls>`,
        String.raw`</tool_call></tool_call>`,
    ].join("\n");

    const calls = ToolCallParser.extractFromCompleteResponse(response, tools);
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[0].parameters).cmd, "Get-ChildItem -Force | Select-Object Mode,Name");
    assert.equal(JSON.parse(calls[1].parameters).cmd, "git status --short");
});

test("does not rewrite escaped protocol-looking text inside command arguments", () => {
    const command = String.raw`Write-Output '\\<tool_call>literal text'`;
    const response = `<tool_call>exec_command<params>${JSON.stringify({ cmd: command })}</params></tool_call>`;
    const calls = ToolCallParser.extractFromCompleteResponse(response, tools);

    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].parameters).cmd, command);
});
