import type { Database } from "bun:sqlite";
import { JOB_KIND, MERGE_LANE } from "../core";
import { enqueueJobOnce } from "../db";

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
