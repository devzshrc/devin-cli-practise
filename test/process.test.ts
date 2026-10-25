import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/process.ts";

test("command runner reports exit status and bounds timeout/output", async () => {
  const failed = await runProcess(process.execPath, ["-e", "console.error('failure'); process.exitCode=7"]);
  assert.equal(failed.code, 7);
  assert.match(failed.stderr, /failure/);
  const timeout = await runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 });
  assert.equal(timeout.timedOut, true);
  const output = await runProcess(process.execPath, ["-e", "console.log('x'.repeat(100000))"], { maxBytes: 1000 });
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.stdout) <= 1000);
});

test("command cancellation stops execution", async () => {
  const abort = new AbortController();
  const run = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: abort.signal });
  setTimeout(() => abort.abort(new Error("cancelled")), 50);
  await assert.rejects(run, /cancelled/);
});
