import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "./agent.ts";
import { createDeepSeek } from "./model.ts";
import { createTools, definitions } from "./tools.ts";
import { Workspace } from "./workspace.ts";
import type { ShellOptions } from "./shell.ts";
import { errorText } from "./types.ts";

const HELP = `Mini Devin — a coding agent with a hand-written tool loop

Usage:
  npm start -- [options] "Find and fix the bugs"
  npm start -- [options]                     # interactive session

Options:
  --repo PATH           Repository (default: current directory)
  --once                Run one task and exit
  --apply               Apply changes after a successful session
  --shell MODE          docker (default), local (UNSANDBOXED), or disabled
  --image IMAGE         Docker image (default: node:24-bookworm-slim)
  --network             Allow Docker command network (default: off)
  --max-turns NUMBER    Model turns/task, 1–100 (default: 25)
  --timeout NUMBER      Seconds/shell command, 1–300 (default: 30)
  --help                Show help

Works in a disposable copy. Patch, transcript and workspace: .devin/runs.
Source changes only with --apply. Local shell mode is not sandboxed.
Docker must be running; pull your image before starting.
Interactive commands: /help, /clear, /exit (or exit).
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: "string", default: "." }, once: { type: "boolean" },
    apply: { type: "boolean" }, shell: { type: "string", default: "docker" },
    image: { type: "string", default: "node:24-bookworm-slim" }, network: { type: "boolean" },
    "max-turns": { type: "string", default: "25" }, timeout: { type: "string", default: "30" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log(HELP); return; }
  const task = positionals.join(" ").trim();
  if (values.once && !task) throw new Error("--once requires a task");
  if (!["docker", "local", "disabled"].includes(values.shell)) throw new Error("--shell must be docker, local, or disabled");
  const maxTurns = Number(values["max-turns"]);
  const timeout = Number(values.timeout);
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new Error("--max-turns must be 1–100");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) throw new Error("--timeout must be 1–300 seconds");

  const abort = new AbortController();
  const model = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY ?? "", model: process.env.DEEPSEEK_MODEL ?? "", signal: abort.signal });
  const onInterrupt = () => abort.abort(new Error("Interrupted"));
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  let terminal: ReturnType<typeof createInterface> | undefined;
  let workspace: Workspace | undefined;
  let unsuccessful = false;
  let completed = false;
  try {
    workspace = await Workspace.create(values.repo);
    console.log(`Workspace: ${workspace.root}\nShell: ${values.shell}`);
    if (values.shell === "local") console.error("Local mode runs commands with your user permissions; it is not sandboxed.");
    const logFile = path.join(workspace.directory, "events.jsonl");
    const log = async (event: { type: string; [key: string]: unknown }) => {
      await appendFile(logFile, JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
    };
    const shell: ShellOptions = { mode: values.shell as ShellOptions["mode"], image: values.image,
      network: Boolean(values.network), timeoutMs: timeout * 1000, signal: abort.signal };
    const execute = await createTools(workspace.root, shell);
    const agent = new Agent({ model, tools: definitions, execute, maxTurns, log,
      signal: abort.signal, progress: message => console.error(`[agent] ${message}`) });
    await log({ type: "session", repository: workspace.source, shell: values.shell, model: process.env.DEEPSEEK_MODEL });

    // Start queuing input before the initial request, so early input is retained.
    let input: AsyncIterableIterator<string> | undefined;
    if (!values.once) {
      terminal = createInterface({ input: process.stdin, output: process.stdout });
      terminal.on("SIGINT", () => { onInterrupt(); terminal?.close(); });
      abort.signal.addEventListener("abort", () => terminal?.close(), { once: true });
      input = terminal[Symbol.asyncIterator]();
      console.log("Type a task, /clear for fresh context, or /exit to quit.");
    }
    let nextTask = task;
    while (!abort.signal.aborted) {
      if (!nextTask) {
        if (!input) break;
        process.stdout.write("You: ");
        const next = await input.next();
        if (next.done) break;
        nextTask = next.value.trim();
        if (!nextTask) continue;
      }
      if (["exit", "/exit"].includes(nextTask.toLowerCase())) break;
      if (nextTask === "/help") console.log(HELP);
      else if (nextTask === "/clear") {
        // Clear context, retaining the system prompt and session-wide budgets.
        agent.messages.splice(1);
        console.log("Conversation cleared. Workspace and usage limits retained.");
      } else {
        try {
          const answer = await agent.run(nextTask);
          console.log(`\nAssistant: ${answer}\n`);
          completed = true;
        } catch (error) {
          unsuccessful = true;
          await log({ type: "error", message: errorText(error) });
          console.error(errorText(error));
          if (values.once || abort.signal.aborted) break;
        }
      }
      nextTask = "";
      if (values.once) break;
    }
  } finally {
    terminal?.close();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    if (workspace) {
      const changes = await workspace.exportPatch();
      await writeFile(path.join(workspace.directory, "summary.json"), JSON.stringify({
        files: changes.files, completed, unsuccessful, interrupted: abort.signal.aborted,
        shell: values.shell, patch: changes.patch,
      }, null, 2) + "\n");
      console.log(`Changed files: ${changes.files.length}\nPatch: ${changes.patch}\nRun log: ${path.join(workspace.directory, "events.jsonl")}`);
      if (changes.files.length) console.log(changes.files.map(file => `  ${file}`).join("\n"));
      if (values.apply && completed && !unsuccessful && !abort.signal.aborted) {
        await workspace.apply(changes.files);
        console.log("Applied changes to the source repository.");
      } else if (changes.files.length) console.log("Review changes.patch; apply with git apply from the source repository, or inspect the saved workspace.");
    }
    if (unsuccessful || abort.signal.aborted) process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(errorText(error));
  process.exitCode = 1;
});
