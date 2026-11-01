import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { JOB_KIND, type RestartReason } from "../core";
import { halt } from "./halt";
import {
  applyWorkItemEvent,
  getWorkItem,
  heldHandoffs,
  markHandoffsCarried,
  saveCheckpoint,
  type WorkItemRecord,
} from "./items";
import { enqueueJobOnce, reenqueueJob } from "./jobs";
import { markRun } from "./runs";
import { immediate } from "./tx";
import { heldRestartDecision, restartAnswerAuthorized } from "./restart-decisions";

export type RestartHandoff = {
  reason: RestartReason;
  body: string;
  now: number;
  jobKey?: string;
  /** The fix-attempt limit this round's lines name, when it differs from the fix rounds. */
  limit?: number;
  /** Set only after authorizing a new user instruction or an explicit Resume control. */
  humanInitiated?: true;
};

/** One admission path back to the agent. Keeps the run, branch and Linear session. */
export function restart(
  db: Database,
  item: WorkItemRecord,
  handoff: RestartHandoff,
): number | null {
  return immediate(db, () => {
    if (getWorkItem(db, item.id)?.version !== item.version) return null;
    const held = heldRestartDecision(db, item);
    const humanInitiated =
      handoff.humanInitiated === true && ["follow_up", "conflict"].includes(handoff.reason);
    if (
      held &&
      item.state !== "failed" &&
      !humanInitiated &&
      !(handoff.reason === "answer" && restartAnswerAuthorized(db, item))
    ) {
      // Keep guidance that arrives while a person owns the next decision, without scheduling it.
      if (handoff.reason !== "answer") {
        const digest = createHash("sha256").update(handoff.body).digest("hex");
        const id = enqueueJobOnce(db, {
          queue: JOB_KIND.resume,
          jobKey: `restart-held:${item.id}:${item.version}:${digest}`,
          payload: { itemId: item.id, reason: "restart_hold", handoff: handoff.body },
          now: handoff.now,
        });
        db.run(
          "UPDATE job SET status='cancelled',last_error='restart_decision',finished_at=? WHERE id=? AND status='pending'",
          [handoff.now, id],
        );
      }
      return null;
    }
    if (!halt(db, item, handoff.now)) return null;
    db.run("DELETE FROM restart_decision WHERE item_id=?", [item.id]);
    if (humanInitiated)
      db.run(
        `UPDATE question SET cancelled_at=? WHERE item_id=? AND reason='restart'
      AND status IN ('open','queued') AND cancelled_at IS NULL`,
        [handoff.now, item.id],
      );
    if (item.currentRunId) markRun(db, item.currentRunId, "ended", handoff.now);
    if ((humanInitiated && item.cancelRequested) || item.state === "failed")
      db.run(
        "UPDATE work_item SET cancel_requested=0,turn_count=0,recovery_attempts=0 WHERE id=?",
        [item.id],
      );
    else if (handoff.reason === "answer")
      db.run("UPDATE work_item SET turn_count=0 WHERE id=?", [item.id]);
    const guidance = humanInitiated ? heldHandoffs(db, item.id) : [];
    const body = [...guidance.map((entry) => entry.handoff), handoff.body].join("\n\n");
    const record = {
      kind: "restart" as const,
      reason: handoff.reason,
      payloadDigest: createHash("sha256").update(body).digest("hex"),
      now: handoff.now,
    };
    const queued = applyWorkItemEvent(db, item.id, "restart", record);
    if (item.checkpoint) saveCheckpoint(db, item.id, { ...item.checkpoint, phase: "running" });
    const jobKey = handoff.jobKey ?? `restart:${item.id}:${queued.version}`;
    const after = latestHumanTurn(db, item.id);
    const payload = {
      itemId: item.id,
      runId: item.currentRunId,
      handoff: body,
      reason: handoff.reason,
      ...(handoff.limit !== undefined ? { limit: handoff.limit } : {}),
    };
    const job = reenqueueJob(
      db,
      {
        queue: JOB_KIND.resume,
        jobKey,
        payload,
        now: handoff.now,
      },
      (previous) => {
        if (!["findings", "ci", "review"].includes(handoff.reason)) return payload;
        const old = previous?.payload as
          | { fixRoundsAfter?: number; fixRounds?: number }
          | undefined;
        const inWindow =
          old?.fixRoundsAfter === after ||
          (old?.fixRoundsAfter === undefined && previous !== null && previous.activationId > after);
        return {
          ...payload,
          fixRounds: (inWindow ? (old?.fixRounds ?? 1) : 0) + 1,
          fixRoundsAfter: after,
        };
      },
    );
    if (!job.pending) throw new Error("restart requires a pending resume job");
    markHandoffsCarried(db, guidance);
    return job.id;
  });
}

/** Latest human retry window, ordered by activation rather than reusable row id. */
export function latestHumanTurn(db: Database, itemId: string): number {
  return db
    .query<{ id: number }, [string, string]>(`
    SELECT COALESCE(MAX(activation_id), 0) AS id FROM job
    WHERE queue=? AND json_extract(payload,'$.itemId')=?
      AND (job_key LIKE 'linear-turn:%' OR json_extract(payload,'$.reason')='answer')
  `)
    .get(JOB_KIND.resume, itemId)!.id;
}

/** Fix restarts since the latest human turn, including repeated uses of one job row. */
export function fixRounds(db: Database, itemId: string): number {
  const after = latestHumanTurn(db, itemId);
  return db
    .query<{ count: number }, [string, string, number, number]>(`
    SELECT COALESCE(SUM(COALESCE(json_extract(payload,'$.fixRounds'),1)),0) AS count
    FROM job WHERE queue=? AND json_extract(payload,'$.itemId')=?
      AND json_extract(payload,'$.reason') IN ('findings','ci','review')
      AND (json_extract(payload,'$.fixRoundsAfter')=? OR
        (json_extract(payload,'$.fixRoundsAfter') IS NULL AND activation_id>?))
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
    ORDER BY activation_id DESC LIMIT 1
  `)
    .get(JOB_KIND.resume, itemId);
  return typeof row?.limit === "number" ? row.limit : null;
}
