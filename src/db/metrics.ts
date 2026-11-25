import { and, asc, count, eq, gte, inArray, lt, lte, min, sql } from "drizzle-orm";
import { type Q } from "./db";

const INSERT_CHUNK = 1_000;

export type MetricMinuteRow = {
  minute: number;
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  max: number;
  buckets: number[] | null;
  gauge: number | null;
};

export function* insertMetricMinutesSteps(q: Q, rows: readonly MetricMinuteRow[]) {
  for (let start = 0; start < rows.length; start += INSERT_CHUNK)
    yield* q.exec(q.orm.insert(q.t.metricMinute).values(rows.slice(start, start + INSERT_CHUNK)));
}

export function* deleteMetricMinutesBeforeSteps(q: Q, before: number) {
  const { metricMinute: m } = q.t;
  const deleted = yield* q.all(q.orm.delete(m).where(lt(m.minute, before)).returning({ id: m.id }));
  return deleted.length;
}

export function* metricMinutesSteps(
  q: Q,
  query: { names: readonly string[]; from: number; to: number },
) {
  const { metricMinute: m } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        minute: m.minute,
        name: m.name,
        labels: m.labels,
        count: m.count,
        sum: m.sum,
        max: m.max,
        buckets: m.buckets,
        gauge: m.gauge,
      })
      .from(m)
      .where(
        and(inArray(m.name, [...query.names]), gte(m.minute, query.from), lt(m.minute, query.to)),
      )
      .orderBy(asc(m.minute), asc(m.id)),
  );
  return rows as MetricMinuteRow[];
}

export type QueueDepthRow = { key: string; depth: number; oldestAt: number };

export function* jobQueueDepthsSteps(q: Q, now: number) {
  const { job } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ key: job.queue, depth: count(), oldestAt: min(job.runAt) })
      .from(job)
      .where(and(eq(job.status, "pending"), lte(job.runAt, now)))
      .groupBy(job.queue),
  );
  return rows.map((row) => ({ ...row, oldestAt: Number(row.oldestAt ?? now) })) as QueueDepthRow[];
}

export function* outboxQueueDepthsSteps(q: Q, now: number) {
  const { outbox } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        key: outbox.deliveryKind,
        depth: count(),
        oldestAt: sql<number>`min(greatest(${outbox.createdAt}, ${outbox.notBefore}))`,
      })
      .from(outbox)
      .where(and(eq(outbox.status, "pending"), lte(outbox.notBefore, now)))
      .groupBy(outbox.deliveryKind),
  );
  return rows.map((row) => ({ ...row, oldestAt: Number(row.oldestAt ?? now) })) as QueueDepthRow[];
}
