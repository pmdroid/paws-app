import type { RunnerCapacityWaitState } from "./items";
import type { Database } from "bun:sqlite";
import { runnerLeaseCutoff } from "./runner-lease";
import { immediate } from "./tx";
import { auditWorkspaceAccess } from "./workspace";

/**
 * Slots Paws may fill on a runner. A lowered desired value applies at once; a raised one waits
 * until the runner reports it applied the value.
 */
export function runnerHasCapacity(
  db: Database,
  runnerId: string,
  now: number,
  excludeRunId = "",
  additionalReservations = 0,
): boolean {
  const row = runnerOccupancy(db, runnerId, now, excludeRunId);
  return row.occupied + additionalReservations < row.capacity;
}

/** The slots Paws may fill on a runner and the slots leased work and helpers fill now. */
export function runnerOccupancy(
  db: Database,
  runnerId: string,
  now: number,
  excludeRunId = "",
): { capacity: number; occupied: number } {
  return db
    .query<
      { capacity: number; occupied: number },
      [string, string, number, string, string, number]
    >(
      `SELECT COALESCE((SELECT MIN(capacity,COALESCE(desired,16)) FROM runner_capacity WHERE runner_id=?),1) AS capacity,
     (SELECT count(*) FROM runner_work WHERE runner_id=? AND ((ended_at IS NULL AND lease_until>? AND run_id<>?)
       OR (ended_at IS NOT NULL AND teardown_confirmed_at IS NULL))) +
     (SELECT count(*) FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND expires_at>?) AS occupied`,
    )
    .get(runnerId, runnerId, runnerLeaseCutoff(now), excludeRunId, runnerId, now)!;
}

export function runnerSlotsHeldBetweenCommands(
  db: Database,
  runnerId: string,
  now: number,
  excludeRunId = "",
): number {
  const holders = db
    .query<{ runId: string }, [string, number]>(
      `SELECT w.run_id AS runId FROM runner_work w JOIN run r ON r.id=w.run_id
       WHERE w.runner_id=? AND (w.ended_at IS NOT NULL OR (w.lease_until<=? AND EXISTS (
         SELECT 1 FROM runner_result result WHERE result.run_id=w.run_id
           AND result.generation=w.generation AND result.command_id=w.command_id)))
       AND r.status IN ('active','provisioning') AND (w.teardown_confirmed_at IS NOT NULL OR EXISTS(
         SELECT 1 FROM runner_result r WHERE r.run_id=w.run_id AND r.generation=w.generation AND r.command_id=w.command_id))`,
    )
    .all(runnerId, runnerLeaseCutoff(now))
    .map((row) => row.runId);
  return holders.includes(excludeRunId) ? 0 : holders.length;
}

export function activeRunnerIds(db: Database, now: number): string[] {
  return db
    .query<{ id: string }, [number]>(
      "SELECT id FROM runner WHERE status='active' AND revoked_at IS NULL AND last_seen_at>?",
    )
    .all(now - 60_000)
    .map((runner) => runner.id);
}

export function slotWaitRunners(
  db: Database,
  runId: string,
  wait: RunnerCapacityWaitState,
  now: number,
): readonly string[] {
  if (
    wait.runnerIds.length === 0 ||
    db.query("SELECT 1 FROM runner_work WHERE run_id=? LIMIT 1").get(runId)
  )
    return wait.runnerIds;
  const known = new Set([...wait.runnerIds, ...(wait.online ?? [])]);
  return [...wait.runnerIds, ...activeRunnerIds(db, now).filter((id) => !known.has(id))];
}

export function runnerSlotFree(
  db: Database,
  runnerIds: readonly string[],
  now: number,
  runId = "",
): boolean {
  const ids = runnerIds.length ? runnerIds : activeRunnerIds(db, now);
  return ids.some((id) =>
    runnerHasCapacity(db, id, now, runId, runnerSlotsHeldBetweenCommands(db, id, now, runId)),
  );
}

/**
 * Records the capacity a runner applied and, from runners that report it, the host ceiling.
 * Returns the concurrency the runner should apply, or undefined for runners that do not report a
 * ceiling (older releases reject unknown reply fields).
 */
export function recordRunnerCapacity(
  db: Database,
  runnerId: string,
  capacity: number,
  ceiling?: number,
): number | undefined {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16)
    throw new Error("Invalid runner capacity");
  if (
    ceiling !== undefined &&
    (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 16 || capacity > ceiling)
  )
    throw new Error("Invalid runner capacity ceiling");
  db.run(
    `INSERT INTO runner_capacity(runner_id,capacity,ceiling) VALUES(?,?,?)
    ON CONFLICT(runner_id) DO UPDATE SET capacity=excluded.capacity,ceiling=excluded.ceiling`,
    [runnerId, capacity, ceiling ?? null],
  );
  if (ceiling === undefined) return undefined;
  const desired = db
    .query<{ desired: number | null }, [string]>(
      "SELECT desired FROM runner_capacity WHERE runner_id=?",
    )
    .get(runnerId)?.desired;
  return Math.min(desired ?? ceiling, ceiling);
}

export class RunnerConcurrencyError extends Error {}

