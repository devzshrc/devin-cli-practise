import { randomUUID } from "node:crypto";
import { runProcess } from "./process.ts";

export type ShellOptions = {
  mode: "docker" | "local" | "disabled";
  image: string;
  network: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
};

export async function executeShell(root: string, command: string, options: ShellOptions): Promise<string> {
  if (options.mode === "disabled") throw new Error("Shell execution is disabled");
  if (!command.trim() || command.length > 8000) throw new Error("Command must be 1–8000 characters");
  if (options.mode === "local") {
    // Explicit opt-in only: a working directory does NOT sandbox a local shell.
    const result = await runProcess("/bin/sh", ["-c", command], {
      cwd: root, timeoutMs: options.timeoutMs, signal: options.signal,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: "C.UTF-8", CI: "1" },
    });
    return JSON.stringify(result);
  }
  if (root.includes(",")) throw new Error("Docker mount paths cannot contain commas");
  const name = `mini-devin-${randomUUID()}`;
  try {
    const result = await runProcess("docker", [
      "run", "--rm", "--pull=never", "--name", name,
      "--network", options.network ? "bridge" : "none",
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--pids-limit=128", "--memory=512m", "--cpus=1",
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--tmpfs", "/tmp:rw,nosuid,size=256m", "--env", "HOME=/tmp", "--env", "CI=1",
      "--mount", `type=bind,source=${root},target=/workspace`, "--workdir", "/workspace",
      "--entrypoint", "/bin/sh", options.image, "-c", command,
    ], { timeoutMs: options.timeoutMs, signal: options.signal });
    return JSON.stringify(result);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Docker is not installed. Install/start Docker, or explicitly use --shell local for trusted code, or --shell disabled.");
    }
    throw error;
  } finally {
    // Killing docker's client is insufficient: explicitly remove its container too.
    await runProcess("docker", ["rm", "-f", name], { timeoutMs: 5000 }).catch(() => {});
  }
}
