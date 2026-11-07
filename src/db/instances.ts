import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, isNull, max } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { ulid } from "./ulid";

export const INSTANCE_HEARTBEAT_MS = 10_000;
export const INSTANCE_DEAD_MS = 60_000;

export type InstanceRole = "all" | "web" | "worker";

export function roleRunsJobs(role: InstanceRole): boolean {
  return role !== "web";
}

export type Instance = {
  id: string;
  role: InstanceRole;
  host: string;
  startedAt: number;
  heartbeatAt: number;
  version: string | null;
  pid: number | null;
};

function columns(q: Q) {
  const { instance } = q.t;
  return {
    id: instance.id,
    role: instance.role,
    host: instance.host,
    startedAt: instance.startedAt,
    heartbeatAt: instance.heartbeatAt,
    version: instance.version,
    pid: instance.pid,
  };
}

export function* registerInstanceSteps(
  q: Q,
  input: { role: InstanceRole; host: string; version: string | null; now: number; pid?: number },
): Steps<Instance> {
  const row: Instance = {
    id: ulid(input.now),
    role: input.role,
    host: input.host,
    startedAt: input.now,
    heartbeatAt: input.now,
    version: input.version,
    pid: input.pid ?? null,
  };
  yield* q.exec(q.orm.insert(q.t.instance).values(row));
  return row;
}

export function registerInstance(
  db: Database,
  input: { role: InstanceRole; host: string; version: string | null; now: number; pid?: number },
): Instance {
  return settled(sqliteDb(db).run((q) => registerInstanceSteps(q, input)));
}

export function* heartbeatInstanceSteps(q: Q, id: string, now: number) {
  const { instance } = q.t;
  const updated = yield* q.all(
    q.orm
      .update(instance)
      .set({ heartbeatAt: now })
      .where(eq(instance.id, id))
      .returning({ id: instance.id }),
  );
  return updated.length > 0;
}

export function heartbeatInstance(db: Database, id: string, now: number): boolean {
  return settled(sqliteDb(db).run((q) => heartbeatInstanceSteps(q, id, now)));
}

export function* stopInstanceSteps(q: Q, id: string, now: number) {
  const { instance } = q.t;
  yield* q.exec(
    q.orm.update(instance).set({ heartbeatAt: now, stoppedAt: now }).where(eq(instance.id, id)),
  );
}

/**
 * Record a clean stop at `now`. The row keeps the last heartbeat, so the instance that takes over
 * its runs can credit runner leases for the time no instance was alive.
 */
export function stopInstance(db: Database, id: string, now: number): void {
  settled(sqliteDb(db).run((q) => stopInstanceSteps(q, id, now)));
}

export function* lastInstanceHeartbeatSteps(q: Q) {
  const { instance } = q.t;
  const row = yield* q.one(q.orm.select({ at: max(instance.heartbeatAt) }).from(instance));
  return row?.at ?? null;
}

/** The latest heartbeat of any instance, stopped or not, or null when none registered. */
export function lastInstanceHeartbeat(db: Database): number | null {
  return settled(sqliteDb(db).run(lastInstanceHeartbeatSteps));
}

export function* liveInstancesSteps(q: Q, now: number) {
  const { instance } = q.t;
  const rows = yield* q.all(
    q.orm
      .select(columns(q))
      .from(instance)
      .where(and(gt(instance.heartbeatAt, now - INSTANCE_DEAD_MS), isNull(instance.stoppedAt)))
      .orderBy(desc(instance.heartbeatAt), instance.id),
  );
  return rows as Instance[];
}

export function liveInstances(db: Database, now: number): Instance[] {
  return settled(sqliteDb(db).run((q) => liveInstancesSteps(q, now)));
}

export function* ownerGoneSteps(q: Q, self: string, now: number) {
  const instances = q.t.instance;
  const rows = yield* q.all(
    q.orm
      .select({
        id: instances.id,
        host: instances.host,
        heartbeatAt: instances.heartbeatAt,
        pid: instances.pid,
        stoppedAt: instances.stoppedAt,
      })
      .from(instances),
  );
  const host = rows.find((row) => row.id === self)?.host;
  const live = new Set(
    rows
      .filter((row) => row.stoppedAt === null && row.heartbeatAt > now - INSTANCE_DEAD_MS)
      .filter((row) => row.host !== host || row.pid === null || processRuns(row.pid))
      .map((row) => row.id),
  );
  return (owner: string) => owner !== self && !live.has(owner);
}

export function ownerGone(db: Database, self: string, now: number): (owner: string) => boolean {
  return settled(sqliteDb(db).run((q) => ownerGoneSteps(q, self, now)));
}

function processRuns(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function* jobInstanceElsewhereSteps(q: Q, selfId: string | undefined, now: number) {
  const live = yield* liveInstancesSteps(q, now);
  return live.some((entry) => entry.id !== selfId && roleRunsJobs(entry.role));
}

export function jobInstanceElsewhere(
  db: Database,
  selfId: string | undefined,
  now: number,
): boolean {
  return settled(sqliteDb(db).run((q) => jobInstanceElsewhereSteps(q, selfId, now)));
}
