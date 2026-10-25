import test from "node:test";
import assert from "node:assert/strict";
import { createDeepSeek } from "../src/model.ts";

test("DeepSeek adapter sends tool schema and validates tool responses", async () => {
  const model = createDeepSeek({ apiKey: "test-key", model: "test-model", fetch: async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    const body = JSON.parse(init!.body as string);
    assert.equal(body.thinking.type, "disabled");
    assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
    assert.deepEqual(body.tools, []);
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "one", type: "function", function: { name: "list_files", arguments: '{"path":"."}' } }] } }], usage: { total_tokens: 42 } });
  } });
  const result = await model([{ role: "user", content: "hello" }], []);
  assert.equal(result.tokens, 42);
  assert.equal(result.message.tool_calls?.[0].id, "one");
});

test("adapter rejects HTTP errors, malformed bodies and duplicate IDs", async () => {
  const make = (response: () => Response) => createDeepSeek({ apiKey: "test", model: "test", fetch: async () => response() });
  await assert.rejects(make(() => new Response("", { status: 401 }))([], []), /401/);
  await assert.rejects(make(() => Response.json({}))([], []), /missing choices/);
  const call = { id: "same", type: "function", function: { name: "read_file", arguments: "{}" } };
  await assert.rejects(make(() => Response.json({ choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant", content: null, tool_calls: [call, call],
  } }] }))([], []), /duplicate/);
});
