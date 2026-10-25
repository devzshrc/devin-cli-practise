import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { excluded, MAX_FILE_BYTES, RepositoryFiles } from "./files.ts";
import { runProcess } from "./process.ts";

async function safeDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    await mkdir(cursor).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Output directory must not contain symlinks: ${cursor}`);
  }
}

// Copy project data, never credentials, Git metadata, dependencies, or symlinks.
async function snapshot(source: string, destination: string, strictLinks = false): Promise<void> {
  let count = 0;
  let bytes = 0;
  async function copy(relative: string): Promise<void> {
    const from = path.join(source, relative);
    const to = path.join(destination, relative);
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (excluded(entry.name)) continue;
      if (++count > 2000) throw new Error("Workspace exceeds the 2000-entry limit; use a smaller repository");
      const child = path.join(relative, entry.name);
      const info = await lstat(path.join(source, child));
      if (info.isSymbolicLink()) {
        if (strictLinks) throw new Error(`Cannot export a symbolic link: ${child}`);
        continue;
      }
      if (info.isDirectory()) await copy(child);
      else if (info.isFile()) {
        bytes += info.size;
        if (info.size > MAX_FILE_BYTES || bytes > 20_000_000) throw new Error("Workspace limit exceeded: 1 MB/file and 20 MB total");
        await copyFile(path.join(source, child), path.join(destination, child));
        await chmod(path.join(destination, child), info.mode & 0o777);
      } else if (strictLinks) throw new Error(`Cannot export special file: ${child}`);
    }
  }
  await copy("");
}

export class Workspace {
  private constructor(readonly source: string, readonly directory: string, readonly root: string) {}

  static async create(source: string, output = path.resolve(".devin/runs")): Promise<Workspace> {
    const original = await realpath(source);
    if (!(await lstat(original)).isDirectory()) throw new Error("Repository must be a directory");
    await safeDirectory(output);
    // Place output outside the selected source tree, or under its excluded .devin directory.
    const relative = path.relative(original, path.resolve(output));
    if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== ".devin") {
      throw new Error("Run output inside the repository must be under .devin");
    }
    const directory = await mkdtemp(path.join(output, "run-"));
    await snapshot(original, path.join(directory, "baseline"));
    await snapshot(path.join(directory, "baseline"), path.join(directory, "workspace"));
    return new Workspace(original, directory, path.join(directory, "workspace"));
  }

  async exportPatch(): Promise<{ patch: string; files: string[] }> {
    // Filter generated dependencies and artifacts out before invoking git diff.
    const final = await mkdtemp(path.join(this.directory, "final-"));
    await snapshot(this.root, final, true);
    const finalName = path.basename(final);
    const result = await runProcess("git", ["-c", "core.quotePath=false", "diff", "--no-index", "--no-renames", "--binary", "--", "baseline", finalName], {
      cwd: this.directory, timeoutMs: 30_000, maxBytes: 4_000_000,
    });
    if (result.code > 1 || result.timedOut || result.truncated) throw new Error(`Cannot generate patch: ${result.stderr || "diff limit exceeded"}`);
    // Rewrite only patch headers; matching source-code text must remain untouched.
    const patchText = result.stdout.split("\n").map(line =>
      /^(diff --git |--- |\+\+\+ )/.test(line)
        ? line.replace(new RegExp(`([ab])/(baseline|${finalName})/`, "g"), "$1/") : line
    ).join("\n");
    const patch = path.join(this.directory, "changes.patch");
    await writeFile(patch, patchText);
    const base = await RepositoryFiles.create(path.join(this.directory, "baseline"));
    const after = await RepositoryFiles.create(final);
    const paths = new Set([...(await base.walk()).files, ...(await after.walk()).files]);
    const files: string[] = [];
    for (const relative of paths) {
      const before = await readFile(path.join(base.root, relative)).catch(() => null);
      const next = await readFile(path.join(final, relative)).catch(() => null);
      const beforeMode = await lstat(path.join(base.root, relative)).then(info => info.mode & 0o777).catch(() => null);
      const nextMode = await lstat(path.join(final, relative)).then(info => info.mode & 0o777).catch(() => null);
      if (beforeMode !== nextMode || (before === null ? next !== null : next === null || !before.equals(next))) files.push(relative);
    }
    return { patch, files: files.sort() };
  }

  async apply(files: string[]): Promise<void> {
    const original = await RepositoryFiles.create(this.source);
    const working = await RepositoryFiles.create(this.root);
    // Check ALL conflicts before changing any source files.
    for (const relative of files) {
      const target = await original.resolve(relative, true);
      const current = await readFile(target).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const before = await readFile(path.join(this.directory, "baseline", relative)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (before === null ? current !== null : current === null || !before.equals(current)) {
        throw new Error(`Source changed during the run; refusing to overwrite ${relative}. Review changes.patch instead.`);
      }
      if (before !== null) {
        const originalMode = (await lstat(target)).mode & 0o777;
        const baselineMode = (await lstat(path.join(this.directory, "baseline", relative))).mode & 0o777;
        if (originalMode !== baselineMode) throw new Error(`Source permissions changed during the run: ${relative}`);
      }
    }
    for (const relative of files) {
      const source = await working.resolve(relative, true);
      const target = await original.resolve(relative, true);
      let info;
      try { info = await lstat(source); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!info) await unlink(target);
      else {
        if (!info.isFile()) throw new Error("Only regular files can be applied");
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
        await chmod(target, info.mode & 0o777);
      }
    }
  }
}
