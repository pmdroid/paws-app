import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { journal, journalCaught } from "../journal";
import { removeRunnerTree } from "./accounts";

export const RUNNER_WORK_SWEEP_EVERY_MS = 3_600_000;
const CHECKOUT_IDLE_MS = 24 * 3_600_000;
const RUN_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXECUTION_FOLDER = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const unreadable = (error: unknown) =>
  ["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");

function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (unreadable(error)) return undefined;
    throw error;
  }
}

function list(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    if (unreadable(error)) return [];
    throw error;
  }
}

function measure(path: string): { bytes: number; newest: number } {
  let bytes = 0;
  let newest = 0;
  const visit = (entry: string) => {
    const info = stat(entry);
    if (!info) return;
    bytes += info.size;
    newest = Math.max(newest, info.mtimeMs);
    if (info.isDirectory()) for (const name of list(entry)) visit(join(entry, name));
  };
  visit(path);
  return { bytes, newest };
}

export function openRunnerCheckoutToGroup(path: string): void {
  const self = process.getuid?.();
  const visit = (folder: string) => {
    const info = stat(folder);
    if (!info?.isDirectory()) return;
    if (info.uid === self && (info.mode & 0o070) !== 0o070)
      chmodSync(folder, (info.mode & 0o7777) | 0o070);
    for (const name of list(folder)) visit(join(folder, name));
  };
  try {
    visit(path);
  } catch (error) {
    journalCaught(error, "runner-execution.openRunnerCheckoutToGroup", null);
  }
}

export function createRunnerWorkCleaner(options: {
  workRoot: string;
  holds: () => ReadonlySet<string>;
  now?: () => number;
  signal?: AbortSignal;
}) {
  const now = options.now ?? Date.now;
  const queue = new Set<string>();
  const failed = new Set<string>();
  let draining: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined;
  let removed = 0;
  let removedBytes = 0;
  let failures = 0;

  function collect(name: string, reason: string, idleBefore?: number): void {
    if (name.startsWith(".") || name.includes("/") || options.holds().has(name)) return;
    const path = join(options.workRoot, name);
    try {
      if (!stat(path)?.isDirectory()) return;
      const { bytes, newest } = measure(path);
      if (idleBefore !== undefined && newest >= idleBefore) return;
      removeRunnerTree(path);
      failed.delete(name);
      removed++;
      removedBytes += bytes;
      journal(`runner work root removed name=${name} reason=${reason} bytes=${bytes}`);
    } catch (error) {
      failed.add(name);
      failures++;
      journalCaught(error, "runner-execution.workRoot.remove", null);
    }
  }

  async function drain(): Promise<void> {
    for (const name of queue) {
      queue.delete(name);
      await yieldToLoop();
      if (options.signal?.aborted) return;
      collect(name, "finished");
    }
  }

  async function walk(): Promise<void> {
    [removed, removedBytes, failures] = [0, 0, 0];
    for (const name of list(options.workRoot)) {
      const run = RUN_FOLDER.test(name);
      if (!run && !EXECUTION_FOLDER.test(name)) continue;
      await yieldToLoop();
      if (options.signal?.aborted) return;
      collect(name, "sweep", run ? now() - CHECKOUT_IDLE_MS : undefined);
    }
    journal(`runner work root swept removed=${removed} bytes=${removedBytes} failed=${failures}`);
  }

  return {
    released(runIds: readonly string[]): Promise<void> {
      for (const id of runIds) if (!failed.has(id)) queue.add(id);
      return (draining ??= drain().finally(() => {
        draining = undefined;
      }));
    },
    sweep(): Promise<void> {
      return (sweeping ??= walk().finally(() => {
        sweeping = undefined;
      }));
    },
  };
}
export type RunnerWorkCleaner = ReturnType<typeof createRunnerWorkCleaner>;
