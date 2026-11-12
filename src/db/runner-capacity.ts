import type { RunnerCapacityWaitState } from "./items";
import { CONVERSATION_TOOLS_RUNNER_VERSION, runnerReleaseAtLeast } from "../runner-protocol";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Q, Steps, Db } from "./db";
import { JOB_KIND } from "../core";
import { runnerCapacityWait } from "./items";
import { emitJobReady } from "./jobs";
import { jsonField, jsonText, jsonValue } from "./json-text";
import { schedulerRunnerSlotsSteps } from "./scheduling";
import { runnerLeaseCutoff } from "./runner-lease";
import { auditWorkspaceAccessSteps } from "./workspace";

export const ciWaitingSql = (q: Q, run: string): SQL =>
  sql.raw(
    q.dialect === "sqlite"
      ? `EXISTS(SELECT 1 FROM job ci WHERE ci.status='running' AND json_extract(ci.payload,'$.itemId')=${run}.item_id
    AND json_extract(ci.payload,'$.awakeWait.kind')='ci')`
      : `EXISTS(SELECT 1 FROM job ci WHERE ci.status='running' AND (ci.payload->>'itemId')=${run}.item_id
    AND (ci.payload->'awakeWait'->>'kind')='ci')`,
  );

export const workHelperSql = (q: Q, helper: string): SQL =>
  sql.raw(
    q.dialect === "sqlite"
      ? `${helper}.purpose IS NOT 'conversation'`
      : `${helper}.purpose IS DISTINCT FROM 'conversation'`,
  );

export const TEARDOWN_UNRESOLVED = `(w.ended_at IS NOT NULL AND w.teardown_confirmed_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM runner_result exited WHERE exited.run_id=w.run_id
    AND exited.generation=w.generation AND exited.command_id=w.command_id)
  AND NOT EXISTS(SELECT 1 FROM runner owner WHERE owner.id=w.runner_id AND (
    (w.confirmed_at IS NULL AND owner.terminations_since IS NOT NULL
      AND owner.live_reported_at>=owner.terminations_since AND EXISTS(
        SELECT 1 FROM runner_command undelivered WHERE undelivered.id=w.command_id
        AND undelivered.acknowledged_at IS NULL AND owner.live_reported_at>undelivered.expires_at))
    OR (w.lost_at IS NOT NULL AND w.lost_at<COALESCE(owner.terminations_since,w.lost_at+1))
    OR EXISTS(SELECT 1 FROM runner_command stopped WHERE stopped.runner_id=w.runner_id
      AND stopped.run_id=w.run_id AND stopped.generation=w.generation AND stopped.kind='cancel'
      AND stopped.acknowledged_at<COALESCE(owner.terminations_since,stopped.acknowledged_at+1)))))`;
const num = (fragment: SQL) => sql<number>`${fragment}`.mapWith(Number);

const teardownUnresolved = sql.raw(TEARDOWN_UNRESOLVED);

/**
 * Slots Paws may fill on a runner. A lowered desired value applies at once; a raised one waits
 * until the runner reports it applied the value.
 */
export function* runnerHasCapacitySteps(
  q: Q,
  runnerId: string,
  now: number,
  excludeRunId = "",
  additionalReservations = 0,
) {
  const row = yield* runnerOccupancySteps(q, runnerId, now, excludeRunId);
  return row.occupied + additionalReservations < row.capacity;
}

export async function runnerHasCapacity(
  store: Db,
  runnerId: string,
  now: number,
  excludeRunId = "",
  additionalReservations = 0,
): Promise<boolean> {
  return store.run((q) =>
    runnerHasCapacitySteps(q, runnerId, now, excludeRunId, additionalReservations),
  );
}

/** The slots Paws may fill on a runner and the slots leased work, helpers and retros fill now. */
export function* runnerOccupancySteps(q: Q, runnerId: string, now: number, excludeRunId = "") {
  const least = sql.raw(q.dialect === "sqlite" ? "MIN" : "LEAST");
  const row = yield* q.one(
    q.orm
      .select({
        capacity: num(
          sql`COALESCE((SELECT ${least}(capacity,COALESCE(desired,16)) FROM runner_capacity WHERE runner_id=${runnerId}),1)`,
        ),
        occupied:
          num(sql`(SELECT count(*) FROM runner_work w WHERE w.runner_id=${runnerId} AND ((w.ended_at IS NULL AND w.lease_until>${runnerLeaseCutoff(now)} AND w.run_id<>${excludeRunId})
            OR ${teardownUnresolved})) +
          (SELECT count(*) FROM runner_helper h WHERE h.runner_id=${runnerId} AND h.ended_at IS NULL AND h.expires_at>${now}
            AND ${workHelperSql(q, "h")}) +
          (SELECT count(*) FROM retro_dispatch WHERE runner_id=${runnerId} AND released_at IS NULL)`),
      })
      .from(sql`(SELECT 1) AS occupancy`),
  );
  return row!;
}

