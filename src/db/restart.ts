import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  like,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { JOB_KIND, type RestartReason } from "../core";
import { settled, sqliteDb, type Db, type Q, type Steps } from "./db";
import { haltSteps } from "./halt";
import { applyWorkItemEventSteps, saveCheckpointSteps, type WorkItemRecord } from "./items";
import { emitJobReady, reenqueueJobSteps } from "./jobs";
import { mergeCallInFlightSteps } from "./remote-merges";
import { markRunSteps } from "./runs";

export type RestartHandoff = {
  reason: RestartReason;
  body: string;
  now: number;
  jobKey?: string;
  /** The fix-attempt limit this round's lines name, when it differs from the fix rounds. */
  limit?: number;
  fixRound?: boolean;
};

/**
 * One admission path back to the agent. Keeps the run, branch and Linear session. Returns null,
 * like a stale item, while a squash for the item may have reached GitHub: the merge lane owns the
 * item until GitHub confirms that outcome.
 */
export function restart(
  db: Database,
  item: WorkItemRecord,
  handoff: RestartHandoff,
): number | null {
  const result = settled(sqliteDb(db).transaction((q) => restartSteps(q, item, handoff)));
  if (result?.armed) emitJobReady(db);
  return result?.id ?? null;
}

export async function restartAsync(
  store: Db,
  item: WorkItemRecord,
  handoff: RestartHandoff,
): Promise<number | null> {
  const result = await store.transaction((q) => restartSteps(q, item, handoff));
  if (result?.armed) emitJobReady(store);
  return result?.id ?? null;
}

export function* restartSteps(
  q: Q,
  item: WorkItemRecord,
  handoff: RestartHandoff,
): Steps<{ id: number; armed: boolean } | null> {
  const { workItem } = q.t;
  if (yield* mergeCallInFlightSteps(q, item.id)) return null;
  if (!(yield* haltSteps(q, item, handoff.now))) return null;
  if (item.currentRunId) yield* markRunSteps(q, item.currentRunId, "ended", handoff.now);
  if (item.state === "failed")
    yield* q.exec(
      q.orm
        .update(workItem)
        .set({ cancelRequested: 0, recoveryAttempts: 0 })
        .where(eq(workItem.id, item.id)),
    );
  const record = {
    kind: "restart" as const,
    reason: handoff.reason,
    payloadDigest: createHash("sha256").update(handoff.body).digest("hex"),
    now: handoff.now,
  };
  const queued = yield* applyWorkItemEventSteps(q, item.id, "restart", record);
  if (item.checkpoint)
    yield* saveCheckpointSteps(q, item.id, { ...item.checkpoint, phase: "running" });
  const jobKey = handoff.jobKey ?? `restart:${item.id}:${queued.version}`;
  const after = yield* latestHumanTurnSteps(q, item.id);
  const payload = {
    itemId: item.id,
    runId: item.currentRunId,
    handoff: handoff.body,
    reason: handoff.reason,
    ...(handoff.limit !== undefined ? { limit: handoff.limit } : {}),
    ...(handoff.fixRound ? { fixRound: true } : {}),
  };
  const job = yield* reenqueueJobSteps(
    q,
    {
      queue: JOB_KIND.resume,
      jobKey,
      payload,
      now: handoff.now,
    },
    (previous) => {
      if (!FIX_REASONS.includes(handoff.reason) && !handoff.fixRound) return payload;
      const old = previous?.payload as { fixRoundsAfter?: number; fixRounds?: number } | undefined;
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
  return { id: job.id, armed: job.armed };
}

const FIX_REASONS: readonly string[] = ["findings", "ci", "review"];

type Payload =
  | "itemId"
  | "reason"
  | "handoff"
  | "fixRound"
  | "fixRounds"
  | "fixRoundsAfter"
  | "limit";

/** A payload field as text: `json_extract` on SQLite, `->>` on Postgres. */
function text(q: Q, key: Payload): SQL {
  const { payload } = q.t.job;
  return q.dialect === "sqlite"
    ? sql`json_extract(${payload}, ${sql.raw(`'$.${key}'`)})`
    : sql`(${payload}->>${sql.raw(`'${key}'`)})`;
}

/** A numeric payload field, null when it holds anything else, as `json_extract` returns it. */
function number(q: Q, key: Payload): SQL {
  const { payload } = q.t.job;
  const field = sql.raw(`'${key}'`);
  return q.dialect === "sqlite"
    ? text(q, key)
    : sql`(CASE WHEN jsonb_typeof(${payload}->${field}) = 'number'
        THEN (${payload}->>${field})::float8 END)`;
}

/** A payload field is `true` or `1`. */
function one(q: Q, key: Payload): SQL {
  const { payload } = q.t.job;
  return q.dialect === "sqlite"
    ? sql`${text(q, key)} = 1`
    : sql`COALESCE((${payload}->${sql.raw(`'${key}'`)}) IN ('true'::jsonb, '1'::jsonb), false)`;
}

export function* latestHumanTurnSteps(q: Q, itemId: string): Steps<number> {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: sql<number>`COALESCE(MAX(${job.activationId}), 0)`.mapWith(Number) })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.resume),
          sql`${text(q, "itemId")} = ${itemId}`,
          or(
            (q.dialect === "sqlite" ? like : ilike)(job.jobKey, "linear-turn:%"),
            sql`${text(q, "reason")} = 'answer'`,
          ),
        ),
      ),
  );
  return row!.id;
}

