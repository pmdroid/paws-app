import { expect, test } from "bun:test";
import { CommandBus, JOB_KIND } from "../src/core";
import { askSteps } from "../src/loop";
import {
  applyLinearCommand,
  applyWorkItemEvent,
  beginMergeCall,
  completeMergedItem,
  drainCommands,
  endMergeCall,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  mergeCallInFlight,
  mergeStopRequested,
  migrate,
  openDatabase,
  recordConfirmedRemoteMerge,
  submitCommand,
  sqliteDb,
} from "../src/db";

async function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  await insertQueuedItem(db, { id: "holder", sessionKey: "session", now: 1 });
  await applyWorkItemEvent(sqliteDb(db), "holder", "dispatched", { now: 1 });
  await applyWorkItemEvent(sqliteDb(db), "holder", "turn_ended", { now: 1 });
  await applyWorkItemEvent(sqliteDb(db), "holder", "closeout_accepted", { now: 1 });
  return db;
}
const command = {
  type: "stop" as const,
  source: "linear" as const,
  itemId: "holder",
  requestedAt: 10,
};

for (const exit of ["cancel", "ask", "fail"] as const) {
  test(`${exit} wakes parked followers immediately`, async () => {
    const db = await setup();
    for (const reason of ["ahead", "dependencies", "ci"])
      await enqueueJob(sqliteDb(db), {
        queue: JOB_KIND.merge,
        jobKey: reason,
        payload: { itemId: reason, mergeWait: { reason } },
        now: 1,
        runAt: 300_000,
      });
    if (exit === "cancel") await applyLinearCommand(sqliteDb(db), command, 10);
    if (exit === "ask")
      await sqliteDb(db).transaction((q) =>
        askSteps(
          q,
          { itemId: "holder", runId: null, sessionId: "session" },
          "ci-help",
          "Need guidance",
          {
            now: 10,
          },
        ),
      );
    if (exit === "fail") {
      await applyWorkItemEvent(sqliteDb(db), "holder", "lease_expired", { now: 10 });
      await applyWorkItemEvent(sqliteDb(db), "holder", "closeout_infra_failed", { now: 10 });
    }
    expect(
      (await listJobs(sqliteDb(db)))
        .filter((j) => j.queue === JOB_KIND.merge)
        .map((j) => [j.jobKey, j.runAt]),
    ).toEqual([
      ["ahead", 10],
      ["dependencies", 10],
      ["ci", 300_000],
    ]);
    db.close();
  });
}

test("a stop during a successful squash waits for completion and answers already merged once", async () => {
  const db = await setup();
  const bus = new CommandBus();
  const emitted: unknown[] = [];
  bus.subscribe((c) => emitted.push(c));
  await beginMergeCall(sqliteDb(db), "holder", "head", 5);
  expect(await submitCommand(sqliteDb(db), bus, command)).toEqual({ applied: false });
  expect(await getWorkItem(sqliteDb(db), "holder")).toMatchObject({
    state: "merge_queue",
    cancelRequested: false,
  });
  expect(await mergeStopRequested(sqliteDb(db), "holder")).toBe(true);
  expect(await drainCommands(sqliteDb(db), bus, 1_010)).toBe(1);
  await recordConfirmedRemoteMerge(sqliteDb(db), {
    itemId: "holder",
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 1,
    pullUrl: null,
    mergeSha: "merged",
    confirmedAt: 1_020,
  });
  expect((await completeMergedItem(sqliteDb(db), { itemId: "holder", now: 1_020 }))?.state).toBe(
    "merged",
  );
  expect(await completeMergedItem(sqliteDb(db), { itemId: "holder", now: 1_021 })).toBeNull();
  expect(await mergeCallInFlight(sqliteDb(db), "holder")).toBe(false);
  await drainCommands(sqliteDb(db), bus, 2_010);
  await drainCommands(sqliteDb(db), bus, 3_010);
  expect(emitted).toEqual([]);
  expect((await getWorkItem(sqliteDb(db), "holder"))?.state).toBe("merged");
  const bodies = (await listOutbox(sqliteDb(db))).map((row) =>
    String((row.payload as { body?: string }).body),
  );
  expect(bodies.filter((b) => b.startsWith("Merged #1"))).toHaveLength(1);
  expect(bodies.filter((b) => b.includes("was already merged"))).toHaveLength(1);
  expect(bodies.some((b) => b.startsWith("Stopped"))).toBe(false);
  expect(
    db.query("SELECT COUNT(*) AS n FROM work_item_event WHERE event='merge_accepted'").get(),
  ).toEqual({ n: 1 });
  db.close();
});

test("a deferred stop cancels when the squash did not succeed", async () => {
  const db = await setup();
  const bus = new CommandBus();
  await beginMergeCall(sqliteDb(db), "holder", "head", 5);
  expect(
    (
      await applyLinearCommand(sqliteDb(db), command, 10, "Stopped by test.", {
        keepPullRequest: true,
      })
    ).deferred,
  ).toBe(true);
  await endMergeCall(sqliteDb(db), "holder");
  await drainCommands(sqliteDb(db), bus, 1_010);
  expect((await getWorkItem(sqliteDb(db), "holder"))?.state).toBe("cancelled");
  expect((await listJobs(sqliteDb(db))).some((j) => j.queue === JOB_KIND.closeStoppedPull)).toBe(
    false,
  );
  expect(
    (await listOutbox(sqliteDb(db))).some((row) =>
      String((row.payload as { body?: string }).body).startsWith("Stopped by test."),
    ),
  ).toBe(true);
  db.close();
});
