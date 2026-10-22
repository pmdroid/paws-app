import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { EXECUTION_TAG_ENV } from "../process";
import { ExecutionIdSchema } from "./jobs";

export type ExecutionProcess = { pid: number; born: string; executionId: string };

/** Start time in clock ticks since boot, or undefined once the process is gone or a zombie. */
export function startTime(pid: number, proc = "/proc"): string | undefined {
  try {
    const stat = readFileSync(join(proc, String(pid), "stat"), "utf8");
    const command = stat.lastIndexOf(")");
    if (command < 0) return;
    const fields = stat.slice(command + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return;
    return fields[19];
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

/** Separates supervisors that share a host, such as the work and health runtimes, and tests. */
export function executionScope(stateRoot: string): string {
  return createHash("sha256").update(resolve(stateRoot)).digest("hex").slice(0, 16);
}

export function executionTag(scope: string, executionId: string): Record<string, string> {
  return { [EXECUTION_TAG_ENV]: `${scope}/${ExecutionIdSchema.parse(executionId)}` };
}

/** Live processes tagged with an execution of this scope. Processes of other users are skipped. */
export function listExecutionProcesses(scope: string, proc = "/proc"): ExecutionProcess[] {
  const prefix = `${EXECUTION_TAG_ENV}=${scope}/`;
  const found: ExecutionProcess[] = [];
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let tag: string | undefined;
    try {
      tag = readFileSync(join(proc, entry, "environ"), "latin1")
        .split("\0")
        .find((value) => value.startsWith(prefix));
    } catch {
      continue;
    }
    const executionId = ExecutionIdSchema.safeParse(tag?.slice(prefix.length));
    if (!executionId.success) continue;
    const born = startTime(Number(entry), proc);
    if (born !== undefined) found.push({ pid: Number(entry), born, executionId: executionId.data });
  }
  return found;
}

function signal(targets: readonly ExecutionProcess[], name: NodeJS.Signals): void {
  for (const target of targets) {
    if (startTime(target.pid) !== target.born) continue;
    try {
      process.kill(target.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

/**
 * Stops every tagged process of the selected executions: SIGTERM, a grace period, then SIGKILL
 * until none are left. A sandbox that moved to its own session is still tagged, so it is found.
 * Returns how many processes were found.
 */
export async function stopExecutionProcesses(
  scope: string,
  select: (executionId: string) => boolean,
  graceMs = 2_000,
): Promise<number> {
  const find = () => listExecutionProcesses(scope).filter((entry) => select(entry.executionId));
  const first = find();
  if (!first.length) return 0;
  signal(first, "SIGTERM");
  const graceEnd = Date.now() + graceMs;
  while (Date.now() < graceEnd && find().length) await sleep(25);
  const deadline = Date.now() + 5_000;
  for (let left = find(); left.length; left = find()) {
    if (Date.now() >= deadline) throw new Error("Runner execution processes did not exit");
    signal(left, "SIGKILL");
    await sleep(25);
  }
  return first.length;
}
