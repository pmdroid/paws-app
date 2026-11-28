import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, max, or, sql } from "drizzle-orm";
import { type Q, type Steps } from "./db";
import { jsonItemId } from "./jobs";
import { jsonText } from "./json-text";
import { activeRunnerIdsSteps, runnerOccupancySteps } from "./runner-capacity";

export type AlertWindows = { jobs: number; testTimeouts: number; deadOutbox: number };

export type AlertJobRow = {
  id: number;
  itemId: string;
  identifier: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  at: number;
};

export function* alertFactsSteps(q: Q, now: number, since: AlertWindows) {
  const { job, outbox, closeoutStep, workItem, workItemEvent } = q.t;
  const itemId = jsonItemId(q, sql`${job.payload}`);
  const jobs = yield* q.all(
    q.orm
      .select({
        id: job.id,
        itemId: sql<string>`${itemId}`,
        identifier: workItem.linearIdentifier,
        status: job.status,
        attempts: job.attempts,
        lastError: job.lastError,
        at: sql<number>`greatest(${job.createdAt}, coalesce(${job.finishedAt}, 0))`,
      })
      .from(job)
      .leftJoin(workItem, eq(workItem.id, itemId))
      .where(
        and(
          isNotNull(itemId),
          or(inArray(job.status, ["pending", "running"]), gte(job.finishedAt, since.jobs)),
        ),
      )
      .orderBy(desc(job.id)),
  );
  const testTimeouts = yield* q.all(
    q.orm
      .select({ finishedAt: closeoutStep.finishedAt })
      .from(closeoutStep)
      .where(
        and(
          eq(closeoutStep.stepId, "test"),
          eq(closeoutStep.timedOut, 1),
          gte(closeoutStep.finishedAt, since.testTimeouts),
        ),
      ),
  );
  const deadAt = sql<number>`greatest(${outbox.createdAt}, ${outbox.notBefore})`;
  const deadOutbox = yield* q.all(
    q.orm
      .select({ id: outbox.id, op: outbox.op, error: outbox.error, at: deadAt })
      .from(outbox)
      .where(and(eq(outbox.status, "dead"), gte(deadAt, since.deadOutbox)))
      .orderBy(outbox.id),
  );
  const queued = yield* q.one(
    q.orm.select({ id: workItem.id }).from(workItem).where(eq(workItem.state, "queued")).limit(1),
  );
  const lastQueued = yield* q.one(
    q.orm
      .select({ at: max(workItemEvent.at) })
      .from(workItemEvent)
      .where(or(eq(workItemEvent.fromState, "queued"), eq(workItemEvent.toState, "queued"))),
  );
  let freeSlots = 0;
  for (const runnerId of yield* activeRunnerIdsSteps(q, now)) {
    const occupancy = yield* runnerOccupancySteps(q, runnerId, now);
    freeSlots += Math.max(0, occupancy.capacity - occupancy.occupied);
  }
  return {
    jobs: jobs.map((row) => ({ ...row, at: Number(row.at) })) as AlertJobRow[],
    testTimeouts: testTimeouts.map((row) => Number(row.finishedAt)),
    deadOutbox: deadOutbox.map((row) => ({ ...row, at: Number(row.at) })),
    queuedNow: queued !== undefined,
    lastQueuedAt: (lastQueued?.at ?? null) === null ? null : Number(lastQueued!.at),
    freeSlots,
  };
}

export type OrphanedBlockerRow = {
  blocker: string;
  state: string;
  endedAt: number;
  blocked: string;
  heldSince: number;
};

