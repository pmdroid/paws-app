import { expect, test } from "bun:test";
import { SystemFault } from "../core";
import {
  beginImplementRun,
  enqueueJob,
  clearSystemFault,
  listSystemFaults,
  systemFaultAlertIssue,
  getSystemFault,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
} from "../db";
import { holdSystemFault } from "./system-fault";

test("a version change preserves infrastructure backoff and its single alert epoch", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    insertQueuedItem(db, { id: "item", sessionKey: "session" });
    beginImplementRun(db, "item", 0);
    const fault = new SystemFault("reviewer-profile", "review command is not supported");
    expect(holdSystemFault(db, "item", fault, 100)).toBe(true);
    const previous = getSystemFault(db, "item")!;
    db.run("UPDATE work_item SET version=version+1 WHERE id='item'");
    expect(getSystemFault(db, "item")?.faultClass).toBe("reviewer-profile");
    expect(listSystemFaults(db)).toHaveLength(1);
    expect(holdSystemFault(db, "item", fault, 200)).toBe(true);
    expect(getSystemFault(db, "item")).toMatchObject({
      failures: 2,
      startedAt: previous.startedAt,
      retryAt: 60_200,
    });
    expect(alertIds(db).size).toBe(1);
    expect(getWorkItem(db, "item")?.state).toBe("running");
  } finally {
    db.close();
  }
});

for (const state of ["running", "verifying", "merge_queue", "recovering", "paused"] as const) {
  test(`an infrastructure fault in ${state} keeps its reason and schedules the correct retry`, () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db);
      insertQueuedItem(db, { id: "item", sessionKey: "session" });
      // Simulate a fault arriving after the owner has moved to this state.
      db.run("UPDATE work_item SET state=? WHERE id='item'", [state]);
      expect(
        holdSystemFault(db, "item", new SystemFault("closeout-transfer", "transfer failed"), 100),
      ).toBe(true);
      expect(getSystemFault(db, "item")).toMatchObject({
        reason: "transfer failed",
        retryAt: 30_100,
      });
      expect(listSystemFaults(db)).toHaveLength(1);
      const retry = listJobs(db).find((job) => job.queue !== "system.fault-alert");
      if (state === "paused") expect(retry).toBeUndefined();
      else
        expect(retry).toMatchObject({
          queue: ["verifying", "merge_queue"].includes(state) ? "run.reverify" : "run.resume",
          runAt: 30_100,
        });
      expect(getWorkItem(db, "item")?.state).toBe(state);
    } finally {
      db.close();
    }
  });
}

test("the alert epoch survives the oldest item's recovery until all holds clear", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const fault = new SystemFault("closeout-transfer", "transfer failed");
    for (const id of ["a", "b"]) {
      insertQueuedItem(db, { id, sessionKey: `session-${id}` });
      beginImplementRun(db, id, 0);
    }
    holdSystemFault(db, "a", fault, 100);
    holdSystemFault(db, "b", fault, 200);
    clearSystemFault(db, "a");
    holdSystemFault(db, "b", fault, 300);
    expect(alertIds(db).size).toBe(1);
    clearSystemFault(db, "b");
    holdSystemFault(db, "b", fault, 400);
    expect(alertIds(db).size).toBe(2);
  } finally {
    db.close();
  }
});

function alertIds(db: ReturnType<typeof openDatabase>): Set<string> {
  return new Set(
    listJobs(db)
      .filter((job) => job.queue === "system.fault-alert")
      .map((job) => (job.payload as { alertId: string }).alertId),
  );
}

test("a fault reuses an existing pending reverify and delays it until backoff ends", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    insertQueuedItem(db, { id: "item", sessionKey: "session" });
    db.run("UPDATE work_item SET state='verifying' WHERE id='item'");
    const original = enqueueJob(db, {
      queue: "run.reverify",
      payload: { itemId: "item", reason: "ci" },
      runAt: 200,
    });
    enqueueJob(db, { queue: "run.reverify", payload: { itemId: "item" }, runAt: 300 });
    const fault = new SystemFault("closeout-transfer", "transfer failed");
    holdSystemFault(db, "item", fault, 100);
    holdSystemFault(db, "item", fault, 200);
    const pending = listJobs(db).filter(
      (job) => job.queue === "run.reverify" && job.status === "pending",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: original, runAt: 60_200, payload: { reason: "ci" } });
  } finally {
    db.close();
  }
});

test("an outage comment waits for an issue and then retains that destination", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    expect(systemFaultAlertIssue(db, "alert", null)).toBeNull();
    expect(systemFaultAlertIssue(db, "alert", "issue-1")).toBe("issue-1");
    expect(systemFaultAlertIssue(db, "alert", "issue-2")).toBe("issue-1");
    expect(systemFaultAlertIssue(db, "alert", null)).toBe("issue-1");
  } finally {
    db.close();
  }
});
