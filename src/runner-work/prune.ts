import type { Database } from "bun:sqlite";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { immediate } from "../db";

export const RUNNER_EVENT_PRUNE_JOB = "runner-events.prune";
export const RUNNER_EVENT_PRUNE_EVERY_MS = 3_600_000;
export const RUNNER_EVENT_RETENTION_MS = 7 * 86_400_000;
const BATCH = 5_000;

const PRUNABLE_RUNS = `
  SELECT r.id FROM run r
  WHERE r.status IN ('ended','lost') AND r.updated_at<?1
    AND NOT EXISTS(SELECT 1 FROM work_item i WHERE i.current_run_id=r.id
      AND i.state NOT IN ('merged','completed','cancelled'))
    AND NOT EXISTS(SELECT 1 FROM runner_work w WHERE w.run_id=r.id AND w.ended_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM runner_event q
      WHERE q.run_id=r.id
        AND (q.type IN ('question','artifact','closeout_policy','ci_log','ci_rerun') OR (q.type IS NULL AND q.key_id IS NULL))
        AND NOT EXISTS(SELECT 1 FROM runner_question_answer a
          WHERE a.run_id=q.run_id AND a.generation=q.generation AND a.sequence=q.sequence))`;

const PRUNABLE = `
  SELECT e.rowid FROM runner_event e
  WHERE e.run_id IN (${PRUNABLE_RUNS})
    AND NOT EXISTS(SELECT 1 FROM runner_question_answer a
      WHERE a.run_id=e.run_id AND a.generation=e.generation AND a.sequence=e.sequence)
  LIMIT ${BATCH}`;

export async function pruneRunnerEvents(options: {
  db: Database;
  now?: number;
  signal?: AbortSignal;
  onBatch?: (deleted: number) => void;
}) {
  const { db, signal } = options;
  const cutoff = (options.now ?? Date.now()) - RUNNER_EVENT_RETENTION_MS;
  const remove = db.query<never, [number]>(`DELETE FROM runner_event WHERE rowid IN (${PRUNABLE})`);
  let deleted = 0;
  for (;;) {
    signal?.throwIfAborted();
    const { changes } = immediate(db, () => remove.run(cutoff));
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
