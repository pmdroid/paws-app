import { mock } from "bun:test";
import * as childProcess from "node:child_process";

const timeout = Number(process.env.PAWS_TEST_SYNC_TIMEOUT_MS ?? 120_000);

function report(command: unknown, args: unknown) {
  const words = [command, ...(Array.isArray(args) ? args : [])].map(String).join(" ");
  console.error(`synchronous process timed out after ${timeout} ms: ${words}`);
}

function timedOut(error: unknown) {
  return (error as { code?: string } | null)?.code === "ETIMEDOUT";
}

function bounded<T>(original: T): T {
  const call = original as unknown as (...input: unknown[]) => unknown;
  return ((...args: unknown[]) => {
    const at = Array.isArray(args[1]) || args.length > 2 ? 2 : 1;
    args[at] = { timeout, ...(args[at] as object | undefined) };
    try {
      const result = call(...args);
      if (timedOut((result as { error?: unknown } | null)?.error)) report(args[0], args[1]);
      return result;
    } catch (error) {
      if (timedOut(error)) report(args[0], args[1]);
      throw error;
    }
  }) as unknown as T;
}

void mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync: bounded(childProcess.spawnSync),
  execFileSync: bounded(childProcess.execFileSync),
  execSync: bounded(childProcess.execSync),
}));

const bunSpawnSync = Bun.spawnSync;
Bun.spawnSync = ((command: { cmd?: string[] } | string[], options?: object) => {
  const result = Array.isArray(command)
    ? bunSpawnSync(command, { timeout, ...options })
    : bunSpawnSync({ timeout, ...command } as unknown as Parameters<typeof bunSpawnSync>[0]);
  if (result.exitedDueToTimeout)
    report(Array.isArray(command) ? command.join(" ") : command.cmd?.join(" "), []);
  return result;
}) as typeof Bun.spawnSync;
