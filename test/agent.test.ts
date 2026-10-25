import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import type { Message, Model, ModelResponse } from "../src/types.ts";

const final: ModelResponse = { message: { role: "assistant", content: "Done" }, finishReason: "stop", tokens: 10 };

test("loop preserves call IDs, returns errors and executes multiple tools sequentially", async () => {
  let request = 0;
  const snapshots: Message[][] = [];
  const order: string[] = [];
  const model: Model = async messages => {
    snapshots.push(structuredClone(messages));
    if (++request === 1) return { message: { role: "assistant", content: null, tool_calls: [
      { id: "bad", type: "function", function: { name: "read_file", arguments: "not json" } },
      { id: "good", type: "function", function: { name: "list_files", arguments: '{"path":"."}' } },
    ] }, finishReason: "tool_calls", tokens: 10 };
    return final;
  };
  const agent = new Agent({ model, tools: [], maxTurns: 3, log: async () => {}, execute: async name => { order.push(name); return "ok"; } });
  assert.equal(await agent.run("Explore"), "Done");
  assert.deepEqual(order, ["list_files"]);
  assert.deepEqual(snapshots[1].slice(-2).map(item => item.role), ["tool", "tool"]);
  assert.match(snapshots[1].at(-2)!.content!, /Tool error/);
  assert.equal((snapshots[1].at(-1) as { tool_call_id: string }).tool_call_id, "good");
  await agent.run("Follow up");
  assert.equal(snapshots[2].at(-2)?.content, "Done");
});

test("turn, request and context budgets terminate the loop; truncation is not success", async () => {
  const loop: Model = async () => ({ message: { role: "assistant", content: null, tool_calls: [
    { id: "again", type: "function", function: { name: "list_files", arguments: "{}" } },
  ] }, finishReason: "tool_calls", tokens: 1 });
  const common = { tools: [], execute: async () => "[]", log: async () => {} };
  await assert.rejects(new Agent({ ...common, model: loop, maxTurns: 2 }).run("loop"), /Reached 2/);
  await assert.rejects(new Agent({ ...common, model: loop, maxTurns: 10, maxRequests: 1 }).run("loop"), /limit reached/);
  await assert.rejects(new Agent({ ...common, maxTurns: 2, model: async () => ({ ...final, finishReason: "length" }) }).run("task"), /unconfirmed/);
  const large = new Agent({ ...common, maxTurns: 2, model: async () => final });
  large.messages.push({ role: "user", content: "a".repeat(180_001) });
  await assert.rejects(large.run("task"), /Conversation limit/);
});