export function* orphanedBlockerFactsSteps(q: Q): Steps<OrphanedBlockerRow[]> {
  const { itemHold, taskBlock, workItem, workItemEvent } = q.t;
  const holds = yield* q.all(
    q.orm
      .select({
        id: workItem.id,
        issueId: workItem.linearIssueId,
        identifier: workItem.linearIdentifier,
        createdAt: workItem.createdAt,
        blockers: jsonText(q, itemHold.blockers),
      })
      .from(itemHold)
      .innerJoin(workItem, eq(workItem.id, itemHold.itemId))
      .where(and(eq(itemHold.reason, "blocked"), eq(workItem.state, "queued"))),
  );
  if (holds.length === 0) return [];
  const edges = yield* q.all(
    q.orm
      .select()
      .from(taskBlock)
      .where(inArray(taskBlock.blockedLinearIssueId, [...new Set(holds.map((h) => h.issueId))])),
  );
  if (edges.length === 0) return [];
  const latest = new Map<string, { id: string; identifier: string; state: string }>();
  for (const row of yield* q.all(
    q.orm
      .select({
        id: workItem.id,
        issueId: workItem.linearIssueId,
        identifier: workItem.linearIdentifier,
        state: workItem.state,
      })
      .from(workItem)
      .where(
        inArray(workItem.linearIssueId, [...new Set(edges.map((e) => e.blockerLinearIssueId))]),
      )
      .orderBy(desc(workItem.createdAt), desc(workItem.id)),
  ))
    if (!latest.has(row.issueId)) latest.set(row.issueId, row);
  const lastAt = function* (itemId: string, state: string) {
    const row = yield* q.one(
      q.orm
        .select({ at: max(workItemEvent.at) })
        .from(workItemEvent)
        .where(and(eq(workItemEvent.itemId, itemId), eq(workItemEvent.toState, state))),
    );
    return row?.at == null ? null : Number(row.at);
  };
  const rows: OrphanedBlockerRow[] = [];
  for (const hold of holds) {
    const named = new Set(JSON.parse(hold.blockers) as string[]);
    for (const edge of edges) {
      const blocker = latest.get(edge.blockerLinearIssueId);
      const ended = blocker?.state === "cancelled" || blocker?.state === "failed";
      if (edge.blockedLinearIssueId !== hold.issueId || !ended || !named.has(blocker.identifier))
        continue;
      rows.push({
        blocker: blocker.identifier,
        state: blocker.state,
        endedAt: (yield* lastAt(blocker.id, blocker.state)) ?? 0,
        blocked: hold.identifier,
        heldSince: (yield* lastAt(hold.id, "queued")) ?? Number(hold.createdAt),
      });
    }
  }
  return rows;
}

export function* admittedRunnerVersionsSteps(q: Q) {
  const { runner, runnerHostStatus } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: runner.id, name: runner.name, version: runnerHostStatus.runnerVersion })
      .from(runner)
      .innerJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runner.id))
      .where(and(eq(runner.status, "active"), isNull(runner.revokedAt)))
      .orderBy(runner.id),
  );
}

export type ExportedAlertRow = {
  key: string;
  severity: string;
  title: string;
  since: number;
  count: number;
};

export function* exportedAlertsSteps(q: Q) {
  return yield* q.all(q.orm.select().from(q.t.exportedAlert));
}

export function* observeAlertsSteps(
  q: Q,
  change: {
    raised: readonly ExportedAlertRow[];
    gone: readonly string[];
    events: readonly (ExportedAlertRow & { eventId: string; event: string })[];
    settings: { key: string; value: string | null };
  },
) {
  const { exportedAlert: e, alertEvent, setting } = q.t;
  return yield* q.transaction(function* (tx) {
    const current = yield* tx.one(
      tx.orm
        .select({ value: setting.value })
        .from(setting)
        .where(eq(setting.key, change.settings.key))
        .for("update"),
    );
    if ((current?.value ?? null) !== change.settings.value) return false;
    if (change.gone.length > 0)
      yield* tx.exec(tx.orm.delete(e).where(inArray(e.key, [...change.gone])));
    if (change.raised.length > 0)
      yield* tx.exec(
        tx.orm
          .insert(e)
          .values([...change.raised])
          .onConflictDoNothing(),
      );
    if (change.events.length > 0)
      yield* tx.exec(tx.orm.insert(alertEvent).values([...change.events]));
    return true;
  });
}

export function* pendingAlertEventsSteps(q: Q, limit: number) {
  const { alertEvent } = q.t;
  return yield* q.all(q.orm.select().from(alertEvent).orderBy(asc(alertEvent.id)).limit(limit));
}

export function* deliveredAlertEventsSteps(q: Q, ids: readonly number[]) {
  const { alertEvent } = q.t;
  if (ids.length > 0)
    yield* q.exec(q.orm.delete(alertEvent).where(inArray(alertEvent.id, [...ids])));
}

export function* clearExportedAlertsSteps(q: Q) {
  yield* q.exec(q.orm.delete(q.t.exportedAlert));
  yield* q.exec(q.orm.delete(q.t.alertEvent));
}
