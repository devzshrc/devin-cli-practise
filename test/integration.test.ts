import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.ts";
import { Workspace } from "../src/workspace.ts";
import { createTools, definitions } from "../src/tools.ts";
import { runProcess } from "../src/process.ts";
import type { Model } from "../src/types.ts";

test("agent observes failing tests, fixes three bugs, reruns tests and exports changes", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "devin-integration-")));
  try {
    const source = path.join(base, "repo");
    await cp(path.resolve("examples/buggy-repo"), source, { recursive: true });
    const workspace = await Workspace.create(source, path.join(base, "runs"));
    const execute = await createTools(workspace.root, { mode: "local", image: "unused", network: false, timeoutMs: 5000 });
    let turn = 0;
    const model: Model = async messages => {
      turn++;
      const call = (name: string, args: unknown, id = String(turn)) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
      let calls;
      if (turn === 1) calls = [call("run_shell", { command: "node --test" })];
      else if (turn === 2) {
        const result = JSON.parse(messages.at(-1)!.content!);
        assert.notEqual(result.code, 0);
        assert.match(result.stdout, /fail 3/);
        calls = [call("read_file", { path: "math.js", start_line: 1, end_line: 100 })];
      } else if (turn === 3) {
        assert.match(messages.at(-1)!.content!, /values.length/);
        calls = [
          call("edit_file", { path: "math.js", old_text: "(values.length + 1)", new_text: "values.length" }, "average"),
          call("edit_file", { path: "math.js", old_text: "price * percent", new_text: "price * percent / 100" }, "discount"),
          call("edit_file", { path: "math.js", old_text: "Math.max(maximum, value)", new_text: "Math.min(maximum, value)" }, "clamp"),
        ];
      } else if (turn === 4) calls = [call("run_shell", { command: "node --test" })];
      else {
        const result = JSON.parse(messages.at(-1)!.content!);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /pass 5/);
        return { message: { role: "assistant", content: "Fixed three bugs; five tests pass." }, finishReason: "stop", tokens: 10 };
      }
      return { message: { role: "assistant", content: null, tool_calls: calls }, finishReason: "tool_calls", tokens: 10 };
    };
    const agent = new Agent({ model, tools: definitions, execute, maxTurns: 8, log: async () => {} });
    assert.match(await agent.run("Find and fix three bugs"), /five tests pass/);
    const changes = await workspace.exportPatch();
    assert.deepEqual(changes.files, ["math.js"]);
    assert.match(await readFile(path.join(source, "math.js"), "utf8"), /values.length \+ 1/);
    await workspace.apply(changes.files);
    const verify = await runProcess(process.execPath, ["--test"], { cwd: source });
    assert.equal(verify.code, 0, verify.stdout + verify.stderr);
  } finally { await rm(base, { recursive: true, force: true }); }
});
