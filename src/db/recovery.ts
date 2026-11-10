import { journalCaught } from "../journal";
import { journal } from "./journal";
import { heartbeatInstanceSteps, ownerGoneSteps } from "./instances";
import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import {
  decideStartup,
  hasVerificationCandidate,
  JOB_KIND,
  MAX_TRANSIENT_RETRIES,
  OUTBOX_ACTIVITY,
  transientRetryDelayMs,
  type StartupDecision,
  type WorkItemState,
} from "../core";
import { applyDecisionSteps } from "./decisions";
import { emitJobReady, enqueueJobOnceSteps } from "./jobs";
import { enqueueOutboxOnceSteps } from "./outbox";
import {
  applyWorkItemEventSteps,
  getWorkItemSteps,
  listInFlightItems,
  listWorkItemsByStatesSteps,
  saveCheckpointSteps,
} from "./items";
import type { WorkItemRecord } from "./items";
import {
  runnerHoldsRunWorkSteps,
  runnerLeaseCutoff,
  shiftRunnerLeasesForDowntimeSteps,
} from "./runner-lease";
import { mergeCallInFlightSteps } from "./remote-merges";
import { ensureRestartQuestionSteps } from "./restart-hold";
import {
  claimRunSteps,
  getRunSteps,
  markRunSteps,
  releaseRunCapacitySteps,
  runOwnerSteps,
} from "./runs";
import { pendingRestartHandoffSteps } from "./restart";
import { jsonField } from "./json-text";
import { settled, sqliteDb, type Db, type Q, type Steps } from "./db";

/** Commit dirty files on the item branch. Sync, so shutdown can finish before exit. */
export type ShutdownWipCommit = (item: WorkItemRecord) => void;

const STARTUP_STATES = [
  "awaiting_input",
  "running",
  "verifying",
  "recovering",
  "merge_queue",
] as const satisfies readonly WorkItemState[];

const STARTUP_RESUME_SPACING_MS = 5_000;

export const RUN_TAKEOVER_JOB = "run.takeover";
export const RUN_TAKEOVER_MS = 30_000;

/**
 * On process start, resume a live run once or ask whether to start it again. An item in the merge
 * queue keeps its place; one whose merge call may have been in flight asks GitHub before it moves.
 * Downtime of the instance that owned a run, up to `offlineBudgetMs`, does not count against its
 * open runner lease while no other instance was alive.
 */
export function* recoverOnStartupSteps(
  q: Q,
  now: number,
  offlineBudgetMs: number | undefined,
  instanceId: string | undefined,
  wake: { armed: boolean },
) {
  yield* shiftRunnerLeasesForDowntimeSteps(q, now, offlineBudgetMs, instanceId);
  return yield* recoverItemsSteps(q, now, instanceId, true, wake);
}

export function recoverOnStartup(
  db: Database,
  now = Date.now(),
  offlineBudgetMs?: number,
  instanceId?: string,
): StartupDecision[] {
  const wake = { armed: false };
  const decisions = settled(
    sqliteDb(db).transaction((q) =>
      recoverOnStartupSteps(q, now, offlineBudgetMs, instanceId, wake),
    ),
  );
  if (wake.armed) emitJobReady(db);
  return decisions;
}

export function* takeOverGoneRunsSteps(
  q: Q,
  instanceId: string,
  now: number,
  wake: { armed: boolean },
) {
  yield* shiftRunnerLeasesForDowntimeSteps(q, now, undefined, instanceId);
  return yield* recoverItemsSteps(q, now, instanceId, false, wake);
}

export function takeOverGoneRuns(
  db: Database,
  instanceId: string,
  now = Date.now(),
): StartupDecision[] {
  const wake = { armed: false };
  const decisions = settled(
    sqliteDb(db).transaction((q) => takeOverGoneRunsSteps(q, instanceId, now, wake)),
  );
  if (wake.armed) emitJobReady(db);
  return decisions;
}

