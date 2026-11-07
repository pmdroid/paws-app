import type { Database } from "bun:sqlite";
import { desc, eq, gt } from "drizzle-orm";
import { orm } from "./orm";
import { instance } from "./schema";
import { ulid } from "./ulid";

export const INSTANCE_HEARTBEAT_MS = 10_000;
export const INSTANCE_DEAD_MS = 60_000;

export type InstanceRole = "all" | "web" | "worker";

export type Instance = {
  id: string;
  role: InstanceRole;
  host: string;
  startedAt: number;
  heartbeatAt: number;
  version: string | null;
};

const columns = {
  id: instance.id,
  role: instance.role,
  host: instance.host,
  startedAt: instance.startedAt,
  heartbeatAt: instance.heartbeatAt,
  version: instance.version,
};

export function registerInstance(
  db: Database,
  input: { role: InstanceRole; host: string; version: string | null; now: number },
): Instance {
  const row: Instance = {
    id: ulid(input.now),
    role: input.role,
    host: input.host,
    startedAt: input.now,
    heartbeatAt: input.now,
    version: input.version,
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

export function deleteInstance(db: Database, id: string): void {
  orm(db).delete(instance).where(eq(instance.id, id)).run();
}

export function liveInstances(db: Database, now: number): Instance[] {
  return orm(db)
    .select(columns)
    .from(instance)
    .where(gt(instance.heartbeatAt, now - INSTANCE_DEAD_MS))
    .orderBy(desc(instance.heartbeatAt), instance.id)
    .all() as Instance[];
}