/** Restarts of `itemId` whose job key starts with `prefix`, since the latest human turn. */
export function* restartsSinceHumanTurnSteps(q: Q, itemId: string, prefix: string): Steps<number> {
  const { job } = q.t;
  const after = yield* latestHumanTurnSteps(q, itemId);
  const row = yield* q.one(
    q.orm
      .select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.resume),
          sql`${text(q, "itemId")} = ${itemId}`,
          // A plain prefix comparison: `_` and `%` in a job key are not wildcards.
          sql`substr(${job.jobKey}, 1, ${prefix.length}) = ${prefix}`,
          gt(job.activationId, after),
        ),
      ),
  );
  return row!.count;
}

export async function restartsSinceHumanTurn(
  store: Db,
  itemId: string,
  prefix: string,
): Promise<number> {
  return store.run((q) => restartsSinceHumanTurnSteps(q, itemId, prefix));
}

/** Latest human retry window, ordered by activation rather than reusable row id. */
export function latestHumanTurn(db: Database, itemId: string): number {
  return settled(sqliteDb(db).run((q) => latestHumanTurnSteps(q, itemId)));
}

export function* fixRoundsSteps(q: Q, itemId: string): Steps<number> {
  const { job } = q.t;
  const after = yield* latestHumanTurnSteps(q, itemId);
  const row = yield* q.one(
    q.orm
      .select({
        count: sql<number>`COALESCE(SUM(COALESCE(${number(q, "fixRounds")}, 1)), 0)`.mapWith(
          Number,
        ),
      })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.resume),
          sql`${text(q, "itemId")} = ${itemId}`,
          or(sql`${text(q, "reason")} IN ('findings', 'ci', 'review')`, one(q, "fixRound")),
          or(
            sql`${number(q, "fixRoundsAfter")} = ${after}`,
            and(sql`${text(q, "fixRoundsAfter")} IS NULL`, gt(job.activationId, after)),
          ),
        ),
      ),
  );
  return row!.count;
}

export async function fixRounds(store: Db, itemId: string): Promise<number> {
  return store.run((q) => fixRoundsSteps(q, itemId));
}

export function* restartLimitSteps(q: Q, itemId: string): Steps<number | null> {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ limit: sql<unknown>`${number(q, "limit")}` })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.resume),
          sql`${text(q, "itemId")} = ${itemId}`,
          sql`${text(q, "reason")} IS NOT NULL`,
        ),
      )
      .orderBy(desc(job.activationId))
      .limit(1),
  );
  return typeof row?.limit === "number" ? row.limit : null;
}

export function* pendingRestartHandoffSteps(
  q: Q,
  itemId: string,
): Steps<{ handoff?: string; limit?: number }> {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        status: job.status,
        handoff: sql<string | null>`${text(q, "handoff")}`,
        limit: sql<unknown>`${number(q, "limit")}`,
        runAt: job.runAt,
      })
      .from(job)
      .where(
        and(
          inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume]),
          sql`${text(q, "itemId")} = ${itemId}`,
        ),
      )
      .orderBy(desc(job.activationId))
      .limit(1),
  );
  if (!row || !row.handoff?.trim()) return {};
  if (row.status === "done" && !(yield* turnInterruptedSinceSteps(q, itemId, row.runAt))) return {};
  return { handoff: row.handoff, ...(typeof row.limit === "number" ? { limit: row.limit } : {}) };
}

/**
 * Recover the latest unfinished agent input. Inspect the latest activation before its handoff
 * so an older cancelled job cannot resurrect input after a newer turn completed.
 */
export async function pendingRestartHandoff(
  store: Db,
  itemId: string,
): Promise<{ handoff?: string; limit?: number }> {
  return store.run((q) => pendingRestartHandoffSteps(q, itemId));
}

const UNSETTLED_EXITS = ["lease_expired", "deferred"];

function* turnInterruptedSinceSteps(q: Q, itemId: string, since: number): Steps<boolean> {
  const { workItemEvent } = q.t;
  const started = (yield* q.one(
    q.orm
      .select({ id: sql<number | null>`max(${workItemEvent.id})`.mapWith(Number) })
      .from(workItemEvent)
      .where(
        and(
          eq(workItemEvent.itemId, itemId),
          eq(workItemEvent.toState, "running"),
          gte(workItemEvent.at, since),
        ),
      ),
  ))?.id;
  if (started == null) return false;
  const settledExit = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workItemEvent)
      .where(
        and(
          eq(workItemEvent.itemId, itemId),
          eq(workItemEvent.fromState, "running"),
          gt(workItemEvent.id, started),
          notInArray(workItemEvent.event, UNSETTLED_EXITS),
        ),
      )
      .limit(1),
  );
  return settledExit === undefined;
}
