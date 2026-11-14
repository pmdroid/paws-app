import { and, eq, inArray, like, or } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { type Q, type Db } from "./db";
import { runnerCapacityWait } from "./items";
import { jsonField, parsedJson } from "./json-text";
import { runnerLeaseCutoff } from "./runner-lease";
import { usagePausesSteps, type UsagePause } from "./usage-pause";

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
  return (yield* itemActivityFactsForItemsSteps(q, [item], now)).get(item.id)!;
}

export function* itemActivityFactsForItemsSteps(
  q: Q,
  items: readonly { id: string; currentRunId: string | null }[],
  now: number,
) {
  const { itemWait, job, runner, runnerWork } = q.t;
  const itemIds = items.map((item) => item.id);
  const runIds = items.flatMap((item) => (item.currentRunId === null ? [] : [item.currentRunId]));
  const work = new Map(
    (yield* q.all(
      q.orm
        .select({
          runId: runnerWork.runId,
          name: runner.name,
          endedAt: runnerWork.endedAt,
          leaseUntil: runnerWork.leaseUntil,
        })
        .from(runnerWork)
        .innerJoin(runner, eq(runner.id, runnerWork.runnerId))
        .where(inArray(runnerWork.runId, runIds)),
    )).map((row) => [row.runId, row]),
  );
  const jobs = yield* q.all(
    q.orm
      .select({
        itemId: jsonField(q, job.payload, "itemId"),
        status: job.status,
        lockedUntil: job.lockedUntil,
        lockedBy: job.lockedBy,
        attempts: job.attempts,
        payload: job.payload,
      })
      .from(job)
      .where(
        and(
          inArray(jsonField(q, job.payload, "itemId"), itemIds),
          inArray(job.status, ["pending", "running"]),
          or(
            inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify]),
            like(job.queue, `${JOB_KIND.reverify}.%`),
          ),
        ),
      ),
  );
  const held = new Map(
    (yield* q.all(
      q.orm
        .select({ itemId: itemWait.itemId, since: itemWait.since })
        .from(itemWait)
        .where(and(inArray(itemWait.itemId, itemIds), eq(itemWait.kind, "item"))),
    )).map((row) => [row.itemId, row.since]),
  );
  const pauses = yield* usagePausesSteps(q, runIds);
  const facts = new Map<string, ItemActivityFacts>();
  for (const item of items) {
    let liveJob = false;
    let slotWait: ItemActivityFacts["slotWait"] = null;
    for (const row of jobs) {
      if (row.itemId !== item.id) continue;
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
        slotWait = {
          since: capacity.since,
          runners: yield* runnerNamesSteps(q, capacity.runnerIds),
        };
      else if (waits === "runner") slotWait ??= { since: null, runners: [] };
      else if (claimed && !waits) liveJob = true;
    }
    const current = item.currentRunId === null ? undefined : work.get(item.currentRunId);
    const live =
      current !== undefined &&
      current.endedAt === null &&
      current.leaseUntil > runnerLeaseCutoff(now);
    facts.set(item.id, {
      liveRunner: live ? current.name : null,
      pinnedRunner: current?.name ?? null,
      liveJob,
      slotWait,
      usagePause: item.currentRunId === null ? null : (pauses.get(item.currentRunId) ?? null),
      heldSince: held.get(item.id) ?? null,
    });
  }
  return facts;
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
