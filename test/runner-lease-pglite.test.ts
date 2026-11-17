import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  endRevokedRunnerAuthoritySteps,
  runnerHoldsRunWorkSteps,
  runnerLeaseCutoff,
  runnerWorkHasResultSteps,
  runnerWorkSettledSteps,
  shiftRunnerLeasesForDowntimeSteps,
  type Db,
} from "../src/db";
import { describePglite, seed, withoutForeignKeys, type PgliteTestDb } from "./pglite-fixtures";
import { seedCommand, seedResult, seedRunner, seedWork } from "./runner-rows";

const open: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<PgliteTestDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function leaseOf(db: Db, runId: string) {
  return db.run(function* (q) {
    const row = yield* q.one(
      q.orm
        .select({ leaseUntil: q.t.runnerWork.leaseUntil })
        .from(q.t.runnerWork)
        .where(eq(q.t.runnerWork.runId, runId)),
    );
    return row?.leaseUntil;
  });
}

describePglite((connect) => {
  test("open work holds its run until its lease passes, its result arrives or its cancel is acknowledged", async () => {
    const db = await connected(connect);
    const now = 1_000_000;
    await seedRunner(db, "box");
    await seedWork(db, "leased", "box");
    await seedWork(db, "answered", "box");
    await seedResult(db, "answered", "command-answered", {});
    await seedWork(db, "cancelled", "box");
    await seedCommand(db, "cancel", {
      runnerId: "box",
      runId: "cancelled",
      kind: "cancel",
      acknowledgedAt: 1,
    });
    await seedWork(db, "lapsed", "box", { leaseUntil: runnerLeaseCutoff(now) });
    await seedWork(db, "ended", "box", { endedAt: 1 });

    const settledRuns = [];
    const held = [];
    const heldCancelled = [];
    const answered = [];
    for (const runId of ["leased", "answered", "cancelled", "lapsed", "ended"]) {
      if (await db.run((q) => runnerWorkSettledSteps(q, runId, now))) settledRuns.push(runId);
      if (await db.run((q) => runnerHoldsRunWorkSteps(q, runId, now))) held.push(runId);
      if (await db.run((q) => runnerHoldsRunWorkSteps(q, runId, now, true)))
        heldCancelled.push(runId);
      if (await db.run((q) => runnerWorkHasResultSteps(q, runId))) answered.push(runId);
    }
    expect(settledRuns).toEqual(["answered", "cancelled", "lapsed", "ended"]);
    expect(held).toEqual(["leased", "answered", "cancelled"]);
    expect(heldCancelled).toEqual(["leased", "answered", "cancelled"]);
    expect(answered).toEqual(["answered"]);

    await seedResult(db, "lapsed", "command-lapsed", {});
    expect(await db.run((q) => runnerHoldsRunWorkSteps(q, "lapsed", now))).toBe(true);
    expect(await db.run((q) => runnerHoldsRunWorkSteps(q, "lapsed", now, true))).toBe(false);
  });

  test("a revoked runner's open leases end at the grace cutoff", async () => {
    const db = await connected(connect);
    const now = 1_000_000;
    await seedRunner(db, "box");
    await seedRunner(db, "revoked", { revokedAt: 1 });
    await seedRunner(db, "removed", { status: "revoked" });
    await seedWork(db, "kept", "box");
    await seedWork(db, "fenced", "revoked");
    await seedWork(db, "fenced-too", "removed");
    await seedWork(db, "ended", "revoked", { endedAt: 1 });
    await db.run((q) => endRevokedRunnerAuthoritySteps(q, now));
    expect(await leaseOf(db, "kept")).toBe(Number.MAX_SAFE_INTEGER);
    expect(await leaseOf(db, "fenced")).toBe(runnerLeaseCutoff(now));
    expect(await leaseOf(db, "fenced-too")).toBe(runnerLeaseCutoff(now));
    expect(await leaseOf(db, "ended")).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("taking over a gone instance's runs credits the time no instance was alive", async () => {
    const db = await connected(connect);
    const now = 1_000_000;
    await seedRunner(db, "box");
    await seed(db, (q) =>
      q.orm.insert(q.t.instance).values([
        {
          id: "gone",
          role: "all",
          host: "elsewhere",
          startedAt: 0,
          heartbeatAt: 1_000,
          stoppedAt: 1_000,
        },
        { id: "self", role: "all", host: "here", startedAt: 900_000, heartbeatAt: now },
      ]),
    );
    await seedWork(db, "shifted", "box", { leaseUntil: 1_000 });
    await seedCommand(db, "command-shifted", { runnerId: "box", runId: "shifted", kind: "run" });
    await seed(db, (q) =>
      q.orm.insert(q.t.run).values({
        id: "shifted",
        itemId: "item",
        kind: "implement",
        agent: "codex",
        status: "active",
        createdAt: 0,
        updatedAt: 0,
        ownerInstance: "gone",
      }),
    );
    await seedWork(db, "answered", "box", { leaseUntil: 1_000 });
    await seedCommand(db, "command-answered", { runnerId: "box", runId: "answered", kind: "run" });
    await seedResult(db, "answered", "command-answered", {});

    await db.run((q) => shiftRunnerLeasesForDowntimeSteps(q, now, 30 * 60_000, "self"));
    expect(await leaseOf(db, "shifted")).toBe(900_000);
    expect(await leaseOf(db, "answered")).toBe(1_000);
  });
});
