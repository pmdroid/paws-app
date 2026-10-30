import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";

/** A resume the agent never finished a turn on, with the handoff it would have read. */
export type HeldHandoff = { jobId: number; handoff: string };

/**
 * Handoffs of resume jobs that were cancelled before the agent finished a turn on them and that
 * no later restart carried yet, oldest first. A run that fails before the agent starts (a runner
 * too old, a setup error) or the time limit cancels the resume, and a review or answer it carried
 * would otherwise never reach the agent. A job `halt()` cancelled counts only when nothing had
 * claimed it: one that was running had already handed its text to the agent.
 */
export function heldHandoffs(db: Database, itemId: string): HeldHandoff[] {
  return db
    .query<{ id: number; handoff: string | null }, [string, string, string]>(
      `SELECT id, json_extract(payload, '$.handoff') AS handoff FROM job
       WHERE queue = ? AND status = 'cancelled'
         AND json_extract(payload, '$.itemId') = ?
         AND json_extract(payload, '$.carriedBy') IS NULL
         AND (last_error IS NOT 'halt' OR attempts = 0)
         AND created_at > COALESCE((SELECT MAX(at) FROM work_item_event
           WHERE item_id = ? AND event = 'turn_ended'), 0)
       ORDER BY id`,
    )
    .all(JOB_KIND.resume, itemId, itemId)
    .filter((row) => typeof row.handoff === "string" && row.handoff.trim() !== "")
    .map((row) => ({ jobId: row.id, handoff: row.handoff! }));
}

/** Records that the resume `jobId` carries these handoffs, so none reaches the agent twice. */
export function markHandoffsCarried(
  db: Database,
  held: readonly HeldHandoff[],
  jobId: number,
): void {
  for (const entry of held)
    db.run("UPDATE job SET payload = json_set(payload, '$.carriedBy', ?) WHERE id = ?", [
      jobId,
      entry.jobId,
    ]);
}
