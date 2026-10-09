import { spawn, type ChildProcess } from "node:child_process";

export function spawnAgent(
  command: string,
  args: string[],
  env: Record<string, string>,
): ChildProcess {
  const child = spawn(command, args, {
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.on("error", () => undefined);
  child.stdout?.on("error", () => undefined);
  child.stderr?.on("error", () => undefined);
  return child;
}

export function captureStderr(child: ChildProcess, limit = 64_000): { text(): string } {
  let text = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    text = (text + chunk).slice(-limit);
  });
  return { text: () => text };
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null || child.exitCode != null || child.signalCode != null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process is already gone.
    }
  }
}

export function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

export async function stopChild(child: ChildProcess, graceMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return true;
  killTree(child, "SIGTERM");
  if (await waitForExit(child, graceMs)) return true;
  killTree(child, "SIGKILL");
  return waitForExit(child, graceMs);
}