function* recoverItemsSteps(
  q: Q,
  now: number,
  instanceId: string | undefined,
  unowned: boolean,
  wake: { armed: boolean },
): Steps<StartupDecision[]> {
  const gone = instanceId === undefined ? null : yield* ownerGoneSteps(q, instanceId, now);
  const items: WorkItemRecord[] = [];
  for (const item of yield* listWorkItemsByStatesSteps(q, STARTUP_STATES)) {
    if (gone === null) {
      items.push(item);
      continue;
    }
    const owner = item.currentRunId === null ? null : yield* runOwnerSteps(q, item.currentRunId);
    if (owner === null ? unowned : gone(owner)) items.push(item);
  }
  const decisions: StartupDecision[] = [];
  let resumes = 0;
  const nextResumeAt = () => now + STARTUP_RESUME_SPACING_MS * resumes++;
  for (const item of items) {
    if (instanceId !== undefined && item.currentRunId !== null) {
      const from = yield* runOwnerSteps(q, item.currentRunId);
      yield* claimRunSteps(q, item.currentRunId, instanceId);
      if (from !== null)
        journal(
          `run ${item.currentRunId} taken over item=${item.id} from=${from} by=${instanceId}`,
        );
    }
    const restart = yield* ensureRestartQuestionSteps(q, item, now);
    if (restart.armed) wake.armed = true;
    if (restart.held) {
      decisions.push({ type: "ask_restart" });
      continue;
    }
    if (yield* hasParkedCapacityWaitSteps(q, item)) continue;
    if (yield* hasPendingAnswerResumeSteps(q, item.id)) continue;
    if (yield* hasPendingTransientRetrySteps(q, item)) continue;
    const holds = yield* runnerHoldsWorkSteps(q, item, now);
    const decision = decideStartup({
      itemState: item.state,
      recoveryAttempts: item.recoveryAttempts,
      checkpoint: item.checkpoint,
      runnerHoldsWork: holds,
      mergeCallInFlight: yield* mergeCallInFlightSteps(q, item.id),
      runActive: yield* runActiveSteps(q, item),
      ...(item.resumedAt === null ? {} : { sinceResumeMs: now - item.resumedAt }),
    });
    // A re-verify the shutdown cut short attaches to the runner's Closeout work itself.
    const followed =
      decision.type === "resume"
        ? decision.reattach === true &&
          (yield* hasPendingResumeSteps(q, item.id, "process_restart"))
        : decision.type === "reverify" &&
          holds &&
          item.state === "verifying" &&
          (yield* hasOpenReverifySteps(q, item.id));
    if (
      !followed &&
      (yield* applyDecisionSteps(q, item, decision, now, {
        ...(decision.type === "resume" ? { runAt: nextResumeAt() } : {}),
      }))
    )
      wake.armed = true;
    decisions.push(decision);
  }
  const taken = new Set(items.map((item) => item.id));
  for (const item of yield* listWorkItemsByStatesSteps(q, ["awaiting_input"])) {
    if (taken.has(item.id) && item.currentRunId !== null)
      yield* releaseRunCapacitySteps(q, item.currentRunId, now);
  }
  if (items.some((item) => item.state === "awaiting_input")) {
    const { inserted } = yield* enqueueJobOnceSteps(q, {
      queue: JOB_KIND.catchup,
      jobKey: `startup-questions:${now}`,
      payload: { reason: "open_questions" },
      now,
    });
    if (inserted) wake.armed = true;
  }
  return decisions;
}

/** A capacity wait already has its next attempt; restarting neither spends recovery nor adds a job. */
function* hasParkedCapacityWaitSteps(q: Q, item: WorkItemRecord) {
  if (item.cancelRequested || !["running", "recovering", "verifying"].includes(item.state))
    return false;
  const { job } = q.t;
  return yield* jobExistsSteps(
    q,
    eq(job.status, "pending"),
    inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify]),
    payloadIs(q, "itemId", item.id),
    isNotNull(jsonField(q, job.payload, "capacityWait")),
    or(isNull(job.itemVersion), eq(job.itemVersion, item.version)),
  );
}

