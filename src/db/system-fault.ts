import type { Database } from "bun:sqlite";
import type { SystemFaultClass } from "../core";

export type SystemFaultHold = {
  itemId: string;
  identifier: string;
  faultClass: SystemFaultClass;
  reason: string;
  failures: number;
  startedAt: number;
  retryAt: number;
};

export function listSystemFaults(db: Database): SystemFaultHold[] {
  return db
    .query<SystemFaultHold, []>(`SELECT f.item_id AS itemId, w.linear_identifier AS identifier,
    f.fault_class AS faultClass, f.reason, f.failures, f.started_at AS startedAt, f.retry_at AS retryAt
    FROM system_fault f JOIN work_item w ON w.id=f.item_id AND w.version=f.item_version
    WHERE w.cancel_requested=0 AND w.state IN ('running','verifying')
    ORDER BY f.started_at, f.item_id`)
    .all();
}

export function saveSystemFault(
  db: Database,
  input: {
    itemId: string;
    version: number;
    faultClass: SystemFaultClass;
    reason: string;
    now: number;
  },
): SystemFaultHold {
  const previous = listSystemFaults(db).find(
    (hold) => hold.itemId === input.itemId && hold.faultClass === input.faultClass,
  );
  const failures = (previous?.failures ?? 0) + 1;
  const retryAt = input.now + Math.min(600_000, 30_000 * 2 ** Math.min(failures - 1, 5));
  db.run(
    `INSERT INTO system_fault VALUES (?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
    item_version=excluded.item_version, fault_class=excluded.fault_class, reason=excluded.reason,
    failures=excluded.failures, started_at=excluded.started_at, retry_at=excluded.retry_at`,
    [
      input.itemId,
      input.version,
      input.faultClass,
      input.reason,
      failures,
      previous?.startedAt ?? input.now,
      retryAt,
    ],
  );
  return listSystemFaults(db).find((hold) => hold.itemId === input.itemId)!;
}

export function clearSystemFault(db: Database, itemId: string): void {
  db.run("DELETE FROM system_fault WHERE item_id=?", [itemId]);
}
