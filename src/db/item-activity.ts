import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import { runnerCapacityWait } from "./items";
import { runnerLeaseCutoff } from "./runner-lease";
import { usagePause, type UsagePause } from "./usage-pause";

export type ItemActivityFacts = {
  liveRunner: string | null;
  pinnedRunner: string | null;
  liveJob: boolean;
  slotWait: { since: number | null; runners: string[] } | null;
  usagePause: UsagePause | null;
  heldSince: number | null;
};

type JobRow = {
  status: string;
  lockedUntil: number | null;
  lockedBy: string | null;
  attempts: number;
  payload: string;
};

export function itemActivityFacts(
  db: Database,
  item: { id: string; currentRunId: string | null },
  now: number,
): ItemActivityFacts {
  const work =
    item.currentRunId === null
      ? null
      : db
          .query<{ name: string; live: number }, [number, string]>(
            `SELECT r.name,(w.ended_at IS NULL AND w.lease_until>?) AS live FROM runner_work w
             JOIN runner r ON r.id=w.runner_id WHERE w.run_id=?`,
          )
          .get(runnerLeaseCutoff(now), item.currentRunId);
  const jobs = db
    .query<JobRow, [string, string, string, string]>(
      `SELECT status,locked_until AS lockedUntil,locked_by AS lockedBy,attempts,payload FROM job
       WHERE json_extract(payload,'$.itemId')=?1 AND status IN ('pending','running')
       AND (queue IN (?2,?3,?4) OR queue LIKE (?4 || '.%'))`,
    )
    .all(item.id, JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify);
  let liveJob = false;
  let slotWait: ItemActivityFacts["slotWait"] = null;
  for (const job of jobs) {
    const payload = JSON.parse(job.payload) as {
      awakeWait?: { kind?: string; worker?: string; attempt?: number };
    };
    const claimed = job.status === "running" && (job.lockedUntil ?? 0) > now;
    const wait = payload.awakeWait;
    const waits =
      claimed && wait?.worker === job.lockedBy && wait?.attempt === job.attempts
        ? wait?.kind
        : null;
    const capacity = runnerCapacityWait(payload);
    if (capacity && !claimed)
      slotWait = { since: capacity.since, runners: runnerNames(db, capacity.runnerIds) };
    else if (waits === "runner") slotWait ??= { since: null, runners: [] };
    else if (claimed && !waits) liveJob = true;
  }
  return {
    liveRunner: work?.live === 1 ? work.name : null,
    pinnedRunner: work?.name ?? null,
    liveJob,
    slotWait,
    usagePause: item.currentRunId === null ? null : usagePause(db, item.currentRunId),
    heldSince:
      db
        .query<{ since: number }, [string]>("SELECT since FROM item_wait WHERE item_id=?")
        .get(item.id)?.since ?? null,
  };
}

function runnerNames(db: Database, ids: readonly string[]): string[] {
  return ids.map(
    (id) =>
      db.query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?").get(id)?.name ??
      id,
  );
}