function* jobExistsSteps(q: Q, ...conditions: (SQL | undefined)[]) {
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(q.t.job)
      .where(and(...conditions)),
  );
  return row !== undefined;
}

function payloadIs(q: Q, key: "itemId" | "reason", value: string): SQL {
  return sql`${jsonField(q, q.t.job.payload, key)} = ${value}`;
}

function* hasOpenReverifySteps(q: Q, itemId: string) {
  const { job } = q.t;
  return yield* jobExistsSteps(
    q,
    eq(job.queue, JOB_KIND.reverify),
    inArray(job.status, ["pending", "running"]),
    payloadIs(q, "itemId", itemId),
  );
}

function* hasPendingTransientRetrySteps(q: Q, item: WorkItemRecord) {
  const { job } = q.t;
  return yield* jobExistsSteps(
    q,
    inArray(job.queue, [JOB_KIND.resume, JOB_KIND.reverify]),
    eq(job.status, "pending"),
    payloadIs(q, "itemId", item.id),
    payloadIs(q, "reason", "transient_failure"),
    or(isNull(job.itemVersion), eq(job.itemVersion, item.version)),
  );
}

function keepsVerification(item: WorkItemRecord): boolean {
  return item.state === "verifying" && hasVerificationCandidate(item.checkpoint);
}

function* hasPendingResumeSteps(q: Q, itemId: string, reason: string) {
  const { job } = q.t;
  return yield* jobExistsSteps(
    q,
    eq(job.queue, JOB_KIND.resume),
    eq(job.status, "pending"),
    payloadIs(q, "itemId", itemId),
    payloadIs(q, "reason", reason),
  );
}

function* ownsSteps(q: Q, item: WorkItemRecord, instanceId: string | undefined) {
  if (instanceId === undefined || item.currentRunId === null) return true;
  const owner = yield* runOwnerSteps(q, item.currentRunId);
  return owner === null || owner === instanceId;
}

export function* prepareShutdownSteps(q: Q, now: number, instanceId: string | undefined) {
  if (instanceId !== undefined) yield* heartbeatInstanceSteps(q, instanceId, now);
  for (const item of yield* listWorkItemsByStatesSteps(q, ["running", "verifying"])) {
    if (!(yield* ownsSteps(q, item, instanceId))) continue;
    if ((yield* hasParkedCapacityWaitSteps(q, item)) || (yield* runnerHoldsWorkSteps(q, item, now)))
      continue;
    if (item.currentRunId !== null) yield* markRunSteps(q, item.currentRunId, "lost", now);
    if (!keepsVerification(item)) yield* applyWorkItemEventSteps(q, item.id, "lease_expired");
  }
  for (const item of yield* listWorkItemsByStatesSteps(q, ["merge_queue"])) {
    if (!(yield* ownsSteps(q, item, instanceId))) continue;
    if (!(yield* runActiveSteps(q, item))) continue;
    yield* markRunSteps(q, item.currentRunId!, "lost", now);
    yield* applyWorkItemEventSteps(q, item.id, "lease_expired");
  }
}

/**
 * SIGINT / SIGTERM. Commit WIP on each in-flight item branch, then move running
 * work to recovering without using the one resume attempt. Work a runner still
 * holds keeps its state: an agent turn, or a verifying item's Closeout review or
 * check run. An item waiting in
 * the merge queue keeps its state and its place for the next start to pick up; one
 * whose run is still active is left for a re-verify.
 */
export function prepareShutdown(
  db: Database,
  now = Date.now(),
  commitWip?: ShutdownWipCommit,
  instanceId?: string,
): void {
  const store = sqliteDb(db);
  if (commitWip !== undefined) {
    for (const item of listInFlightItems(db)) {
      if (!settled(store.run((q) => ownsSteps(q, item, instanceId)))) continue;
      try {
        commitWip(item);
      } catch (caughtError1) {
        journalCaught(caughtError1, "recovery.prepareShutdown.commitWip", item.id);
        // The lease move still happens. A missing worktree is not a reason to skip shutdown.
      }
    }
  }
  settled(store.transaction((q) => prepareShutdownSteps(q, now, instanceId)));
}

