import { expect, test } from "bun:test";
import { SystemFault } from "../core";
import {
  beginImplementRun,
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
    expect(holdSystemFault(db, "item", fault, 200)).toBe(true);
    expect(getSystemFault(db, "item")).toMatchObject({
      failures: 2,
      startedAt: previous.startedAt,
      retryAt: 60_200,
    });
    expect(listJobs(db).filter((job) => job.queue === "system.fault-alert")).toHaveLength(1);
    expect(getWorkItem(db, "item")?.state).toBe("running");
  } finally {
    db.close();
  }
});
