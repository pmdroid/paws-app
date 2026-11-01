import { expect, test } from "bun:test";
import { CommandBus, JOB_KIND } from "../core";
import { ask } from "../loop";
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
} from "./index";

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "holder", sessionKey: "session", now: 1 });
  applyWorkItemEvent(db, "holder", "dispatched", { now: 1 });
  applyWorkItemEvent(db, "holder", "turn_ended", { now: 1 });
  applyWorkItemEvent(db, "holder", "closeout_accepted", { now: 1 });
  return db;
}
const command = {
  type: "stop" as const,
  source: "linear" as const,
  itemId: "holder",
  requestedAt: 10,
};

for (const exit of ["cancel", "ask", "fail"] as const) {
  test(`${exit} wakes parked followers immediately`, () => {
    const db = setup();
    for (const reason of ["ahead", "dependencies", "ci"])
      enqueueJob(db, {
        queue: JOB_KIND.merge,
        jobKey: reason,
        payload: { itemId: reason, mergeWait: { reason } },
        now: 1,
        runAt: 300_000,
      });
    if (exit === "cancel") applyLinearCommand(db, command, 10);
    if (exit === "ask")
      ask(db, { itemId: "holder", runId: null, sessionId: "session" }, "ci-help", "Need guidance", {
        now: 10,
      });
    if (exit === "fail") {
      applyWorkItemEvent(db, "holder", "lease_expired", { now: 10 });
      applyWorkItemEvent(db, "holder", "closeout_infra_failed", { now: 10 });
    }
    expect(
      listJobs(db)
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

test("a stop during a successful squash waits for completion and answers already merged once", () => {
  const db = setup();
  const bus = new CommandBus();
  const emitted: unknown[] = [];
  bus.subscribe((c) => emitted.push(c));
  beginMergeCall(db, "holder", "head", 5);
  expect(submitCommand(db, bus, command)).toEqual({ applied: false });
  expect(getWorkItem(db, "holder")).toMatchObject({ state: "merge_queue", cancelRequested: false });
  expect(mergeStopRequested(db, "holder")).toBe(true);
  expect(drainCommands(db, bus, 1_010)).toBe(1);
  recordConfirmedRemoteMerge(db, {
    itemId: "holder",
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 1,
    pullUrl: null,
    mergeSha: "merged",
    confirmedAt: 1_020,
  });
  expect(completeMergedItem(db, { itemId: "holder", now: 1_020 })?.state).toBe("merged");
  expect(completeMergedItem(db, { itemId: "holder", now: 1_021 })).toBeNull();
  expect(mergeCallInFlight(db, "holder")).toBe(false);
  drainCommands(db, bus, 2_010);
  drainCommands(db, bus, 3_010);
  expect(emitted).toEqual([]);
  expect(getWorkItem(db, "holder")?.state).toBe("merged");
  const bodies = listOutbox(db).map((row) => String((row.payload as { body?: string }).body));
  expect(bodies.filter((b) => b.startsWith("Merged #1"))).toHaveLength(1);
  expect(bodies.filter((b) => b.includes("was already merged"))).toHaveLength(1);
  expect(bodies.some((b) => b.startsWith("Stopped"))).toBe(false);
  expect(
    db.query("SELECT COUNT(*) AS n FROM work_item_event WHERE event='merge_accepted'").get(),
  ).toEqual({ n: 1 });
  db.close();
});

test("a deferred stop cancels when the squash did not succeed", () => {
  const db = setup();
  const bus = new CommandBus();
  beginMergeCall(db, "holder", "head", 5);
  expect(
    applyLinearCommand(db, command, 10, "Stopped by test.", { keepPullRequest: true }).deferred,
  ).toBe(true);
  endMergeCall(db, "holder");
  drainCommands(db, bus, 1_010);
  expect(getWorkItem(db, "holder")?.state).toBe("cancelled");
  expect(listJobs(db).some((j) => j.queue === JOB_KIND.closeStoppedPull)).toBe(false);
  expect(
    listOutbox(db).some((row) =>
      String((row.payload as { body?: string }).body).startsWith("Stopped by test."),
    ),
  ).toBe(true);
  db.close();
});