export async function runnerOccupancy(
  store: Db,
  runnerId: string,
  now: number,
  excludeRunId = "",
): Promise<{ capacity: number; occupied: number }> {
  return store.run((q) => runnerOccupancySteps(q, runnerId, now, excludeRunId));
}

export function* runnerSlotsHeldBetweenCommandsSteps(
  q: Q,
  runnerId: string,
  now: number,
  excludeRunId = "",
) {
  const w = alias(q.t.runnerWork, "w");
  const r = alias(q.t.run, "r");
  const { runnerResult: result } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ runId: w.runId })
      .from(w)
      .innerJoin(r, eq(r.id, w.runId))
      .where(
        and(
          eq(w.runnerId, runnerId),
          or(
            isNotNull(w.endedAt),
            and(
              lte(w.leaseUntil, runnerLeaseCutoff(now)),
              exists(
                q.orm
                  .select({ one: sql`1` })
                  .from(result)
                  .where(
                    and(
                      eq(result.runId, w.runId),
                      eq(result.generation, w.generation),
                      eq(result.commandId, w.commandId),
                    ),
                  ),
              ),
            ),
          ),
          inArray(r.status, ["active", "provisioning"]),
          sql`NOT ${teardownUnresolved}`,
          sql`NOT ${ciWaitingSql(q, "r")}`,
          sql`NOT EXISTS(SELECT 1 FROM runner_execution_usage u WHERE u.run_id=w.run_id
            AND u.runner_id<>w.runner_id AND u.ended_at IS NOT NULL AND NOT EXISTS(
              SELECT 1 FROM runner_execution_usage later WHERE later.run_id=u.run_id
              AND later.started_at>u.started_at))`,
        ),
      ),
  );
  const holders = rows.map((row) => row.runId);
  return holders.includes(excludeRunId) ? 0 : holders.length;
}

function* runnerOccupancyCapacitySteps(q: Q, runnerId: string) {
  const { runnerCapacity } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ capacity: runnerCapacity.capacity, desired: runnerCapacity.desired })
      .from(runnerCapacity)
      .where(eq(runnerCapacity.runnerId, runnerId)),
  );
  return row ? Math.min(row.capacity, row.desired ?? 16) : 0;
}

export async function runnerSlotsHeldBetweenCommands(
  store: Db,
  runnerId: string,
  now: number,
  excludeRunId = "",
): Promise<number> {
  return store.run((q) => runnerSlotsHeldBetweenCommandsSteps(q, runnerId, now, excludeRunId));
}

export function* activeRunnerIdsSteps(q: Q, now: number) {
  const { runner } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: runner.id })
      .from(runner)
      .where(
        and(
          eq(runner.status, "active"),
          isNull(runner.revokedAt),
          gt(runner.lastSeenAt, now - 60_000),
        ),
      ),
  );
  return rows.map((row) => row.id);
}

export async function activeRunnerIds(store: Db, now: number): Promise<string[]> {
  return store.run((q) => activeRunnerIdsSteps(q, now));
}

export function* slotWaitRunnersSteps(
  q: Q,
  runId: string,
  wait: RunnerCapacityWaitState,
  now: number,
): Steps<readonly string[]> {
  if (wait.runnerIds.length === 0) return wait.runnerIds;
  const { runnerWork } = q.t;
  const placed = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runnerWork)
      .where(eq(runnerWork.runId, runId))
      .limit(1),
  );
  if (placed) return wait.runnerIds;
  const known = new Set([...wait.runnerIds, ...(wait.online ?? [])]);
  const active = yield* activeRunnerIdsSteps(q, now);
  return [...wait.runnerIds, ...active.filter((id) => !known.has(id))];
}

