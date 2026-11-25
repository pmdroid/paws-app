import { closeSync, lstatSync, readdirSync } from "node:fs";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { journal, journalCaught } from "../journal";
import { removeRunnerTreeSteps } from "./accounts";
import { ExecutionIdSchema } from "./jobs";
import { openRoot, type RunnerSpool } from "./spool";
import { measureSteps, paced } from "./work-root";

const JOB_IDLE_MS = 24 * 3_600_000;

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function removeRunnerJob(spool: RunnerSpool, executionId: string): void {
  ExecutionIdSchema.parse(executionId);
  if (process.getuid?.() !== spool.runnerUid) throw new Error("Only the runner may remove jobs");
  const root = openRoot(spool);
  try {
    const path = `/proc/self/fd/${root}/${executionId}`;
    if (present(path)) for (const _ of removeRunnerTreeSteps(path));
  } finally {
    closeSync(root);
  }
}

export function createRunnerSpoolCleaner(options: {
  spool: RunnerSpool;
  holds: () => ReadonlySet<string>;
  now?: () => number;
  signal?: AbortSignal;
}) {
  const now = options.now ?? Date.now;
  const named = new Set<string>();
  let sweeping: Promise<void> | undefined;

  async function walk(): Promise<void> {
    let [removed, bytes, failed] = [0, 0, 0];
    const aborted = () => options.signal?.aborted === true;
    const root = openRoot(options.spool);
    try {
      for (const name of readdirSync(`/proc/self/fd/${root}`)) {
        if (!ExecutionIdSchema.safeParse(name).success) {
          if (!named.has(name)) journal(`runner spool kept unknown name=${JSON.stringify(name)}`);
          named.add(name);
          continue;
        }
        await yieldToLoop();
        if (aborted()) break;
        const held = () => aborted() || options.holds().has(name);
        if (held()) continue;
        const path = `/proc/self/fd/${root}/${name}`;
        try {
          const measured = await paced(measureSteps(path), held);
          if (!measured || measured.newest >= now() - JOB_IDLE_MS || held()) continue;
          const done = await paced(
            (function* () {
              yield* removeRunnerTreeSteps(path);
              return true;
            })(),
            aborted,
          );
          if (!done) break;
          removed++;
          bytes += measured.bytes;
        } catch (error) {
          failed++;
          journalCaught(error, "runner-execution.spool.sweep", null);
        }
      }
    } finally {
      closeSync(root);
    }
    journal(`runner spool swept removed=${removed} bytes=${bytes} failed=${failed}`);
  }

  return {
    sweep(): Promise<void> {
      return (sweeping ??= walk().finally(() => {
        sweeping = undefined;
      }));
    },
  };
}
export type RunnerSpoolCleaner = ReturnType<typeof createRunnerSpoolCleaner>;
