import type { Database } from "bun:sqlite";
import { JOB_KIND, MERGE_LANE } from "../core";
import { enqueueJobOnce, type Job } from "../db";

export const MERGE_CI_POLL_MS = 10_000;
export const MERGE_CI_WAIT_MS = 269 * MERGE_CI_POLL_MS;

export type CiWaitVerification = {
  base: string;
  head: string;
  summary: string;
};

export function parkMergeForCi(
  db: Database,
  job: Job,
  now: number,
  verified?: Partial<CiWaitVerification>,
): "parked" | "expired" | "lost" {
  const payload = payloadRecord(job.payload);
  const head = verified?.head;
  const saved = payload.ciWaitDeadline;
  const sameHead = head === undefined || payload.ciWaitHead === head;
  const deadline =
    sameHead && typeof saved === "number" && Number.isFinite(saved)
      ? saved
      : now + MERGE_CI_WAIT_MS;
  if (sameHead && now >= deadline) return "expired";
  const result = db.run(
    `UPDATE job
     SET status = 'pending',
         run_at = ?,
         attempts = 0,
         locked_by = NULL,
         locked_until = NULL,
         payload = ?
     WHERE id = ? AND status = 'running' AND locked_by = ? AND locked_until > ?`,
    [
      now + MERGE_CI_POLL_MS,
      JSON.stringify({
        ...payload,
        ciWaitDeadline: deadline,
        ...(verified?.base === undefined ? {} : { ciWaitBase: verified.base }),
        ...(verified?.head === undefined ? {} : { ciWaitHead: verified.head }),
        ...(verified?.summary === undefined ? {} : { ciWaitSummary: verified.summary }),
      }),
      job.id,
      job.lockedBy,
      now,
    ],
  );
  return result.changes > 0 ? "parked" : "lost";
}

export function ciWaitVerification(payload: unknown): CiWaitVerification | undefined {
  const record = payloadRecord(payload);
  const base = record.ciWaitBase;
  const head = record.ciWaitHead;
  const summary = record.ciWaitSummary;
  if (typeof base !== "string" || base.length === 0) return undefined;
  if (typeof head !== "string" || head.length === 0) return undefined;
  if (typeof summary !== "string") return undefined;
  return { base, head, summary };
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  return { ...(payload as Record<string, unknown>) };
}

export function enqueueVerifiedMerge(
  db: Database,
  input: { itemId: string; head: string; summary: string; now: number; reverifyJobId?: number },
): number {
  const suffix = input.reverifyJobId === undefined ? "" : `:reverify:${input.reverifyJobId}`;
  return enqueueJobOnce(db, {
    queue: JOB_KIND.merge,
    lane: MERGE_LANE,
    jobKey: `merge:${input.itemId}:${input.head}${suffix}`,
    payload: { itemId: input.itemId, summary: input.summary, head: input.head },
    now: input.now,
  });
}