export async function slotWaitRunners(
  store: Db,
  runId: string,
  wait: RunnerCapacityWaitState,
  now: number,
): Promise<readonly string[]> {
  return store.run((q) => slotWaitRunnersSteps(q, runId, wait, now));
}

export function* runnerSlotFreeSteps(q: Q, runnerIds: readonly string[], now: number, runId = "") {
  const ids = runnerIds.length ? runnerIds : yield* activeRunnerIdsSteps(q, now);
  for (const id of ids) {
    const held = yield* runnerSlotsHeldBetweenCommandsSteps(q, id, now, runId);
    if (yield* runnerHasCapacitySteps(q, id, now, runId, held)) return true;
  }
  return false;
}

export function* wakeRunnerSlotWaitsSteps(q: Q, runnerId: string, now: number): Steps<boolean> {
  const { job } = q.t;
  const parked = yield* q.all(
    q.orm
      .select({ id: job.id, payload: jsonText(q, job.payload) })
      .from(job)
      .where(
        and(
          eq(job.status, "pending"),
          inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify]),
          isNotNull(jsonField(q, job.payload, "capacityWait")),
        ),
      ),
  );
  let woke = false;
  for (const row of parked) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const wait = runnerCapacityWait(payload);
    if (!wait) continue;
    woke = true;
    const online = wait.online?.filter((id) => id !== runnerId);
    yield* q.exec(
      q.orm
        .update(job)
        .set({
          runAt: now,
          payload: jsonValue(q, {
            ...payload,
            capacityWait: {
              ...wait,
              // Placed runs keep a bounded retry list too. Recheck the runner whose
              // eligibility changed; placement still enforces scope and online pins.
              runnerIds: wait.runnerIds.length ? [...new Set([...wait.runnerIds, runnerId])] : [],
              ...(online ? { online } : {}),
            },
          }),
        })
        .where(and(eq(job.id, row.id), eq(job.status, "pending"))),
    );
  }
  const tickIsLater = and(
    eq(job.queue, JOB_KIND.schedulerTick),
    eq(job.status, "pending"),
    gt(job.runAt, now),
  );
  const tick = yield* q.one(q.orm.select({ id: job.id }).from(job).where(tickIsLater).limit(1));
  if (!tick) return woke;
  yield* q.exec(q.orm.update(job).set({ runAt: now }).where(tickIsLater));
  return true;
}

export async function wakeRunnerSlotWaits(store: Db, runnerId: string, now: number): Promise<void> {
  if (await store.run((q) => wakeRunnerSlotWaitsSteps(q, runnerId, now))) emitJobReady(store);
}

export async function runnerSlotFree(
  store: Db,
  runnerIds: readonly string[],
  now: number,
  runId = "",
): Promise<boolean> {
  return store.run((q) => runnerSlotFreeSteps(q, runnerIds, now, runId));
}

/**
 * Records the capacity a runner applied and, from runners that report it, the host ceiling.
 * Returns the concurrency the runner should apply, or undefined for runners that do not report a
 * ceiling (older releases reject unknown reply fields).
 */
export function* recordRunnerCapacitySteps(
  q: Q,
  runnerId: string,
  capacity: number,
  ceiling?: number,
  conversations?: number,
): Steps<number | undefined> {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16)
    throw new Error("Invalid runner capacity");
  if (
    ceiling !== undefined &&
    (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 16 || capacity > ceiling)
  )
    throw new Error("Invalid runner capacity ceiling");
  if (
    conversations !== undefined &&
    (!Number.isSafeInteger(conversations) || conversations < 0 || conversations > 16)
  )
    throw new Error("Invalid runner conversation capacity");
  const { runnerCapacity } = q.t;
  yield* q.exec(
    q.orm
      .insert(runnerCapacity)
      .values({
        runnerId,
        capacity,
        ceiling: ceiling ?? null,
        conversation: conversations ?? null,
      })
      .onConflictDoUpdate({
        target: runnerCapacity.runnerId,
        set: {
          capacity: sql`excluded.capacity`,
          ceiling: sql`excluded.ceiling`,
          conversation: sql`excluded.conversation`,
        },
      }),
  );
  if (ceiling === undefined) return undefined;
  const row = yield* q.one(
    q.orm
      .select({ desired: runnerCapacity.desired })
      .from(runnerCapacity)
      .where(eq(runnerCapacity.runnerId, runnerId)),
  );
  return Math.min(row?.desired ?? ceiling, ceiling);
}

