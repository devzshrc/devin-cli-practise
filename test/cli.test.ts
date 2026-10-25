import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const entry = path.resolve("src/index.ts");
const loader = import.meta.resolve("tsx");
const mockSource = `
import assert from 'node:assert/strict';
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'test-model');
  let message;
  let finish = 'stop';
  if (process.env.CLI_SCENARIO === 'edit') {
    if (body.messages.at(-1).role === 'user') {
      message = {role:'assistant', content:null, tool_calls:[{id:'write',type:'function',function:{
        name:'write_file',arguments:JSON.stringify({path:'created.txt',content:'created by mock\\n'})
      }}]};
      finish = 'tool_calls';
    } else {
      assert.equal(body.messages.at(-1).tool_call_id, 'write');
      message = {role:'assistant',content:'Created the file.'};
    }
  } else {
    const users = body.messages.filter(m=>m.role==='user');
    if (users.at(-1).content==='second') assert.equal(users.length,2);
    if (users.at(-1).content==='third') assert.equal(users.length,1);
    message = {role:'assistant',content:'Reply: '+users.at(-1).content};
  }
  return Response.json({choices:[{finish_reason:finish,message}],usage:{total_tokens:5}});
};`;

test("CLI saves artifacts, keeps source unchanged by default, and supports explicit apply", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "devin-cli-")));
  try {
    const source = path.join(base, "repo");
    await mkdir(source);
    await writeFile(path.join(source, "README.md"), "fixture\n");
    const mock = path.join(base, "mock.mjs");
    await writeFile(mock, mockSource);
    for (const apply of [false, true]) {
      const result = spawnSync(process.execPath, ["--import", loader, "--import", mock, entry, "--repo", source, "--once", "--shell", "disabled", ...(apply ? ["--apply"] : []), "make file"], {
        cwd: base, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "test-model", CLI_SCENARIO: "edit" },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Created the file/);
      assert.match(result.stdout, /Changed files: 1/);
      if (!apply) await assert.rejects(readFile(path.join(source, "created.txt")), /ENOENT/);
      else assert.equal(await readFile(path.join(source, "created.txt"), "utf8"), "created by mock\n");
    }
    const runs = await readdir(path.join(base, ".devin/runs"));
    assert.equal(runs.length, 2);
    const transcript = await readFile(path.join(base, ".devin/runs", runs[0], "events.jsonl"), "utf8");
    assert.match(transcript, /"type":"tool"/);
    assert.doesNotMatch(transcript, /test-key/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("interactive CLI retains history, clears context, ignores blanks and exits", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "devin-chat-")));
  try {
    const source = path.join(base, "repo");
    await mkdir(source);
    const mock = path.join(base, "mock.mjs");
    await writeFile(mock, mockSource);
    const result = spawnSync(process.execPath, ["--import", loader, "--import", mock, entry, "--repo", source, "--shell", "disabled"], {
      cwd: base, input: "\nhello\nsecond\n/clear\nthird\nexit\n", encoding: "utf8", timeout: 10_000,
      env: { ...process.env, DEEPSEEK_API_KEY: "test-key", DEEPSEEK_MODEL: "test-model", CLI_SCENARIO: "chat" },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Reply: second/);
    assert.match(result.stdout, /Reply: third/);
    assert.match(result.stdout, /Conversation cleared/);
    assert.doesNotMatch(result.stderr, /Error/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