function* runActiveSteps(q: Q, item: WorkItemRecord) {
  return (
    item.currentRunId !== null && (yield* getRunSteps(q, item.currentRunId))?.status === "active"
  );
}

function* runnerHoldsWorkSteps(q: Q, item: WorkItemRecord, now: number) {
  return (
    (item.state === "running" || item.state === "verifying") &&
    item.currentRunId !== null &&
    (yield* runnerHoldsRunWorkSteps(q, item.currentRunId, now, item.cancelRequested))
  );
}

const ORPHAN_GRACE_MS = 5 * 60_000;

/** Whether a running job, or a pending one for the item's version, moves work item `i`. */
function progressJobSql(q: Q, running: SQL = sql`j.status = 'running'`): SQL {
  return sql`EXISTS (SELECT 1 FROM job j WHERE ${jobPayloadText(q, "j", "itemId")} = i.id
    AND (${running} OR (j.status = 'pending' AND (j.item_version IS NULL
      OR j.item_version = i.version OR j.queue IN (${JOB_KIND.command}, ${JOB_KIND.reverify})))))`;
}

function reclaimableRunningJobSql(now: number): SQL {
  return sql`(j.status = 'running' AND (j.locked_until IS NULL
  OR j.locked_until > ${now} OR j.item_version IS NULL OR j.item_version = i.version))`;
}

function jobPayloadText(q: Q, alias: "job" | "j", key: "itemId" | "retry"): SQL {
  const payload = sql.raw(`${alias}.payload`);
  return q.dialect === "sqlite"
    ? sql`json_extract(${payload}, ${sql.raw(`'$.${key}'`)})`
    : sql`(${payload}->>${sql.raw(`'${key}'`)})`;
}

function* jobOwnsProgressSteps(q: Q, itemId: string, now: number): Steps<boolean> {
  const rows = yield* q.all(
    q.orm
      .select({ one: sql`1` })
      .from(sql`work_item i`)
      .where(sql`i.id = ${itemId} AND ${progressJobSql(q, reclaimableRunningJobSql(now))}`),
  );
  return rows.length > 0;
}

function* hasPendingAnswerResumeSteps(q: Q, itemId: string): Steps<boolean> {
  const { job: jobs } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(jobs)
      .where(
        and(
          inArray(jobs.status, ["pending", "running"]),
          like(jobs.jobKey, "resume:answer:%"),
          sql`${jobPayloadText(q, "job", "itemId")} = ${itemId}`,
        ),
      ),
  );
  return row !== undefined;
}

/** Item or run ids a recovery pass changed, and whether it armed a job to wake the loop for. */
type RecoveryResult = { ids: string[]; armed: boolean };

function recovered(source: Database | Db, result: RecoveryResult): string[] {
  if (result.armed) emitJobReady(source);
  return result.ids;
}

/**
 * Queue work again for an in-flight item nothing is moving: no pending or running job, no live
 * runner work, and no job finished within the grace period. A merge in progress fails closed into
 * a re-verify, as on startup, so Closeout checks the head before the merge job is queued again.
 */