/**
 * recordRunnerCapacity's queries: `woke` says the caller emits job ready once they commit, as
 * the wrapper does.
 */
export function* recordRunnerCapacityWakingSteps(
  q: Q,
  runnerId: string,
  capacity: number,
  ceiling: number | undefined,
  conversations: number | undefined,
  now: number,
): Steps<{ concurrency: number | undefined; woke: boolean }> {
  const before = yield* runnerOccupancyCapacitySteps(q, runnerId);
  const concurrency = yield* recordRunnerCapacitySteps(
    q,
    runnerId,
    capacity,
    ceiling,
    conversations,
  );
  const woke =
    (yield* runnerOccupancyCapacitySteps(q, runnerId)) > before &&
    (yield* wakeRunnerSlotWaitsSteps(q, runnerId, now));
  return { concurrency, woke };
}

export async function recordRunnerCapacity(
  store: Db,
  runnerId: string,
  capacity: number,
  ceiling?: number,
  conversations?: number,
  now = Date.now(),
): Promise<number | undefined> {
  const before = await store.run((q) => runnerOccupancyCapacitySteps(q, runnerId));
  const result = await store.run((q) =>
    recordRunnerCapacitySteps(q, runnerId, capacity, ceiling, conversations),
  );
  if ((await store.run((q) => runnerOccupancyCapacitySteps(q, runnerId))) > before)
    await wakeRunnerSlotWaits(store, runnerId, now);
  return result;
}

export class RunnerConcurrencyError extends Error {}

type RunnerConcurrencyInput = {
  runnerId: string;
  workspaceId: string;
  userId: string;
  concurrency: number;
  now: number;
};

/** Stores the concurrency an admin chose, from 1 up to the ceiling the runner reported. */
export function* setRunnerConcurrencySteps(q: Q, input: RunnerConcurrencyInput) {
  const { runner, runnerCapacity } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ ceiling: runnerCapacity.ceiling })
      .from(runner)
      .leftJoin(runnerCapacity, eq(runnerCapacity.runnerId, runner.id))
      .where(
        and(
          eq(runner.id, input.runnerId),
          eq(runner.workspaceId, input.workspaceId),
          isNull(runner.revokedAt),
        ),
      ),
  );
  if (!row) throw new Error("Runner is unavailable.");
  if (row.ceiling === null)
    throw new RunnerConcurrencyError(
      "Update this runner to set its concurrency from Paws. It uses its config value until then.",
    );
  if (
    !Number.isSafeInteger(input.concurrency) ||
    input.concurrency < 1 ||
    input.concurrency > row.ceiling
  )
    throw new RunnerConcurrencyError(
      `Concurrency must be from 1 to ${row.ceiling}, the limit set on the host.`,
    );
  yield* q.exec(
    q.orm
      .update(runnerCapacity)
      .set({ desired: input.concurrency })
      .where(eq(runnerCapacity.runnerId, input.runnerId)),
  );
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    action: "runner.concurrency",
    subject: input.runnerId,
    now: input.now,
  });
}

export async function setRunnerConcurrency(
  store: Db,
  input: RunnerConcurrencyInput,
): Promise<void> {
  await store.transaction((q) => setRunnerConcurrencySteps(q, input));
}

/** A runner slot the scheduler reserved for an item resuming on its pinned runner. */
export type PinnedSlot = { runnerId: string; order: number };

const reservingJobs = (q: Q) => inArray(q.t.job.queue, ["run.resume", "run.reverify"]);

/** True when the payload holds a reservation; a JSON null counts as none on both dialects. */
const holdsPinnedSlot = (q: Q) => isNotNull(jsonField(q, q.t.job.payload, "pinnedSlot"));

const withoutPinnedSlot = (q: Q): SQL =>
  q.dialect === "sqlite"
    ? sql`json_remove(${q.t.job.payload},'$.pinnedSlot')`
    : sql`${q.t.job.payload} - 'pinnedSlot'`;

/**
 * Saves the slots the scheduler reserved this tick on the pending resume and reverify jobs that
 * wait for them, and releases every other reservation those jobs held.
 */
