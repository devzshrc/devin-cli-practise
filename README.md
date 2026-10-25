# Mini Devin

A TypeScript coding agent built from first principles: our own model → tool → observation loop, using DeepSeek's API and native `fetch`. No agent SDK.

It can explore a repository, search code, read files, create and edit files, execute commands, inspect test failures, and iterate. It supports interactive sessions and one-shot tasks, with bounded execution and a transcript of every action.

## Quick start

Requires Node.js 24+, npm, and Git. Docker is required for the default shell mode.

```sh
npm install
cp .env.example .env
```

Set these values in `.env` (never commit your key):

```text
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_MODEL=deepseek-flash
```

For Docker execution, start Docker and pull the image once:

```sh
docker pull node:24-bookworm-slim
npm start -- --repo ./examples/buggy-repo --once "Find and fix the bugs. Run the tests."
```

The agent edits a **disposable copy**, leaving your original repository unchanged. At the end it prints paths to the workspace, a Git-compatible `changes.patch`, JSONL event log, and JSON summary under `.devin/runs/run-*` in the directory you launched from.

Review the patch, then apply it from the target repository:

```sh
git apply --check /absolute/path/to/changes.patch
git apply /absolute/path/to/changes.patch
```

To authorize applying changes automatically after a session without controller errors, add `--apply`:

```sh
npm start -- --repo ./examples/buggy-repo --once --apply "Find and fix the bugs. Run node --test."
```

`--apply` checks for conflicting source changes before writing. A model final response does not guarantee correctness or passing tests; inspect the transcript and patch. Applying several files is not a single atomic transaction. Failed or interrupted sessions retain their workspace/patch for review and do not auto-apply.

## Interactive chat and coding

```sh
npm start -- --repo ./my-project
npm start -- --repo ./my-project "Explain this codebase"
```

Follow-up tasks share conversation history and workspace changes. Type `/exit` or `exit` to quit, `/help` for usage, and `/clear` to clear the model context while retaining the workspace and usage limits. Ctrl+D ends input; Ctrl+C cancels work. History is saved to the run log but automatic session resumption is not implemented.

## Running without Docker

For a trusted project, explicitly opt into your local shell:

```sh
npm start -- --repo ./examples/buggy-repo --shell local --once "Fix the bugs and run node --test"
```

**Local mode is not sandboxed.** A temporary working directory and path checks do not restrict a shell's access to your computer. The shell receives a reduced environment, but commands still run with your user permissions and can access host resources. Use Docker for unfamiliar code. `--shell disabled` allows file tools while disabling commands.

Docker commands mount only the copied workspace, never the source repository, Docker socket, or API-key file. Each command gets a fresh container/shell with persistent workspace files. Containers use a nonroot UID, a read-only root filesystem, dropped capabilities, resource limits, and network disabled by default. This uses Docker's isolation; it is not a VM or a guarantee against hostile kernels/images. Choose a trusted image appropriate to the project with `--image`.

Dependencies are excluded from the initial copy. To let the agent install them in Docker, explicitly add `--network` (or preinstall dependencies in a custom image). The default image provides Node/npm; other language runtimes may require another image. No automatic fallback from Docker to local execution occurs.

## Demo

`examples/buggy-repo` deliberately contains three bugs and five tests. Its failing baseline is expected. It needs no dependencies or network access to run tests.

```sh
npm run demo
```

This makes paid DeepSeek requests, runs the bundled trusted fixture with **local shell mode**, and applies the agent's changes to the fixture. To preserve the fixture, use the earlier command without `--apply`. You can also inspect and fix it yourself with `cd examples/buggy-repo` followed by `node --test`.

## Read the implementation in this order

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Message, tool, model, and event contracts |
| `src/model.ts` | DeepSeek HTTP requests, response validation, bounded retries |
| `src/agent.ts` | Hand-written ask → act → observe loop |
| `src/tools.ts` | Tool schemas, argument validation, dispatch |
| `src/files.ts` | Repository path policy and file operations |
| `src/process.ts` | Process exit status, timeouts, output limits, cancellation |
| `src/shell.ts` | Docker or explicitly selected local command execution |
| `src/workspace.ts` | Snapshot, patch export, conflict checks, applying changes |
| `src/index.ts` | CLI configuration and interactive terminal lifecycle |

The model requests function calls by name and JSON arguments. We append the assistant's tool calls to history, execute them sequentially, then append `role: "tool"` messages referencing the original call IDs. Errors are observations too, so the model can read an error and try another approach. The next API request contains that expanded conversation. A plain final assistant message ends the task.

The implementation follows [DeepSeek's tool-call protocol](https://api-docs.deepseek.com/guides/tool_calls/) with thinking disabled. DeepSeek provides the model; our code controls tool execution and limits. Docker flags follow the [Docker container execution reference](https://docs.docker.com/engine/containers/run/).

## Tools

- `list_files(path)`: list a directory.
- `read_file(path, start_line, end_line)`: numbered text, up to 300 lines/request.
- `search_files(path, query)`: literal recursive text search.
- `write_file(path, content)`: create or replace text, creating parent directories.
- `edit_file(path, old_text, new_text)`: replace exactly one matching occurrence.
- `run_shell(command)`: execute commands and return exit status, output, and timeout flags.

Paths must be repository-relative. Traversal, symlink components, common credential paths, and Git metadata are rejected by file tools. Snapshots omit symlinks, `.env*`, `.npmrc`, `.aws`, `.ssh`, key files, Git metadata, dependencies, generated directories, and `.devin`. This is a finite exclusion list, not a secret detector; inspect the repository before sending its contents to a model. Custom ignore rules and symlink preservation are not implemented.

## Limits and verification

```sh
npm test
npm run typecheck
npm start -- --help
```

Tests use mocked model/API responses and temporary repositories, so they need no API key or paid calls. An integration test runs a failing five-test fixture, observes its three failures, makes targeted repairs through tools, reruns tests successfully, exports a patch, and applies it. This verifies orchestration and tools, not a live model's ability to solve arbitrary tasks. Docker runtime verification requires Docker on your machine.

Defaults: 25 model turns/task (`--max-turns`), 60 model requests/session, 200 tool calls/session, 8 calls/response, 120k reported cumulative tokens/session, 180k conversation JSON characters, and 4096 generated tokens/request. Token limits are checked between requests; one request can exceed the remaining budget. Retries may create additional HTTP attempts. These are bounds, not a hard dollar budget. Oversized context stops with an error; automatic compaction is not implemented.

Shell commands default to 30 seconds (`--timeout`) and 24 KB output; exceeding output stops the command. API attempts time out after 60 seconds, with at most two retries for 429/5xx responses. Workspace limits are 2000 entries, 1 MB/file and 20 MB total; too-large repositories fail explicitly. Search and tool outputs are bounded and may omit results. Run logs contain tasks, source excerpts, tool arguments and command output; treat them as private project data. Keep the source repository stationary during snapshot/apply; path checks do not eliminate concurrent filesystem races.
