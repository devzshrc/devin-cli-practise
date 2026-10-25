import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Workspace } from "../src/workspace.ts";
import { runProcess } from "../src/process.ts";

test("workspace exports an applicable patch and applies additions, edits and deletions", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "devin-workspace-")));
  try {
    const repo = path.join(base, "repo");
    await mkdir(repo);
    await writeFile(path.join(repo, "keep.txt"), "original\n");
    await writeFile(path.join(repo, "delete.txt"), "delete\n");
    await writeFile(path.join(repo, ".env"), "not-for-workspace");
    await mkdir(path.join(repo, "node_modules"));
    await symlink("keep.txt", path.join(repo, "alias"));
    const workspace = await Workspace.create(repo, path.join(base, "runs"));
    await assert.rejects(readFile(path.join(workspace.root, ".env")), /ENOENT/);
    await assert.rejects(readFile(path.join(workspace.root, "alias")), /ENOENT/);
    await writeFile(path.join(workspace.root, "keep.txt"), "changed a/baseline/source\n");
    await writeFile(path.join(workspace.root, "new file.txt"), "new\n");
    await unlink(path.join(workspace.root, "delete.txt"));
    const changes = await workspace.exportPatch();
    assert.deepEqual(changes.files, ["delete.txt", "keep.txt", "new file.txt"]);
    const patch = await readFile(changes.patch, "utf8");
    assert.match(patch, /changed a\/baseline\/source/);
    const check = await runProcess("git", ["apply", "--check", changes.patch], { cwd: repo });
    assert.equal(check.code, 0, check.stderr);
    assert.equal(await readFile(path.join(repo, "keep.txt"), "utf8"), "original\n");
    await workspace.apply(changes.files);
    assert.equal(await readFile(path.join(repo, "keep.txt"), "utf8"), "changed a/baseline/source\n");
    assert.equal(await readFile(path.join(repo, "new file.txt"), "utf8"), "new\n");
    await assert.rejects(readFile(path.join(repo, "delete.txt")), /ENOENT/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("apply refuses source conflicts before writing, and export rejects shell-created symlinks", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "devin-conflict-")));
  try {
    const repo = path.join(base, "repo");
    await mkdir(repo);
    await writeFile(path.join(repo, "a.txt"), "before");
    await writeFile(path.join(repo, "b.txt"), "before");
    const workspace = await Workspace.create(repo, path.join(base, "runs"));
    await writeFile(path.join(workspace.root, "a.txt"), "agent");
    await writeFile(path.join(workspace.root, "b.txt"), "agent");
    const changes = await workspace.exportPatch();
    await writeFile(path.join(repo, "b.txt"), "user edit");
    await assert.rejects(workspace.apply(changes.files), /Source changed/);
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "before");
    await symlink("/etc/passwd", path.join(workspace.root, "escape"));
    await assert.rejects(workspace.exportPatch(), /symbolic link/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