export function* savePinnedSlotsSteps(q: Q, slots: ReadonlyMap<number, PinnedSlot>) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ payload: withoutPinnedSlot(q) })
      .where(
        and(
          eq(job.status, "pending"),
          reservingJobs(q),
          holdsPinnedSlot(q),
          notInArray(job.id, [...slots.keys()]),
        ),
      ),
  );
  for (const [id, slot] of slots) {
    const text = JSON.stringify(slot);
    yield* q.exec(
      q.orm
        .update(job)
        .set({
          payload:
            q.dialect === "sqlite"
              ? sql`json_set(${job.payload},'$.pinnedSlot',json(${text}))`
              : sql`jsonb_set(${job.payload},'{pinnedSlot}',${text}::text::jsonb)`,
        })
        .where(
          and(
            eq(job.id, id),
            eq(job.status, "pending"),
            q.dialect === "sqlite"
              ? sql`json_extract(${job.payload},'$.pinnedSlot') IS NOT json(${text})`
              : sql`${job.payload}->'pinnedSlot' IS DISTINCT FROM ${text}::text::jsonb`,
          ),
        ),
    );
  }
}

export async function savePinnedSlots(
  store: Db,
  slots: ReadonlyMap<number, PinnedSlot>,
): Promise<void> {
  await store.run((q) => savePinnedSlotsSteps(q, slots));
}

/** Releases the item's reservation once its run is placed. */
export function* releasePinnedSlotSteps(q: Q, itemId: string) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ payload: withoutPinnedSlot(q) })
      .where(
        and(
          reservingJobs(q),
          inArray(job.status, ["pending", "running"]),
          eq(jsonField(q, job.payload, "itemId"), itemId),
          holdsPinnedSlot(q),
        ),
      ),
  );
}

export async function releasePinnedSlot(store: Db, itemId: string): Promise<void> {
  await store.run((q) => releasePinnedSlotSteps(q, itemId));
}

/**
 * Slots on the runner reserved for other items that resume there. An item that holds a
 * reservation itself only yields to the reservations ranked ahead of its own.
 */
export function* pinnedSlotsReservedSteps(q: Q, runnerId: string, itemId: string, now: number) {
  const { job } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        itemId: jsonField(q, job.payload, "itemId"),
        runnerId: jsonField(q, job.payload, "pinnedSlot", "runnerId"),
        slotOrder: num(jsonField(q, job.payload, "pinnedSlot", "order")),
      })
      .from(job)
      .where(
        and(
          reservingJobs(q),
          holdsPinnedSlot(q),
          or(
            eq(job.status, "pending"),
            and(eq(job.status, "running"), or(isNull(job.lockedUntil), gt(job.lockedUntil, now))),
          ),
        ),
      )
      .orderBy(asc(job.id)),
  );
  const own = rows.find((row) => row.itemId === itemId && row.runnerId === runnerId)?.slotOrder;
  const admitted = (yield* schedulerRunnerSlotsSteps(q, now)).filter(
    (row) => row.itemId !== itemId && row.runnerId === runnerId,
  );
  return new Set([
    ...admitted.map((row) => row.itemId),
    ...rows
      .filter(
        (row) =>
          row.itemId !== itemId &&
          row.runnerId === runnerId &&
          (own === undefined || row.slotOrder < own),
      )
      .map((row) => row.itemId),
  ]).size;
}

export async function pinnedSlotsReserved(
  store: Db,
  runnerId: string,
  itemId: string,
  now: number,
): Promise<number> {
  return store.run((q) => pinnedSlotsReservedSteps(q, runnerId, itemId, now));
}

export function* runnerCancelPendingSteps(q: Q, runnerId: string) {
  const w = alias(q.t.runnerWork, "w");
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(w)
      .where(and(eq(w.runnerId, runnerId), teardownUnresolved))
      .limit(1),
  );
  return row !== undefined;
}

export async function runnerCancelPending(store: Db, runnerId: string): Promise<boolean> {
  return store.run((q) => runnerCancelPendingSteps(q, runnerId));
}

export function* runTeardownOwnerSteps(q: Q, runId: string) {
  const w = alias(q.t.runnerWork, "w");
  const row = yield* q.one(
    q.orm
      .select({ runnerId: w.runnerId })
      .from(w)
      .where(and(eq(w.runId, runId), teardownUnresolved)),
  );
  return row?.runnerId ?? null;
}

export async function runTeardownOwner(store: Db, runId: string): Promise<string | null> {
  return store.run((q) => runTeardownOwnerSteps(q, runId));
}

