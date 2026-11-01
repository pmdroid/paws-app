import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { JOB_KIND, type RestartReason } from "../core";
import { halt } from "./halt";
import { applyWorkItemEvent, saveCheckpoint, type WorkItemRecord } from "./items";
import { getJob, reenqueueJob } from "./jobs";
import { markRun } from "./runs";
import { immediate } from "./tx";

export type RestartHandoff = {
  reason: RestartReason;
  body: string;
  now: number;
  jobKey?: string;
  /** The fix-attempt limit this round's lines name, when it differs from the fix rounds. */
  limit?: number;
};

/** One admission path back to the agent. Keeps the run, branch and Linear session. */
export function restart(
  db: Database,
  item: WorkItemRecord,
  handoff: RestartHandoff,
): number | null {
  return immediate(db, () => {
    if (!halt(db, item, handoff.now)) return null;
    if (item.currentRunId) markRun(db, item.currentRunId, "ended", handoff.now);
    if (item.state === "failed")
      db.run(
        "UPDATE work_item SET cancel_requested=0,turn_count=0,recovery_attempts=0 WHERE id=?",
        [item.id],
      );
    else if (handoff.reason === "answer")
      db.run("UPDATE work_item SET turn_count=0 WHERE id=?", [item.id]);
    const record = {
      kind: "restart" as const,
      reason: handoff.reason,
      payloadDigest: createHash("sha256").update(handoff.body).digest("hex"),
      now: handoff.now,
    };
    const queued = applyWorkItemEvent(db, item.id, "restart", record);
    if (item.checkpoint) saveCheckpoint(db, item.id, { ...item.checkpoint, phase: "running" });
    const jobKey = handoff.jobKey ?? `restart:${item.id}:${queued.version}`;
    const after = humanTurnJobId(db, item.id);
    const previous = db
      .query<{ id: number }, [string]>("SELECT id FROM job WHERE job_key=?")
      .get(jobKey);
    const previousPayload = previous
      ? (getJob(db, previous.id)?.payload as Record<string, unknown>)
      : null;
    // Each revived row retains its contribution only within the same human retry window.
    const priorRounds =
      previous &&
      (previousPayload?.fixRoundsAfter === after ||
        (previousPayload?.fixRoundsAfter === undefined && previous.id > after))
        ? Number(previousPayload?.fixRounds ?? 1)
        : 0;
    const job = reenqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey,
      payload: {
        itemId: item.id,
        runId: item.currentRunId,
        handoff: handoff.body,
        reason: handoff.reason,
        ...(["findings", "ci", "review"].includes(handoff.reason)
          ? { fixRounds: priorRounds + 1, fixRoundsAfter: after }
          : {}),
        ...(handoff.limit !== undefined ? { limit: handoff.limit } : {}),
      },
      now: handoff.now,
    });
    if (!job.pending) throw new Error("restart requires a pending resume job");
    return job.id;
  });
}

function humanTurnJobId(db: Database, itemId: string): number {
  return db
    .query<{ id: number }, [string, string]>(`
    SELECT COALESCE(MAX(id), 0) AS id FROM job
    WHERE queue=? AND json_extract(payload,'$.itemId')=?
      AND (job_key LIKE 'linear-turn:%' OR json_extract(payload,'$.reason')='answer')
  `)
    .get(JOB_KIND.resume, itemId)!.id;
}

/** Fix restarts since the latest human turn, including repeated uses of one job row. */
export function fixRounds(db: Database, itemId: string): number {
  const after = humanTurnJobId(db, itemId);
  return db
    .query<{ count: number }, [string, string, number, number]>(`
    SELECT COALESCE(SUM(COALESCE(json_extract(payload,'$.fixRounds'),1)),0) AS count
    FROM job WHERE queue=? AND json_extract(payload,'$.itemId')=?
      AND json_extract(payload,'$.reason') IN ('findings','ci','review')
      AND (json_extract(payload,'$.fixRoundsAfter')=? OR
        (json_extract(payload,'$.fixRoundsAfter') IS NULL AND id>?))
  `)
    .get(JOB_KIND.resume, itemId, after, after)!.count;
}

/** The limit the latest restart of `itemId` recorded for its fix-attempt lines, if any. */
export function restartLimit(db: Database, itemId: string): number | null {
  const row = db
    .query<{ limit: number | null }, [string, string]>(`
    SELECT json_extract(payload, '$.limit') AS "limit" FROM job
    WHERE queue = ? AND json_extract(payload, '$.itemId') = ?
      AND json_extract(payload, '$.reason') IS NOT NULL
    ORDER BY item_version DESC, id DESC LIMIT 1
  `)
    .get(JOB_KIND.resume, itemId);
  return typeof row?.limit === "number" ? row.limit : null;
}
