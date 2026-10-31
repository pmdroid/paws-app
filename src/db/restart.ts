import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { JOB_KIND, type RestartReason } from "../core";
import { halt } from "./halt";
import { applyWorkItemEvent, getWorkItem, saveCheckpoint, type WorkItemRecord } from "./items";
import { enqueueJobOnce } from "./jobs";
import { keepMergeQueuePlace } from "./merge-queue";
import { markRun } from "./runs";
import { immediate } from "./tx";

export type RestartHandoff = {
  reason: RestartReason;
  /** Only agent requests consume the lifetime budget. Answers are human requests by default. */
  source?: "agent" | "infrastructure" | "human";
  body: string;
  now: number;
  jobKey?: string;
  /** The fix-attempt limit this round's lines name, when it differs from the fix rounds. */
  limit?: number;
  keepMergeQueuePlace?: boolean;
};

/** `failed` means execution was already stopped and reported by the restart owner. */
export type RestartResult =
  | { kind: "restarted"; jobId: number }
  | { kind: "asked" }
  | { kind: "failed" }
  | { kind: "skipped" };
export type RestartOperation = (...args: Parameters<typeof restart>) => RestartResult;

/** Persist a restart admitted by src/loop. Keeps the run, branch and Linear session. */
export function restart(
  db: Database,
  item: WorkItemRecord,
  handoff: RestartHandoff,
): number | null {
  return immediate(db, () => {
    if (handoff.jobKey && db.query("SELECT 1 FROM job WHERE job_key=?").get(handoff.jobKey))
      return null;
    if (getWorkItem(db, item.id)?.version !== item.version) return null;
    if (handoff.keepMergeQueuePlace) keepMergeQueuePlace(db, item.id);
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
        ...(handoff.limit !== undefined ? { limit: handoff.limit } : {}),
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

/** The limit the latest restart of `itemId` recorded for its fix-attempt lines, if any. */
export function restartLimit(db: Database, itemId: string): number | null {
  const row = db
    .query<{ limit: number | null }, [string, string]>(`
    SELECT json_extract(payload, '$.limit') AS "limit" FROM job
    WHERE queue = ? AND json_extract(payload, '$.itemId') = ?
      AND json_extract(payload, '$.reason') IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `)
    .get(JOB_KIND.resume, itemId);
  return typeof row?.limit === "number" ? row.limit : null;
}