/** The conversation slots a runner offers and whether its release can run conversations. */
function* conversationLaneSteps(q: Q, runnerId: string) {
  const { runnerCapacity, runnerHostStatus } = q.t;
  const capacity = yield* q.one(
    q.orm
      .select({ limit: runnerCapacity.conversation })
      .from(runnerCapacity)
      .where(eq(runnerCapacity.runnerId, runnerId)),
  );
  const status = yield* q.one(
    q.orm
      .select({ version: runnerHostStatus.runnerVersion })
      .from(runnerHostStatus)
      .where(eq(runnerHostStatus.runnerId, runnerId)),
  );
  return {
    limit: capacity?.limit ?? 0,
    // A conversation acts only through `reply` and `start_work`. Earlier runners refuse Claude's
    // calls to them in the read-only turn, and before 0.1.76 drop `replies` and `startWork` too.
    supported: runnerReleaseAtLeast(status?.version, CONVERSATION_TOOLS_RUNNER_VERSION),
  };
}

/** Read-only admission check. Helpers share one runtime slot, independently of work capacity.
 * A foreground helper may replace unfinished grouping, but only its dispatch may fence it. */
export function* runnerHelperAvailabilitySteps(
  q: Q,
  runnerId: string,
  now: number,
  foreground: boolean,
  conversation = false,
) {
  const { runnerHelper } = q.t;
  if (conversation) {
    const { limit, supported } = yield* conversationLaneSteps(q, runnerId);
    const inUse = yield* conversationsInUseSteps(q, [runnerId], now);
    return {
      available: supported && (inUse.get(runnerId) ?? 0) < limit,
      preempts: false,
      held: false,
    };
  }
  const rows = yield* q.all(
    q.orm
      .select({
        envelope: jsonText(q, runnerHelper.envelope),
        result: jsonText(q, runnerHelper.result) as SQL<string | null>,
      })
      .from(runnerHelper)
      .where(
        and(
          eq(runnerHelper.runnerId, runnerId),
          isNull(runnerHelper.endedAt),
          gt(runnerHelper.expiresAt, now),
          workHelperSql(q, "runner_helper"),
        ),
      ),
  );
  const maintenance = rows.filter((row) => {
    const envelope = JSON.parse(row.envelope) as { payload: string };
    const command = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as {
      type: string;
      purpose?: string;
    };
    return (
      foreground &&
      row.result === null &&
      command.type === "helper" &&
      command.purpose === "finding_groups"
    );
  }).length;
  const { occupied, capacity } = yield* runnerOccupancySteps(q, runnerId, now);
  const held = rows.length > maintenance || (yield* runnerSignInWaitingSteps(q, runnerId, now));
  return {
    available: !held && occupied - maintenance < capacity,
    preempts: maintenance > 0,
    held,
  };
}

export async function runnerHelperAvailability(
  store: Db,
  runnerId: string,
  now: number,
  foreground: boolean,
  conversation = false,
) {
  return store.run((q) =>
    runnerHelperAvailabilitySteps(q, runnerId, now, foreground, conversation),
  );
}

export function* runnerSignInWaitingSteps(q: Q, runnerId: string, now: number) {
  const { runnerCommand, runnerLogin } = q.t;
  const signIn = yield* q.one(
    q.orm
      .select({ id: runnerCommand.id })
      .from(runnerCommand)
      .innerJoin(runnerLogin, eq(runnerLogin.id, runnerCommand.id))
      .where(
        and(
          eq(runnerCommand.runnerId, runnerId),
          eq(runnerCommand.kind, "login"),
          gt(runnerCommand.expiresAt, now),
          inArray(runnerLogin.state, ["starting", "waiting"]),
        ),
      )
      .limit(1),
  );
  return signIn !== undefined;
}

export function* openSessionHelperSteps(q: Q, sessionId: string, generation: number, now: number) {
  const { runnerHelper } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: runnerHelper.id })
      .from(runnerHelper)
      .where(
        and(
          eq(runnerHelper.sessionId, sessionId),
          eq(runnerHelper.sessionGeneration, generation),
          inArray(runnerHelper.purpose, ["classify", "select_repository"]),
          isNull(runnerHelper.endedAt),
          gt(runnerHelper.expiresAt, now),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

export function* runnerHelperAcknowledgedSteps(q: Q, id: string) {
  const { runnerHelper } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ acknowledgedAt: runnerHelper.acknowledgedAt })
      .from(runnerHelper)
      .where(eq(runnerHelper.id, id)),
  );
  return row?.acknowledgedAt != null;
}

