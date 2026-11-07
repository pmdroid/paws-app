import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, isNull, max } from "drizzle-orm";
import { orm } from "./orm";
import { instance } from "./schema";
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

const columns = {
  id: instance.id,
  role: instance.role,
  host: instance.host,
  startedAt: instance.startedAt,
  heartbeatAt: instance.heartbeatAt,
  version: instance.version,
  pid: instance.pid,
};

export function registerInstance(
  db: Database,
  input: { role: InstanceRole; host: string; version: string | null; now: number; pid?: number },
): Instance {
  const row: Instance = {
    id: ulid(input.now),
    role: input.role,
    host: input.host,
    startedAt: input.now,
    heartbeatAt: input.now,
    version: input.version,
    pid: input.pid ?? null,
  };
  orm(db).insert(instance).values(row).run();
  return row;
}

export function heartbeatInstance(db: Database, id: string, now: number): boolean {
  const updated = orm(db)
    .update(instance)
    .set({ heartbeatAt: now })
    .where(eq(instance.id, id))
    .returning({ id: instance.id })
    .all();
  return updated.length > 0;
}

/**
 * Record a clean stop at `now`. The row keeps the last heartbeat, so the instance that takes over
 * its runs can credit runner leases for the time no instance was alive.
 */
export function stopInstance(db: Database, id: string, now: number): void {
  orm(db)
    .update(instance)
    .set({ heartbeatAt: now, stoppedAt: now })
    .where(eq(instance.id, id))
    .run();
}

/** The latest heartbeat of any instance, stopped or not, or null when none registered. */
export function lastInstanceHeartbeat(db: Database): number | null {
  return (
    orm(db)
      .select({ at: max(instance.heartbeatAt) })
      .from(instance)
      .get()?.at ?? null
  );
}

export function deleteInstance(db: Database, id: string): void {
  orm(db).delete(instance).where(eq(instance.id, id)).run();
}

export function liveInstances(db: Database, now: number): Instance[] {
  return orm(db)
    .select(columns)
    .from(instance)
    .where(and(gt(instance.heartbeatAt, now - INSTANCE_DEAD_MS), isNull(instance.stoppedAt)))
    .orderBy(desc(instance.heartbeatAt), instance.id)
    .all() as Instance[];
}

export function ownerGone(db: Database, self: string, now: number): (owner: string) => boolean {
  const rows = orm(db)
    .select({ ...columns, stoppedAt: instance.stoppedAt })
    .from(instance)
    .all() as (Instance & { stoppedAt: number | null })[];
  const host = rows.find((row) => row.id === self)?.host;
  const live = new Set(
    rows
      .filter((row) => row.stoppedAt === null && row.heartbeatAt > now - INSTANCE_DEAD_MS)
      .filter((row) => row.host !== host || row.pid === null || processRuns(row.pid))
      .map((row) => row.id),
  );
  return (owner) => owner !== self && !live.has(owner);
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

export function jobInstanceElsewhere(
  db: Database,
  selfId: string | undefined,
  now: number,
): boolean {
  return liveInstances(db, now).some((live) => live.id !== selfId && roleRunsJobs(live.role));
}
