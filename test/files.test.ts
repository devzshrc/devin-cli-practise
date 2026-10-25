import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RepositoryFiles } from "../src/files.ts";
import { createTools } from "../src/tools.ts";

test("file tools read, search, edit and create, rejecting invalid input and ambiguous edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devin-files-"));
  try {
    await writeFile(path.join(root, "code.ts"), "hello\nhello\n");
    const execute = await createTools(root, { mode: "disabled", image: "unused", network: false, timeoutMs: 1000 });
    assert.match(await execute("list_files", { path: "." }), /code.ts/);
    assert.match(await execute("read_file", { path: "code.ts", start_line: 1, end_line: 2 }), /1: hello/);
    assert.match(await execute("search_files", { path: ".", query: "hello" }), /code.ts:2/);
    await assert.rejects(execute("edit_file", { path: "code.ts", old_text: "hello", new_text: "bye" }), /ambiguous/);
    await execute("edit_file", { path: "code.ts", old_text: "hello\nhello", new_text: "$&" });
    assert.equal(await readFile(path.join(root, "code.ts"), "utf8"), "$&\n");
    await execute("write_file", { path: "new/file.ts", content: "new" });
    assert.equal(await readFile(path.join(root, "new/file.ts"), "utf8"), "new");
    await assert.rejects(execute("run_shell", { command: "pwd" }), /disabled/);
    await assert.rejects(execute("write_file", { path: "new.ts", content: "x", extra: true }), /Unexpected/);
    await assert.rejects(execute("read_file", { path: "code.ts", start_line: 0, end_line: 2 }), /range/);
    await assert.rejects(execute("unknown", {}), /Unknown/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("path policy rejects traversal, credentials, absolute paths and symlink components", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "devin-boundary-"));
  try {
    const root = path.join(base, "repo");
    await mkdir(root);
    await writeFile(path.join(base, "outside"), "private");
    await symlink(base, path.join(root, "link"));
    const files = await RepositoryFiles.create(root);
    for (const name of ["../outside", ".env", ".git/config", "nested/../outside", "link/outside", "/etc/passwd", "file\\name"]) {
      await assert.rejects(files.read(name));
      await assert.rejects(files.write(name, "changed"));
    }
    assert.equal(await readFile(path.join(base, "outside"), "utf8"), "private");
    await writeFile(path.join(root, "binary"), Buffer.from([0, 1]));
    await writeFile(path.join(root, "large"), "a".repeat(1_000_001));
    await assert.rejects(files.read("binary"), /Binary/);
    await assert.rejects(files.read("large"), /limit/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