export async function openSessionHelper(
  store: Db,
  sessionId: string,
  generation: number,
  now: number,
) {
  return store.run((q) => openSessionHelperSteps(q, sessionId, generation, now));
}

export async function runnerHelperAcknowledged(store: Db, id: string): Promise<boolean> {
  return store.run((q) => runnerHelperAcknowledgedSteps(q, id));
}

/** Foreground session helpers fence unfinished maintenance work before taking its slot.
 * The runner renews helper authority before continuing, so the old turn is stopped before the next helper starts. */
export function* yieldFindingGroupHelpersSteps(q: Q, runnerId: string, now: number) {
  const { runnerHelper, runnerExecutionUsage } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: runnerHelper.id, envelope: jsonText(q, runnerHelper.envelope) })
      .from(runnerHelper)
      .where(
        and(
          eq(runnerHelper.runnerId, runnerId),
          isNull(runnerHelper.endedAt),
          gt(runnerHelper.expiresAt, now),
        ),
      ),
  );
  for (const row of rows) {
    const envelope = JSON.parse(row.envelope) as { payload: string };
    const command = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as {
      type: string;
      purpose?: string;
    };
    if (command.type !== "helper" || command.purpose !== "finding_groups") continue;
    yield* q.exec(
      q.orm
        .update(runnerHelper)
        .set({ endedAt: now })
        .where(
          and(
            eq(runnerHelper.id, row.id),
            isNull(runnerHelper.endedAt),
            isNull(runnerHelper.result),
          ),
        ),
    );
    yield* q.exec(
      q.orm
        .update(runnerExecutionUsage)
        .set({ endedAt: now, outcome: "preempted" })
        .where(
          and(
            eq(runnerExecutionUsage.commandId, row.id),
            isNull(runnerExecutionUsage.endedAt),
            exists(
              q.orm
                .select({ one: sql`1` })
                .from(runnerHelper)
                .where(and(eq(runnerHelper.id, row.id), isNotNull(runnerHelper.endedAt))),
            ),
          ),
        ),
    );
  }
}

export async function yieldFindingGroupHelpers(
  store: Db,
  runnerId: string,
  now: number,
): Promise<void> {
  await store.transaction((q) => yieldFindingGroupHelpersSteps(q, runnerId, now));
}

export function* runnerConversationLaneSteps(
  q: Q,
  runnerId: string,
  now: number,
): Steps<"closed" | "full" | "free"> {
  const { limit, supported } = yield* conversationLaneSteps(q, runnerId);
  if (limit <= 0 || !supported) return "closed";
  return (yield* runnerHelperAvailabilitySteps(q, runnerId, now, true, true)).available
    ? "free"
    : "full";
}

export async function runnerConversationLane(
  store: Db,
  runnerId: string,
  now: number,
): Promise<"closed" | "full" | "free"> {
  return store.run((q) => runnerConversationLaneSteps(q, runnerId, now));
}

export function* unfinishedConversationHelpersSteps(q: Q) {
  const { runnerHelper } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: runnerHelper.id,
        sessionId: runnerHelper.sessionId,
        envelope: jsonText(q, runnerHelper.envelope),
        result: jsonText(q, runnerHelper.result) as SQL<string | null>,
        expiresAt: runnerHelper.expiresAt,
      })
      .from(runnerHelper)
      .where(and(eq(runnerHelper.purpose, "conversation"), isNull(runnerHelper.endedAt))),
  );
}

export async function unfinishedConversationHelpers(store: Db) {
  return store.run((q) => unfinishedConversationHelpersSteps(q));
}

export function* conversationsInUseSteps(
  q: Q,
  runnerIds: readonly string[],
  now: number,
): Steps<Map<string, number>> {
  if (runnerIds.length === 0) return new Map();
  const { runnerHelper: helper } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ runnerId: helper.runnerId, used: count() })
      .from(helper)
      .where(
        and(
          inArray(helper.runnerId, [...runnerIds]),
          isNull(helper.endedAt),
          gt(helper.expiresAt, now),
          sql`NOT ${workHelperSql(q, "runner_helper")}`,
        ),
      )
      .groupBy(helper.runnerId),
  );
  return new Map(rows.map((row) => [row.runnerId, row.used]));
}