/** Stores the concurrency an admin chose, from 1 up to the ceiling the runner reported. */
export function setRunnerConcurrency(
  db: Database,
  input: {
    runnerId: string;
    workspaceId: string;
    userId: string;
    concurrency: number;
    now: number;
  },
): void {
  immediate(db, () => {
    const row = db
      .query<{ ceiling: number | null }, [string, string]>(
        `SELECT c.ceiling FROM runner r LEFT JOIN runner_capacity c ON c.runner_id=r.id
        WHERE r.id=? AND r.workspace_id=? AND r.revoked_at IS NULL`,
      )
      .get(input.runnerId, input.workspaceId);
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
    db.run("UPDATE runner_capacity SET desired=? WHERE runner_id=?", [
      input.concurrency,
      input.runnerId,
    ]);
    auditWorkspaceAccess(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: "runner.concurrency",
      subject: input.runnerId,
      now: input.now,
    });
  });
}

/** A runner slot the scheduler reserved for an item resuming on its pinned runner. */
export type PinnedSlot = { runnerId: string; order: number };

const RESERVING_JOBS = "queue IN ('run.resume','run.reverify')";

/**
 * Saves the slots the scheduler reserved this tick on the pending resume and reverify jobs that
 * wait for them, and releases every other reservation those jobs held.
 */
export function savePinnedSlots(db: Database, slots: ReadonlyMap<number, PinnedSlot>): void {
  const ids = [...slots.keys()];
  db.run(
    `UPDATE job SET payload=json_remove(payload,'$.pinnedSlot') WHERE status='pending' AND ${RESERVING_JOBS}
     AND json_extract(payload,'$.pinnedSlot') IS NOT NULL AND id NOT IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  for (const [id, slot] of slots)
    db.run(
      `UPDATE job SET payload=json_set(payload,'$.pinnedSlot',json(?)) WHERE id=? AND status='pending'
       AND json_extract(payload,'$.pinnedSlot') IS NOT json(?)`,
      [JSON.stringify(slot), id, JSON.stringify(slot)],
    );
}

/** Releases the item's reservation once its run is placed. */
export function releasePinnedSlot(db: Database, itemId: string): void {
  db.run(
    `UPDATE job SET payload=json_remove(payload,'$.pinnedSlot') WHERE ${RESERVING_JOBS}
     AND status IN ('pending','running') AND json_extract(payload,'$.itemId')=?
     AND json_extract(payload,'$.pinnedSlot') IS NOT NULL`,
    [itemId],
  );
}

/**
 * Slots on the runner reserved for other items that resume there. An item that holds a
 * reservation itself only yields to the reservations ranked ahead of its own.
 */
export function pinnedSlotsReserved(
  db: Database,
  runnerId: string,
  itemId: string,
  now: number,
): number {
  const rows = db
    .query<{ itemId: string; runnerId: string; slotOrder: number }, [number]>(
      `SELECT json_extract(payload,'$.itemId') AS itemId,
       json_extract(payload,'$.pinnedSlot.runnerId') AS runnerId,
       json_extract(payload,'$.pinnedSlot.order') AS slotOrder
       FROM job WHERE ${RESERVING_JOBS} AND json_extract(payload,'$.pinnedSlot') IS NOT NULL
       AND (status='pending' OR (status='running' AND (locked_until IS NULL OR locked_until>?)))`,
    )
    .all(now);
  const own = rows.find((row) => row.itemId === itemId && row.runnerId === runnerId)?.slotOrder;
  return new Set(
    rows
      .filter(
        (row) =>
          row.itemId !== itemId &&
          row.runnerId === runnerId &&
          (own === undefined || row.slotOrder < own),
      )
      .map((row) => row.itemId),
  ).size;
}

/** Ending execution authority retains the slot until generation-bound termination is confirmed. */
export function runnerCancelPending(db: Database, runnerId: string, _now: number): boolean {
  return (
    db
      .query(`SELECT 1 FROM runner_work WHERE runner_id=?
    AND ended_at IS NOT NULL AND teardown_confirmed_at IS NULL`)
      .get(runnerId) !== null
  );
}

/** Read-only admission check. Helpers share one runtime slot, independently of work capacity.
 * A foreground helper may replace unfinished grouping, but only its dispatch may fence it. */
export function runnerHelperAvailability(
  db: Database,
  runnerId: string,
  now: number,
  foreground: boolean,
) {
  const rows = db
    .query<{ envelope: string; result: string | null }, [string, number]>(
      "SELECT envelope,result FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND expires_at>?",
    )
    .all(runnerId, now);
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
  const { occupied, capacity } = runnerOccupancy(db, runnerId, now);
  return {
    available: rows.length === maintenance && occupied - maintenance < capacity,
    preempts: maintenance > 0,
  };
}

/** Foreground session helpers fence unfinished maintenance work before taking its slot.
 * The runner renews helper authority before continuing, so the old turn is stopped before the next helper starts. */
export function yieldFindingGroupHelpers(db: Database, runnerId: string, now: number): void {
  immediate(db, () => {
    const rows = db
      .query<{ id: string; envelope: string }, [string, number]>(
        "SELECT id,envelope FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND expires_at>?",
      )
      .all(runnerId, now);
    for (const row of rows) {
      const envelope = JSON.parse(row.envelope) as { payload: string };
      const command = JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")) as {
        type: string;
        purpose?: string;
      };
      if (command.type !== "helper" || command.purpose !== "finding_groups") continue;
      db.run(
        "UPDATE runner_helper SET ended_at=? WHERE id=? AND ended_at IS NULL AND result IS NULL",
        [now, row.id],
      );
      db.run(
        "UPDATE runner_execution_usage SET ended_at=?,outcome='preempted' WHERE command_id=? AND ended_at IS NULL AND EXISTS(SELECT 1 FROM runner_helper WHERE id=? AND ended_at IS NOT NULL)",
        [now, row.id, row.id],
      );
    }
  });
}
