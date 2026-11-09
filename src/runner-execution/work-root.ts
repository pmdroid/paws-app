import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { journal, journalCaught } from "../journal";
import { removeRunnerTreeSteps } from "./accounts";

export const RUNNER_WORK_SWEEP_EVERY_MS = 3_600_000;
const CHECKOUT_IDLE_MS = 24 * 3_600_000;
const RUN_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXECUTION_FOLDER = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PACE_ENTRIES = 1_000;

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

function* measureSteps(path: string): Generator<void, { bytes: number; newest: number }> {
  let bytes = 0;
  let newest = 0;
  const pending = [path];
  while (pending.length) {
    const entry = pending.pop()!;
    const info = stat(entry);
    if (!info) continue;
    bytes += info.size;
    newest = Math.max(newest, info.mtimeMs);
    if (info.isDirectory()) for (const name of list(entry)) pending.push(join(entry, name));
    yield;
  }
  return { bytes, newest };
}

async function paced<T>(steps: Generator<void, T>, stop: () => boolean): Promise<T | undefined> {
  for (let count = 1; ; count++) {
    const next = steps.next();
    if (next.done) return next.value;
    if (count % PACE_ENTRIES) continue;
    await yieldToLoop();
    if (stop()) return undefined;
  }
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
  const collecting = new Set<string>();
  let draining: Promise<void> | undefined;
  let sweeping: Promise<void> | undefined;
  let removed = 0;
  let removedBytes = 0;
  let failures = 0;

  async function collect(name: string, reason: string, idleBefore?: number): Promise<void> {
    if (name.startsWith(".") || name.includes("/") || collecting.has(name)) return;
    const stop = () => options.signal?.aborted === true || options.holds().has(name);
    if (stop()) return;
    const path = join(options.workRoot, name);
    collecting.add(name);
    try {
      if (!stat(path)?.isDirectory()) return;
      const measured = await paced(measureSteps(path), stop);
      if (!measured || (idleBefore !== undefined && measured.newest >= idleBefore) || stop())
        return;
      const done = await paced(
        (function* () {
          yield* removeRunnerTreeSteps(path);
          return true;
        })(),
        stop,
      );
      if (!done) return;
      failed.delete(name);
      removed++;
      removedBytes += measured.bytes;
      journal(`runner work root removed name=${name} reason=${reason} bytes=${measured.bytes}`);
    } catch (error) {
      failed.add(name);
      failures++;
      journalCaught(error, "runner-execution.workRoot.remove", null);
    } finally {
      collecting.delete(name);
    }
  }

  async function drain(): Promise<void> {
    for (const name of queue) {
      queue.delete(name);
      await yieldToLoop();
      if (options.signal?.aborted) return;
      await collect(name, "finished");
    }
  }

  async function walk(): Promise<void> {
    [removed, removedBytes, failures] = [0, 0, 0];
    for (const name of list(options.workRoot)) {
      const run = RUN_FOLDER.test(name);
      if (!run && !EXECUTION_FOLDER.test(name)) continue;
      await yieldToLoop();
      if (options.signal?.aborted) return;
      await collect(name, "sweep", run ? now() - CHECKOUT_IDLE_MS : undefined);
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
