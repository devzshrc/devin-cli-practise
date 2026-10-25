import { spawn } from "node:child_process";

export type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

// Bound execution time and output. A process group lets us kill local descendants.
export async function runProcess(command: string, args: string[], options: {
  cwd?: string; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
} = {}): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const maxBytes = options.maxBytes ?? 24_000;
    const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
    let size = 0;
    let timedOut = false;
    let truncated = false;
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process may already have exited. */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? 30_000);
    const onAbort = () => kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    for (const channel of ["stdout", "stderr"] as const) {
      child[channel].on("data", (chunk: Buffer) => {
        const remaining = Math.max(0, maxBytes - size);
        output[channel].push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) { truncated = true; kill(); }
      });
    }
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      kill();
    };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      cleanup();
      if (options.signal?.aborted) { reject(options.signal.reason); return; }
      resolve({ code: code ?? 1, stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"), timedOut, truncated });
    });
  });
}
