import assert from "node:assert/strict";
import test from "node:test";
import { validateToolCallArguments, type ToolDescription } from "./toolPrompt.js";

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
