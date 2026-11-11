import { and, count, eq, isNull, lte, max, min, or, sql } from "drizzle-orm";
import type { Q } from "./db";

export function* databaseProbeSteps(q: Q) {
  yield* q.all(
    q.orm
      .select({ one: sql<number>`1` })
      .from(q.t.job)
      .limit(1),
  );
}

export function* expiredJobLeaseCountSteps(q: Q, now: number) {
  const job = q.t.job;
  const row = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(job)
      .where(
        and(eq(job.status, "running"), or(isNull(job.lockedUntil), lte(job.lockedUntil, now))),
      ),
  );
  return row?.count ?? 0;
}

export function* deadJobCountSteps(q: Q) {
  const job = q.t.job;
  const row = yield* q.one(
    q.orm.select({ count: count() }).from(job).where(eq(job.status, "dead")),
  );
  return row?.count ?? 0;
}

export function* deadOutboxCountSteps(q: Q) {
  const outbox = q.t.outbox;
  const row = yield* q.one(
    q.orm.select({ count: count() }).from(outbox).where(eq(outbox.status, "dead")),
  );
  return row?.count ?? 0;
}

export function* runnerHeartbeatsSteps(q: Q, staleAt: number) {
  const runner = q.t.runner;
  const stale = or(isNull(runner.lastSeenAt), lte(runner.lastSeenAt, staleAt));
  const row = yield* q.one(
    q.orm
      .select({
        total: count(),
        stale: count(sql`CASE WHEN ${stale} THEN 1 END`),
        oldest: min(runner.lastSeenAt),
      })
      .from(runner)
      .where(and(eq(runner.status, "active"), isNull(runner.revokedAt))),
  );
  return { total: row?.total ?? 0, stale: row?.stale ?? 0, oldest: row?.oldest ?? null };
}

export function* latestGithubDeliverySteps(q: Q) {
  const delivery = q.t.githubDelivery;
  const row = yield* q.one(q.orm.select({ at: max(delivery.receivedAt) }).from(delivery));
  return row?.at ?? null;
}
