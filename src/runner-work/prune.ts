import { setImmediate as yieldToLoop } from "node:timers/promises";
import { pruneRunnerEventsSteps, type Db } from "../db";

export const RUNNER_EVENT_PRUNE_JOB = "runner-events.prune";
export const RUNNER_EVENT_PRUNE_EVERY_MS = 3_600_000;
export const RUNNER_EVENT_RETENTION_MS = 7 * 86_400_000;
export const ACTIVITY_RETENTION_MS = 86_400_000;
const BATCH = 5_000;

export async function pruneRunnerEvents(options: {
  store: Db;
  now?: number;
  signal?: AbortSignal;
  onBatch?: (deleted: number) => void;
}) {
  const { store, signal } = options;
  const now = options.now ?? Date.now();
  let deleted = 0;
  for (const [retention, type] of [
    [ACTIVITY_RETENTION_MS, "activity"],
    [RUNNER_EVENT_RETENTION_MS, undefined],
  ] as const) {
    const cutoff = now - retention;
    for (;;) {
      signal?.throwIfAborted();
      const changes = await store.transaction((q) =>
        pruneRunnerEventsSteps(q, cutoff, BATCH, type),
      );
      if (!changes) break;
      options.onBatch?.(changes);
      deleted += changes;
      await yieldToLoop();
    }
  }
  return { deleted };
}
