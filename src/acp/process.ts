import { OwnedProcess } from "../process";
export type { OwnedProcess } from "../process";

export interface SpawnAgentOptions {
  cwd?: string;
}

export function spawnAgent(
  command: string,
  args: string[],
  env: Record<string, string>,
  options?: SpawnAgentOptions,
): OwnedProcess {
  return new OwnedProcess(command, args, env, options?.cwd);
}

export function captureStderr(child: OwnedProcess, limit = 64_000): { text(): string } {
  let text = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    text = (text + chunk).slice(-limit);
  });
  return { text: () => text };
}

export function killTree(child: OwnedProcess, signal: NodeJS.Signals): void {
  child.killGroup(signal);
}

export function waitForExit(child: OwnedProcess, ms: number): Promise<boolean> {
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

export function stopChild(child: OwnedProcess, graceMs: number): Promise<boolean> {
  return child.stop(graceMs);
}
