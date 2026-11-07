import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  itemOpenRunnerWorkRunsSteps,
  itemOpenRunnerWorkSteps,
  itemRunnerCancelWorkSteps,
  itemRunnerWorkReportsSteps,
  lastRunnerEventSequenceSteps,
  openRunnerWorkCommandSteps,
  pendingRunnerCancelSteps,
  runnerEventsAfterSteps,
  runnerHandoverSentSteps,
  runnerResultPayloadSteps,
  runnerWorkActiveSteps,
  runnerWorkEndedSteps,
} from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedCommand, seedResult, seedRun, seedRunner, seedWork } from "./runner-rows";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

forEachDialect((connect) => {
  test("an item's open work, its command and its cancel requests", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box", { lastSeenAt: 50, liveReportedAt: 40 });
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId: "box", runnerVersion: "1.2.3", reportedAt: 0 }),
    );
    await seedRun(db, "run-old", "item");
    await seedRun(db, "run-new", "item");
    await seedWork(db, "run-old", "box", { endedAt: 5, leaseUntil: 7 });
    await seedWork(db, "run-new", "box", { generation: 2, leaseUntil: 9 });
    await seedCommand(db, "command-run-new", {
      runnerId: "box",
      runId: "run-new",
      kind: "run",
      generation: 2,
      envelope: { a: 1 },
    });
    await seedCommand(db, "command-run-old", {
      runnerId: "box",
      runId: "run-old",
      kind: "run",
      expiresAt: 3,
    });
    await seedCommand(db, "cancel-1", {
      runnerId: "box",
      runId: "run-old",
      kind: "cancel",
      expiresAt: 100,
    });
    await seedCommand(db, "cancel-2", {
      runnerId: "box",
      runId: "run-old",
      kind: "cancel",
      expiresAt: 200,
    });

    expect(await db.run((q) => itemOpenRunnerWorkRunsSteps(q, "item"))).toEqual([
      { runId: "run-new" },
    ]);
    expect(await db.run((q) => itemOpenRunnerWorkSteps(q, "item"))).toEqual({
      runId: "run-new",
      runnerId: "box",
      workspaceId: "acme",
      generation: 2,
    });
    expect(await db.run((q) => itemOpenRunnerWorkSteps(q, "other"))).toBeNull();

    const cancels = await db.run((q) => itemRunnerCancelWorkSteps(q, "item"));
    expect(cancels.sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
      {
        runId: "run-new",
        runnerId: "box",
        workspaceId: "acme",
        generation: 2,
        leaseUntil: 9,
        requested: 1,
      },
      {
        runId: "run-old",
        runnerId: "box",
        workspaceId: "acme",
        generation: 1,
        leaseUntil: 7,
        requested: 1,
      },
    ]);
    const lookup = { runId: "run-old", runnerId: "box", generation: 1, now: 150 };
    expect(await db.run((q) => pendingRunnerCancelSteps(q, lookup))).toEqual({
      id: "cancel-2",
      expiresAt: 200,
    });
    expect(await db.run((q) => pendingRunnerCancelSteps(q, { ...lookup, now: 250 }))).toBeNull();

    await seed(db, (q) =>
      q.orm
        .update(q.t.runnerCommand)
        .set({ acknowledgedAt: 10 })
        .where(eq(q.t.runnerCommand.id, "cancel-2")),
    );
    const settledCancel = await db.run((q) => itemRunnerCancelWorkSteps(q, "item"));
    expect(settledCancel.find((row) => row.runId === "run-old")?.requested).toBe(0);

    const reports = await db.run((q) => itemRunnerWorkReportsSteps(q, "item"));
    expect(reports.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))).toEqual([
      {
        endedAt: null,
        confirmedAt: null,
        reportedAt: 40,
        acknowledgedAt: null,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      { endedAt: 5, confirmedAt: null, reportedAt: 40, acknowledgedAt: null, expiresAt: 3 },
    ]);

    const command = await db.run((q) => openRunnerWorkCommandSteps(q, "run-new"));
    expect({ ...command!, envelope: JSON.parse(command!.envelope) }).toEqual({
      runnerId: "box",
      workspaceId: "acme",
      generation: 2,
      envelope: { a: 1 },
      lastSeen: 50,
      version: "1.2.3",
    });
    expect(await db.run((q) => openRunnerWorkCommandSteps(q, "run-old"))).toBeNull();
  });

  test("a run's handover, end, events and result", async () => {
    const db = await connected(connect);
    await seedRunner(db, "box");
    await seedWork(db, "run-1", "box", { endedAt: 5 });
    await seedWork(db, "run-2", "box");
    await seedCommand(db, "handover", { runnerId: "box", runId: "run-1", kind: "handover" });
    const event = (sequence: number, type: string | null, keyId: string | null = null) => ({
      runId: "run-1",
      generation: 1,
      sequence,
      payload: json(db, { sequence }),
      receivedAt: 0,
      keyId,
      type,
    });
    await seed(db, (q) =>
      q.orm
        .insert(q.t.runnerEvent)
        .values([
          event(1, "activity"),
          event(2, "checkpoint"),
          event(3, null),
          event(4, null, "key"),
          event(5, "handover"),
        ]),
    );
    await seedResult(db, "run-1", "command-run-1", { done: true });

    expect(await db.run((q) => runnerHandoverSentSteps(q, "run-1", 1))).toBe(true);
    expect(await db.run((q) => runnerHandoverSentSteps(q, "run-1", 2))).toBe(false);
    expect(await db.run((q) => runnerWorkEndedSteps(q, "run-1", 1))).toBe(true);
    expect(await db.run((q) => runnerWorkEndedSteps(q, "run-2", 1))).toBe(false);
    expect(await db.run((q) => lastRunnerEventSequenceSteps(q, "run-1", 1))).toBe(5);
    expect(await db.run((q) => lastRunnerEventSequenceSteps(q, "run-2", 1))).toBe(0);

    const events = await db.run((q) =>
      runnerEventsAfterSteps(q, { runId: "run-1", generation: 1, after: 1, types: ["checkpoint"] }),
    );
    expect(
      events.map((row) => [row.sequence, JSON.parse(row.payload).sequence, row.keyId]),
    ).toEqual([
      [2, 2, null],
      [3, 3, null],
    ]);

    expect(JSON.parse((await db.run((q) => runnerResultPayloadSteps(q, "run-1", 1)))!)).toEqual({
      done: true,
    });
    expect(await db.run((q) => runnerResultPayloadSteps(q, "run-2", 1))).toBeNull();

    expect(await db.run((q) => runnerWorkActiveSteps(q, "run-1"))).toBe(true);
    expect(await db.run((q) => runnerWorkActiveSteps(q, "run-2"))).toBe(false);
    expect(await db.run((q) => runnerWorkActiveSteps(q, "run-3"))).toBeNull();
  });
});