export function* requeueOrphanedWorkSteps(q: Q, now: number): Steps<RecoveryResult> {
  const orphans = yield* q.all(
    q.orm
      .select({ id: sql<string>`i.id` })
      .from(sql`work_item i`)
      .where(
        sql`i.state IN ('running','verifying','recovering','merge_queue') AND i.cancel_requested = 0
       AND NOT ${progressJobSql(q)}
       AND NOT EXISTS (SELECT 1 FROM runner_work w WHERE w.run_id = i.current_run_id
         AND w.ended_at IS NULL AND w.lease_until > ${runnerLeaseCutoff(now)})
       AND (SELECT MAX(j.finished_at) FROM job j WHERE ${jobPayloadText(q, "j", "itemId")} = i.id)
         < ${now - ORPHAN_GRACE_MS}`,
      ),
  );
  const requeued: string[] = [];
  let armed = false;
  for (const { id } of orphans) {
    const found = yield* getWorkItemSteps(q, id);
    if (!found) continue;
    const hold = yield* q.transaction((tx) => ensureRestartQuestionSteps(tx, found, now));
    armed ||= hold.armed;
    if (hold.held) continue;
    if (found.state === "merge_queue")
      yield* q.transaction((tx) => applyWorkItemEventSteps(tx, found.id, "lease_expired"));
    const item = (yield* getWorkItemSteps(q, id)) ?? found;
    const key = `orphan:${item.id}:${now}`;
    const { inserted } = yield* enqueueJobOnceSteps(q, {
      queue: item.state === "verifying" ? JOB_KIND.reverify : JOB_KIND.resume,
      jobKey: key,
      payload:
        item.state === "verifying"
          ? { itemId: item.id, runId: item.currentRunId, recheckHead: true, failClosed: true }
          : {
              itemId: item.id,
              runId: item.currentRunId,
              freshSession: true,
              checkpoint: item.checkpoint,
              reason: "orphaned",
              ...(yield* pendingRestartHandoffSteps(q, item.id)),
            },
      now,
    });
    armed ||= inserted;
    if (item.sessionKey !== null)
      yield* q.transaction((tx) =>
        enqueueOutboxOnceSteps(tx, {
          target: OUTBOX_ACTIVITY.target,
          op: OUTBOX_ACTIVITY.op,
          orderingKey: item.sessionKey!,
          idempotencyKey: key,
          payload: {
            sessionId: item.sessionKey,
            kind: "thought",
            body: `Nothing was moving ${item.linearIdentifier} forward, so Paws picked it up again.`,
          },
          now,
        }),
      );
    requeued.push(item.id);
  }
  return { ids: requeued, armed };
}

export function requeueOrphanedWork(db: Database, now: number): string[] {
  return recovered(db, settled(sqliteDb(db).run((q) => requeueOrphanedWorkSteps(q, now))));
}

export async function requeueOrphanedWorkAsync(store: Db, now: number): Promise<string[]> {
  return recovered(store, await store.run((q) => requeueOrphanedWorkSteps(q, now)));
}

/**
 * Close abandoned runner work once per scheduler dispatch. Live job owners handle their own
 * runner failures; delivered results remain available for import. The item follows its existing
 * lease-expiry transition atomically with the run and slot cleanup.
 */
export function* closeExpiredRunnerLeasesSteps(q: Q, now: number): Steps<RecoveryResult> {
  const { runnerWork, runnerWorkGrant } = q.t;
  const cutoff = runnerLeaseCutoff(now);
  const rows = yield* q.all(
    q.orm
      .select({ runId: sql<string>`w.run_id`, generation: sql<number>`w.generation` })
      .from(sql`runner_work w JOIN run r ON r.id = w.run_id`)
      .where(
        sql`w.ended_at IS NULL AND w.lease_until <= ${cutoff}
           AND NOT EXISTS (SELECT 1 FROM job j WHERE ${jobPayloadText(q, "j", "itemId")}=r.item_id
             AND j.status='running' AND (j.locked_until IS NULL OR j.locked_until> ${now}))
           AND r.status IN ('active', 'provisioning')
           AND NOT EXISTS (SELECT 1 FROM runner_result result
             WHERE result.run_id=w.run_id AND result.generation=w.generation
               AND result.command_id=w.command_id)`,
      ),
  );
  let armed = false;
  for (const row of rows) {
    const run = (yield* getRunSteps(q, row.runId))!;
    const item = yield* getWorkItemSteps(q, run.itemId);
    const current =
      item?.currentRunId === row.runId &&
      ["running", "verifying", "merge_queue"].includes(item.state);
    if (current && !keepsVerification(item))
      yield* applyWorkItemEventSteps(q, item.id, "lease_expired");
    yield* markRunSteps(q, row.runId, "lost", now);
    yield* q.exec(
      q.orm
        .update(runnerWork)
        .set({ endedAt: now })
        .where(and(eq(runnerWork.runId, row.runId), isNull(runnerWork.endedAt))),
    );
    yield* q.exec(q.orm.delete(runnerWorkGrant).where(eq(runnerWorkGrant.runId, row.runId)));
    if (current) armed = (yield* followExpiredLeaseSteps(q, item, row.generation, now)) || armed;
  }
  return { ids: rows.map((row) => row.runId), armed };
}

