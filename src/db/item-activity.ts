import { and, eq, inArray, like, or } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { type Q, type Db } from "./db";
import { runnerCapacityWait } from "./items";
import { jsonField, parsedJson } from "./json-text";
import { runnerLeaseCutoff } from "./runner-lease";
import { usagePauseSteps, type UsagePause } from "./usage-pause";

export type ItemActivityFacts = {
  liveRunner: string | null;
  pinnedRunner: string | null;
  liveJob: boolean;
  slotWait: { since: number | null; runners: string[] } | null;
  usagePause: UsagePause | null;
  heldSince: number | null;
};

export function* itemActivityFactsSteps(
  q: Q,
  item: { id: string; currentRunId: string | null },
  now: number,
) {
  const { itemWait, job, runner, runnerWork } = q.t;
  const work =
    item.currentRunId === null
      ? undefined
      : yield* q.one(
          q.orm
            .select({
              name: runner.name,
              endedAt: runnerWork.endedAt,
              leaseUntil: runnerWork.leaseUntil,
            })
            .from(runnerWork)
            .innerJoin(runner, eq(runner.id, runnerWork.runnerId))
            .where(eq(runnerWork.runId, item.currentRunId)),
        );
  const jobs = yield* q.all(
    q.orm
      .select({
        status: job.status,
        lockedUntil: job.lockedUntil,
        lockedBy: job.lockedBy,
        attempts: job.attempts,
        payload: job.payload,
      })
      .from(job)
      .where(
        and(
          eq(jsonField(q, job.payload, "itemId"), item.id),
          inArray(job.status, ["pending", "running"]),
          or(
            inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify]),
            like(job.queue, `${JOB_KIND.reverify}.%`),
          ),
        ),
      ),
  );
  let liveJob = false;
  let slotWait: ItemActivityFacts["slotWait"] = null;
  for (const row of jobs) {
    const payload = parsedJson<{
      awakeWait?: { kind?: string; worker?: string; attempt?: number };
    }>(q, row.payload);
    const claimed = row.status === "running" && (row.lockedUntil ?? 0) > now;
    const wait = payload.awakeWait;
    const waits =
      claimed && wait?.worker === row.lockedBy && wait?.attempt === row.attempts
        ? wait?.kind
        : null;
    const capacity = runnerCapacityWait(payload);
    if (capacity && !claimed)
      slotWait = { since: capacity.since, runners: yield* runnerNamesSteps(q, capacity.runnerIds) };
    else if (waits === "runner") slotWait ??= { since: null, runners: [] };
    else if (claimed && !waits) liveJob = true;
  }
  const live =
    work !== undefined && work.endedAt === null && work.leaseUntil > runnerLeaseCutoff(now);
  const held = yield* q.one(
    q.orm
      .select({ since: itemWait.since })
      .from(itemWait)
      .where(and(eq(itemWait.itemId, item.id), eq(itemWait.kind, "item"))),
  );
  return {
    liveRunner: live ? work.name : null,
    pinnedRunner: work?.name ?? null,
    liveJob,
    slotWait,
    usagePause: item.currentRunId === null ? null : yield* usagePauseSteps(q, item.currentRunId),
    heldSince: held?.since ?? null,
  } satisfies ItemActivityFacts;
}

export async function itemActivityFacts(
  store: Db,
  item: { id: string; currentRunId: string | null },
  now: number,
): Promise<ItemActivityFacts> {
  return store.run((q) => itemActivityFactsSteps(q, item, now));
}

function* runnerNamesSteps(q: Q, ids: readonly string[]) {
  const { runner } = q.t;
  const names: string[] = [];
  for (const id of ids) {
    const row = yield* q.one(
      q.orm.select({ name: runner.name }).from(runner).where(eq(runner.id, id)),
    );
    names.push(row?.name ?? id);
  }
  return names;
}
