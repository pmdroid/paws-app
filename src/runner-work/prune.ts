import type { Database } from "bun:sqlite";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { pruneRunnerEventsSteps, sqliteDb } from "../db";

export const RUNNER_EVENT_PRUNE_JOB = "runner-events.prune";
export const RUNNER_EVENT_PRUNE_EVERY_MS = 3_600_000;
export const RUNNER_EVENT_RETENTION_MS = 7 * 86_400_000;
const BATCH = 5_000;

export async function pruneRunnerEvents(options: {
  db: Database;
  now?: number;
  signal?: AbortSignal;
  onBatch?: (deleted: number) => void;
}) {
  const { db, signal } = options;
  const cutoff = (options.now ?? Date.now()) - RUNNER_EVENT_RETENTION_MS;
  const store = sqliteDb(db);
  let deleted = 0;
  for (;;) {
    signal?.throwIfAborted();
    const changes = await store.transaction((q) => pruneRunnerEventsSteps(q, cutoff, BATCH));
    if (!changes) break;
    options.onBatch?.(changes);
    deleted += changes;
    await yieldToLoop();
  }
  if (deleted) incrementalVacuum(db);
  return { deleted };
}

/** Returns free pages to the file system when the database uses incremental auto-vacuum. */
export function incrementalVacuum(db: Database) {
  const mode = db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get();
  if (mode?.auto_vacuum === 2) db.run("PRAGMA incremental_vacuum");
}
