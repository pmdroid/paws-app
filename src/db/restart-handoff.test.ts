import { expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  deferWorkItem,
  enqueueJob,
  finishCloseoutProgress,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  pendingRestartHandoff,
  recoverOnStartup,
  restart,
  requeueOrphanedWork,
  reenqueueJob,
} from "./index";

const checkpoint = { phase: "running" as const, baseSha: "base", wipCommit: "s" };

for (const reason of ["findings", "review", "ci"] as const) {
  for (const recovery of ["transient", "startup", "orphan"] as const) {
    test(`${reason} input survives ${recovery} recovery`, () => {
      const db = openDatabase(":memory:");
      migrate(db);
      insertQueuedItem(db, { id: "item" });
      beginImplementRun(db, "item", 1, checkpoint);
      applyWorkItemEvent(db, "item", "turn_ended");
      applyWorkItemEvent(db, "item", "closeout_accepted");
      const identity = {
        taskId: "item",
        base: "base",
        head: "s",
        policyDigest: "p",
        policyPath: null,
      };
      finishCloseoutProgress(db, "item", identity, "accepted", 2);
      markCloseoutAccepted(db, "item", "s");
      if (reason === "findings") finishCloseoutProgress(db, "item", identity, "rejected", 3);
      const body = `Address pending ${reason}`;
      const jobId = restart(db, getWorkItem(db, "item")!, { reason, body, limit: 4, now: 4 })!;
      applyWorkItemEvent(db, "item", "dispatched");
      db.run("UPDATE job SET status='dead', finished_at=5 WHERE id=?", [jobId]);
      const item = getWorkItem(db, "item")!;
      if (recovery === "transient") {
        deferWorkItem(db, item, { retry: 1, delayMs: 1, handoff: null, message: null, now: 10 });
      } else if (recovery === "startup") {
        recoverOnStartup(db, 10);
      } else {
        expect(requeueOrphanedWork(db, 400_000)).toEqual(["item"]);
      }
      const job = listJobs(db).at(-1)!;
      expect(job.payload).toMatchObject({ handoff: body, limit: 4 });
      expect(pendingRestartHandoff(db, "item").handoff).toBe(body);
      if (reason === "findings") expect(getWorkItem(db, "item")?.acceptedHead).toBeNull();
      db.close();
    });
  }
}

test("completed input is not resurrected by recovery", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item" });
  beginImplementRun(db, "item", 1, checkpoint);
  const id = enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId: "item", handoff: "old review" },
    now: 1,
  });
  db.run("UPDATE job SET status='done' WHERE id=?", [id]);
  recoverOnStartup(db, 10);
  expect(listJobs(db).at(-1)!.payload).not.toHaveProperty("handoff");
  expect(pendingRestartHandoff(db, "item")).toEqual({});
  db.close();
});

test("pending input follows activation order when an older job row is reused", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item" });
  const first = enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "reused",
    payload: { itemId: "item" },
    now: 1,
  });
  db.run("UPDATE job SET status='done' WHERE id=?", [first]);
  enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId: "item", handoff: "older review" },
    now: 2,
  });
  reenqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "reused",
    payload: { itemId: "item", handoff: "new CI failure" },
    now: 3,
  });
  expect(pendingRestartHandoff(db, "item")).toEqual({ handoff: "new CI failure" });
  db.run("UPDATE job SET status='done' WHERE id=?", [first]);
  expect(pendingRestartHandoff(db, "item")).toEqual({});
  db.close();
});
