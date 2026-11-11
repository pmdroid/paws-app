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
  sqliteDb,
} from "./index";

const checkpoint = { phase: "running" as const, baseSha: "base", wipCommit: "s" };

for (const reason of ["findings", "review", "ci"] as const) {
  for (const recovery of ["transient", "startup", "orphan"] as const) {
    test(`${reason} input survives ${recovery} recovery`, async () => {
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
      await markCloseoutAccepted(sqliteDb(db), "item", "s");
      if (reason === "findings") finishCloseoutProgress(db, "item", identity, "rejected", 3);
      const body = `Address pending ${reason}`;
      const jobId = restart(db, getWorkItem(db, "item")!, { reason, body, limit: 4, now: 4 })!;
      applyWorkItemEvent(db, "item", "dispatched");
      db.run("UPDATE job SET status='dead', finished_at=5 WHERE id=?", [jobId]);
      const item = getWorkItem(db, "item")!;
      if (recovery === "transient") {
        await deferWorkItem(sqliteDb(db), item, {
          retry: 1,
          delayMs: 1,
          handoff: null,
          message: null,
          now: 10,
        });
      } else if (recovery === "startup") {
        await recoverOnStartup(sqliteDb(db), 10);
      } else {
        expect(await requeueOrphanedWork(sqliteDb(db), 400_000)).toEqual(["item"]);
      }
      const job = listJobs(db).at(-1)!;
      expect(job.payload).toMatchObject({ handoff: body, limit: 4 });
      expect((await pendingRestartHandoff(sqliteDb(db), "item")).handoff).toBe(body);
      if (reason === "findings") expect(getWorkItem(db, "item")?.acceptedHead).toBeNull();
      db.close();
    });
  }
}

test("completed input is not resurrected by recovery", async () => {
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
  applyWorkItemEvent(db, "item", "turn_ended");
  await recoverOnStartup(sqliteDb(db), 10);
  expect(listJobs(db).at(-1)!.payload).not.toHaveProperty("handoff");
  expect(await pendingRestartHandoff(sqliteDb(db), "item")).toEqual({});
  db.close();
});

test("pending input follows activation order when an older job row is reused", async () => {
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
  await reenqueueJob(sqliteDb(db), {
    queue: JOB_KIND.resume,
    jobKey: "reused",
    payload: { itemId: "item", handoff: "new CI failure" },
    now: 3,
  });
  expect(await pendingRestartHandoff(sqliteDb(db), "item")).toEqual({ handoff: "new CI failure" });
  db.run("UPDATE job SET status='done' WHERE id=?", [first]);
  expect(await pendingRestartHandoff(sqliteDb(db), "item")).toEqual({});
  db.close();
});

async function acceptedFollowUp() {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "item" });
  beginImplementRun(db, "item", 1, checkpoint);
  applyWorkItemEvent(db, "item", "turn_ended");
  applyWorkItemEvent(db, "item", "closeout_accepted");
  await markCloseoutAccepted(sqliteDb(db), "item", "s");
  const body = "Fix the failing CI checks on acme/widgets";
  const jobId = restart(db, getWorkItem(db, "item")!, {
    reason: "follow_up",
    body,
    now: Date.now(),
  })!;
  applyWorkItemEvent(db, "item", "dispatched");
  return { db, body, jobId };
}

test("a follow-up whose turn a clean stop aborted is carried into the recovery resume", async () => {
  const { db, body, jobId } = await acceptedFollowUp();
  db.run("UPDATE job SET status='done', finished_at=6 WHERE id=?", [jobId]);
  await recoverOnStartup(sqliteDb(db), 10);
  expect(listJobs(db).at(-1)!.payload).toMatchObject({ handoff: body });
  expect((await pendingRestartHandoff(sqliteDb(db), "item")).handoff).toBe(body);
  db.close();
});

test("a follow-up whose turn a crash cut off is carried into the recovery resume", async () => {
  const { db, body, jobId } = await acceptedFollowUp();
  db.run("UPDATE job SET status='running', locked_until=5 WHERE id=?", [jobId]);
  await recoverOnStartup(sqliteDb(db), 10);
  expect(listJobs(db).at(-1)!.payload).toMatchObject({ handoff: body });
  db.close();
});

test("a follow-up whose turn finished is not repeated after a restart", async () => {
  const { db, jobId } = await acceptedFollowUp();
  db.run("UPDATE job SET status='done', finished_at=6 WHERE id=?", [jobId]);
  applyWorkItemEvent(db, "item", "turn_ended");
  applyWorkItemEvent(db, "item", "closeout_accepted");
  await recoverOnStartup(sqliteDb(db), 10);
  expect(await pendingRestartHandoff(sqliteDb(db), "item")).toEqual({});
  db.close();
});
