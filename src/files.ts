import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_FILE_BYTES = 1_000_000;
export const EXCLUDED = new Set([
  ".git", ".devin", "node_modules", "dist", "build", "coverage", ".next",
  ".env", ".aws", ".ssh", ".npmrc", ".pypirc", ".DS_Store",
]);
export function excluded(name: string): boolean {
  return EXCLUDED.has(name) || name.startsWith(".env.") || /\.(pem|key|bundle)$/i.test(name);
}

// Every file tool uses the same path policy. Symlink components are rejected.
// This protects the controller from shell-created symlinks too. It is not an OS sandbox.
export class RepositoryFiles {
  constructor(readonly root: string) {}

  static async create(root: string): Promise<RepositoryFiles> {
    const resolved = await realpath(root);
    if (!(await lstat(resolved)).isDirectory()) throw new Error("Repository must be a directory");
    return new RepositoryFiles(resolved);
  }

  async resolve(relative: string, allowMissing = false): Promise<string> {
    if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0")) {
      throw new Error("Use a nonempty repository-relative path with forward slashes");
    }
    if (relative.split("/").some(part => part === ".." || excluded(part))) {
      throw new Error("Parent traversal or excluded path is not allowed");
    }
    const target = path.resolve(this.root, relative);
    const parts = path.relative(this.root, target).split(path.sep).filter(Boolean);
    let cursor = this.root;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symbolic links are not allowed");
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return target;
  }

  async read(relative: string): Promise<string> {
    const target = await this.resolve(relative);
    const handle = await open(target, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Path must be a regular file");
      if (info.size > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MB tool limit");
      const bytes = await handle.readFile();
      if (bytes.includes(0)) throw new Error("Binary files are not supported by text tools");
      return bytes.toString("utf8");
    } finally { await handle.close(); }
  }

  async write(relative: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes("\0")) throw new Error("Text must be at most 1 MB with no NUL bytes");
    if (relative === ".") throw new Error("Specify a file path");
    const target = await this.resolve(relative, true);
    await mkdir(path.dirname(target), { recursive: true });
    await this.resolve(relative, true);
    // Rename a complete temporary file instead of leaving a partially written file.
    const temporary = path.join(path.dirname(target), `.devin-write-${randomUUID()}`);
    try {
      let mode = 0o644;
      try { mode = (await lstat(target)).mode & 0o777; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await writeFile(temporary, content, { flag: "wx", mode });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async list(relative = "."): Promise<string[]> {
    const entries = await readdir(await this.resolve(relative), { withFileTypes: true });
    return entries.filter(entry => !excluded(entry.name) && !entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => entry.name + (entry.isDirectory() ? "/" : ""));
  }

  async walk(relative = ".", limit = 2000): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = [];
    const queue = [relative];
    let visited = 0;
    while (queue.length) {
      const dir = queue.shift()!;
      for (const entry of await this.list(dir)) {
        if (++visited > limit) return { files, truncated: true };
        const child = path.posix.join(dir, entry);
        if (entry.endsWith("/")) queue.push(child);
        else {
          const full = await this.resolve(child);
          if ((await lstat(full)).isFile()) files.push(child);
        }
      }
    }
    return { files, truncated: false };
  }
}
