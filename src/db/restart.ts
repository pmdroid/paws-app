import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { JOB_KIND, type RestartReason } from "../core";
import { halt } from "./halt";
import { applyWorkItemEvent, saveCheckpoint, type WorkItemRecord } from "./items";
import { enqueueJobOnce } from "./jobs";
import { markRun } from "./runs";
import { immediate } from "./tx";

export type RestartHandoff = { reason: RestartReason; body: string; now: number; jobKey?: string };

/** One admission path back to the agent. Keeps the run, branch and Linear session. */
export function restart(
  db: Database,
  item: WorkItemRecord,
  handoff: RestartHandoff,
): number | null {
  return immediate(db, () => {
    if (!halt(db, item, handoff.now)) return null;
    if (item.currentRunId) markRun(db, item.currentRunId, "ended", handoff.now);
    if (handoff.reason === "answer")
      db.run("UPDATE work_item SET turn_count=0 WHERE id=?", [item.id]);
    const record = {
      kind: "restart" as const,
      reason: handoff.reason,
      payloadDigest: createHash("sha256").update(handoff.body).digest("hex"),
      now: handoff.now,
    };
    const queued = applyWorkItemEvent(db, item.id, "restart", record);
    if (item.checkpoint) saveCheckpoint(db, item.id, { ...item.checkpoint, phase: "running" });
    return enqueueJobOnce(db, {
      queue: JOB_KIND.resume,
      jobKey: handoff.jobKey ?? `restart:${item.id}:${queued.version}`,
      payload: {
        itemId: item.id,
        runId: item.currentRunId,
        handoff: handoff.body,
        reason: handoff.reason,
      },
      now: handoff.now,
    });
  });
}

/** Fix restarts since the latest human turn, across findings, CI and review. */
export function fixRounds(db: Database, itemId: string): number {
  return (
    db
      .query<{ count: number }, [string, string, string, string]>(`
    SELECT COUNT(*) AS count FROM job WHERE queue = ? AND json_extract(payload, '$.itemId') = ?
      AND json_extract(payload, '$.reason') IN ('findings','ci','review')
      AND id > COALESCE((SELECT MAX(id) FROM job
        WHERE queue = ? AND json_extract(payload, '$.itemId') = ?
          AND (job_key LIKE 'linear-turn:%' OR json_extract(payload, '$.reason') = 'answer')), 0)
  `)
      .get(JOB_KIND.resume, itemId, JOB_KIND.resume, itemId)?.count ?? 0
  );
}