export function closeExpiredRunnerLeases(db: Database, now: number): string[] {
  return recovered(
    db,
    settled(sqliteDb(db).transaction((q) => closeExpiredRunnerLeasesSteps(q, now))),
  );
}

export async function closeExpiredRunnerLeasesAsync(store: Db, now: number): Promise<string[]> {
  return recovered(store, await store.transaction((q) => closeExpiredRunnerLeasesSteps(q, now)));
}

/** Whether the follow-up armed a job. */
function* followExpiredLeaseSteps(
  q: Q,
  before: WorkItemRecord,
  generation: number,
  now: number,
): Steps<boolean> {
  const item = yield* getWorkItemSteps(q, before.id);
  if (!item || item.cancelRequested || item.currentRunId !== before.currentRunId) return false;
  const hold = yield* ensureRestartQuestionSteps(q, item, now);
  if (hold.held) return hold.armed;
  if (
    (yield* jobOwnsProgressSteps(q, item.id, now)) ||
    (yield* hasPendingAnswerResumeSteps(q, item.id))
  )
    return false;
  const verify = before.state === "merge_queue" || keepsVerification(before);
  if (verify !== (item.state === "verifying")) return false;
  const retry = (yield* lastAdvancingRetrySteps(q, item.id)) + 1;
  if (retry > MAX_TRANSIENT_RETRIES)
    return yield* applyDecisionSteps(q, item, { type: "ask_restart" }, now);
  if (item.checkpoint?.phase === "merge_queue")
    yield* saveCheckpointSteps(q, item.id, { ...item.checkpoint, phase: "verifying" });
  const runAt = now + transientRetryDelayMs(retry, null);
  const jobKey = `lease-expired:${item.id}:${before.currentRunId}:${generation}`;
  const { inserted } = verify
    ? yield* enqueueJobOnceSteps(q, {
        queue: JOB_KIND.reverify,
        jobKey,
        runAt,
        maxAttempts: Math.max(1, MAX_TRANSIENT_RETRIES - retry + 1),
        payload: {
          itemId: item.id,
          runId: item.currentRunId,
          reason: "transient_failure",
          retry,
          recheckHead: true,
          failClosed: true,
        },
        now,
      })
    : yield* enqueueJobOnceSteps(q, {
        queue: JOB_KIND.resume,
        jobKey,
        runAt,
        payload: {
          itemId: item.id,
          runId: item.currentRunId,
          reason: "transient_failure",
          retry,
          ...(yield* pendingRestartHandoffSteps(q, item.id)),
        },
        now,
      });
  return inserted;
}

function* lastAdvancingRetrySteps(q: Q, itemId: string): Steps<number> {
  const { job: jobs } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ retry: jobPayloadText(q, "job", "retry") })
      .from(jobs)
      .where(
        and(
          inArray(jobs.queue, [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify]),
          sql`${jobPayloadText(q, "job", "itemId")} = ${itemId}`,
        ),
      )
      .orderBy(desc(jobs.id))
      .limit(1),
  );
  const retry = Number(row?.retry);
  return Number.isFinite(retry) ? retry : 0;
}
