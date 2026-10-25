import { RepositoryFiles } from "./files.ts";
import { executeShell } from "./shell.ts";
import type { ShellOptions } from "./shell.ts";
import type { ToolDefinition, ToolRunner } from "./types.ts";

function tool(name: string, description: string, properties: Record<string, { type: string }>, required = Object.keys(properties)): ToolDefinition {
  return { type: "function", function: { name, description, parameters: {
    type: "object", properties, required, additionalProperties: false,
  } } };
}

export const definitions: ToolDefinition[] = [
  tool("list_files", "List immediate files and directories. Use path '.' to start. Excludes credentials, dependencies, build output, and symlinks. Returns at most 300 entries.", { path: { type: "string" } }),
  tool("read_file", "Read a UTF-8 text file with line numbers. Supply start_line and end_line (1-based, inclusive); at most 300 lines per request. Files must be at most 1 MB. Use another range if output is truncated.", { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }),
  tool("search_files", "Search for a literal, case-sensitive string recursively under path. Returns at most 60 file:line matches. Search scans at most 2000 entries, 1 MB/file, and 20 MB total; results report whether traversal was limited.", { path: { type: "string" }, query: { type: "string" } }),
  tool("write_file", "Create or replace a UTF-8 text file in the workspace (max 1 MB). Parent directories are created. Read existing files before replacing them. Prefer edit_file for focused changes.", { path: { type: "string" }, content: { type: "string" } }),
  tool("edit_file", "Replace exactly one occurrence of old_text with new_text. Fails if old_text is absent or ambiguous; reread the file on failure. Preserves all other file content.", { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }),
  tool("run_shell", "Execute a noninteractive shell command in the workspace. Use it to inspect errors, run tests, and verify fixes. Returns exit code, stdout/stderr, timeout and truncation flags. Network is disabled by default in Docker. Each command starts a fresh shell; files persist, shell variables do not.", { command: { type: "string" } }),
];

export async function createTools(root: string, shell: ShellOptions): Promise<ToolRunner> {
  const files = await RepositoryFiles.create(root);
  return async (name, input) => {
    const definition = definitions.find(item => item.function.name === name);
    if (!definition) throw new Error(`Unknown tool: ${name}`);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool arguments must be an object");
    const args = input as Record<string, unknown>;
    const schema = definition.function.parameters;
    if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) throw new Error("Unexpected tool argument");
    for (const key of schema.required) {
      const expected = schema.properties[key].type;
      if (expected === "integer" ? !Number.isInteger(args[key]) : typeof args[key] !== expected) throw new Error(`Invalid argument: ${key} must be ${expected}`);
    }
    const string = (key: string) => args[key] as string;
    const relative = string("path");
    if (name === "list_files") {
      const entries = await files.list(relative);
      return JSON.stringify({ entries: entries.slice(0, 300), truncated: entries.length > 300 });
    }
    if (name === "read_file") {
      const start = args.start_line as number;
      const end = args.end_line as number;
      if (start < 1 || end < start || end - start >= 300) throw new Error("Use a valid 1-based range of at most 300 lines");
      const lines = (await files.read(relative)).split("\n");
      return JSON.stringify({ totalLines: lines.length, text: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n") });
    }
    if (name === "search_files") {
      if (!string("query").trim()) throw new Error("Search query must be nonempty");
      const traversal = await files.walk(relative);
      const matches: string[] = [];
      let bytes = 0;
      let scanned = 0;
      for (const file of traversal.files) {
        if (matches.length >= 60 || bytes >= 20_000_000) break;
        let content;
        try { content = await files.read(file); } catch { continue; }
        bytes += Buffer.byteLength(content);
        scanned++;
        for (const [index, line] of content.split("\n").entries()) {
          if (line.includes(string("query"))) matches.push(`${file}:${index + 1}: ${line.slice(0, 300)}`);
          if (matches.length >= 60) break;
        }
      }
      return JSON.stringify({ matches, scanned, limited: traversal.truncated || matches.length >= 60 || bytes >= 20_000_000 });
    }
    if (name === "write_file") {
      await files.write(relative, string("content"));
      return `Wrote ${relative}`;
    }
    if (name === "edit_file") {
      const before = await files.read(relative);
      const old = string("old_text");
      if (!old || !before.includes(old)) throw new Error("old_text not found; reread the file");
      if (before.indexOf(old) !== before.lastIndexOf(old)) throw new Error("old_text is ambiguous; provide more surrounding text");
      await files.write(relative, before.replace(old, () => string("new_text")));
      return `Edited ${relative}`;
    }
    return executeShell(files.root, string("command"), shell);
  };
}
