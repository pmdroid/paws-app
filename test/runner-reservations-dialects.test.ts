import { afterEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  RUNNER_RESERVATION_MS,
  pgSchema,
  releaseRunnerReservation,
  reserveRunnerSlot,
  runnerReservationHolder,
  schema,
  reserveRunnerSlotSteps,
  unassignedRunnerReservations,
  unassignedRunnerReservationsSteps,
  type Db,
} from "../src/db";
import { forEachDialect, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function withoutForeignKeys(db: Db): Promise<void> {
  if (db.dialect === "sqlite") await db.sync((orm) => orm.run(sql`PRAGMA foreign_keys = OFF`));
  else await db.orm.execute(sql`SET session_replication_role = replica`);
}

async function assign(db: Db, runId: string, runnerId: string): Promise<void> {
  const row = {
    runId,
    runnerId,
    workspaceId: "acme",
    generation: 1,
    runnerFence: 0,
    commandId: `command-${runId}`,
    leaseUntil: Number.MAX_SAFE_INTEGER,
  };
  if (db.dialect === "sqlite")
    await db.sync((orm) => orm.insert(schema.runnerWork).values(row).run());
  else await db.orm.insert(pgSchema.runnerWork).values(row);
}

forEachDialect((connect) => {
  test("one instance holds a run's reservation until it expires, and counts show other instances' unassigned ones", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const now = 1_800_000_000_000;

    expect(
      await reserveRunnerSlot(db, {
        runId: "run-1",
        runnerId: "acme-box",
        instanceId: "acme-a",
        now,
      }),
    ).toBe(true);
    expect(
      await reserveRunnerSlot(db, {
        runId: "run-1",
        runnerId: "acme-box",
        instanceId: "acme-b",
        now,
      }),
    ).toBe(false);
    expect(
      await reserveRunnerSlot(db, {
        runId: "run-1",
        runnerId: "acme-box",
        instanceId: "acme-a",
        now,
      }),
    ).toBe(true);
    expect(await runnerReservationHolder(db, "run-1", now)).toBe("acme-a");
    expect(await unassignedRunnerReservations(db, now, "acme-b")).toEqual(
      new Map([["acme-box", 1]]),
    );
    expect(await unassignedRunnerReservations(db, now, "acme-a")).toEqual(new Map());
    expect(await unassignedRunnerReservations(db, now, "acme-b", "run-1")).toEqual(new Map());

    await assign(db, "run-1", "acme-box");
    expect(await unassignedRunnerReservations(db, now, "acme-b")).toEqual(new Map());

    const later = now + RUNNER_RESERVATION_MS;
    expect(await runnerReservationHolder(db, "run-1", later)).toBeNull();
    expect(
      await reserveRunnerSlot(db, {
        runId: "run-1",
        runnerId: "acme-box",
        instanceId: "acme-b",
        now: later,
      }),
    ).toBe(true);
    expect(await runnerReservationHolder(db, "run-1", later)).toBe("acme-b");

    await releaseRunnerReservation(db, "run-1", "acme-a");
    expect(await runnerReservationHolder(db, "run-1", later)).toBe("acme-b");
    await releaseRunnerReservation(db, "run-1", "acme-b");
    expect(await runnerReservationHolder(db, "run-1", later)).toBeNull();
  });

  test("a reservation counts until its own run has work on that runner", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const now = 1_800_000_000_000;
    for (const runId of ["run-1", "run-2", "run-3"])
      await db.run((q) =>
        reserveRunnerSlotSteps(q, { runId, runnerId: "acme-box", instanceId: "acme-a", now }),
      );
    await assign(db, "run-1", "acme-box");
    await assign(db, "run-2", "acme-other");
    expect(await db.run((q) => unassignedRunnerReservationsSteps(q, now, "acme-b"))).toEqual(
      new Map([["acme-box", 2]]),
    );
  });
});
