import assert from "node:assert/strict";
import test from "node:test";
import { collectResponse, parseSseStream } from "./chatgptResponseStream.js";

function streamOf(text: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
}

test("parses Responses SSE events", async () => {
    const events = [];
    for await (const event of parseSseStream(streamOf("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: [DONE]\n\n"))) {
        events.push(event);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "response.output_text.delta");
    assert.equal(events[0].delta, "hello");
});

test("rebuilds output when response.completed contains empty output", async () => {
    const result = await collectResponse(streamOf([
        'data: {"type":"response.output_text.delta","delta":"hello "}\n\n',
        'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}}\n\n',
    ].join("")));

    assert.equal(result.id, "resp_1");
    assert.equal((result.output as any[])[0].content[0].text, "hello world");
    assert.equal((result.usage as any).total_tokens, 4);
});

test("preserves function calls from output_item.done", async () => {
    const result = await collectResponse(streamOf([
        'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"exec_command","arguments":"","status":"in_progress"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"cmd\\":\\"pwd\\"}"}\n\n',
        'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\"}","status":"completed"}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5.5","status":"completed","output":[]}}\n\n',
    ].join("")));

    const call = (result.output as any[])[0];
    assert.equal(call.type, "function_call");
    assert.equal(call.name, "exec_command");
    assert.equal(call.call_id, "call_1");
    assert.equal(call.arguments, '{"cmd":"pwd"}');
});
