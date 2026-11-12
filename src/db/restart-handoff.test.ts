import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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
  pendingRestartHandoff,
  recoverOnStartup,
  restart,
  requeueOrphanedWork,
  reenqueueJob,
  type Db,
} from "./index";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

type JobChange = { status: string; finishedAt?: number; lockedUntil?: number };

function updateJob(db: Db, id: number, set: JobChange) {
  return seed(db, (q) => q.orm.update(q.t.job).set(set).where(eq(q.t.job.id, id)));
}

const checkpoint = { phase: "running" as const, baseSha: "base", wipCommit: "s" };

for (const reason of ["findings", "review", "ci"] as const) {
  for (const recovery of ["transient", "startup", "orphan"] as const) {
    test(`${reason} input survives ${recovery} recovery`, async () => {
      const { db, close } = await tempStore();
      await insertQueuedItem(db, { id: "item" });
      await beginImplementRun(db, "item", 1, checkpoint);
      await applyWorkItemEvent(db, "item", "turn_ended");
      await applyWorkItemEvent(db, "item", "closeout_accepted");
      const identity = {
        taskId: "item",
        base: "base",
        head: "s",
        policyDigest: "p",
        policyPath: null,
      };
      await finishCloseoutProgress(db, "item", identity, "accepted", 2);
      await markCloseoutAccepted(db, "item", "s");
      if (reason === "findings") await finishCloseoutProgress(db, "item", identity, "rejected", 3);
      const body = `Address pending ${reason}`;
      const jobId = (await restart(db, (await getWorkItem(db, "item"))!, {
        reason,
        body,
        limit: 4,
        now: 4,
      }))!;
      await applyWorkItemEvent(db, "item", "dispatched");
      await updateJob(db, jobId, { status: "dead", finishedAt: 5 });
      const item = (await getWorkItem(db, "item"))!;
      if (recovery === "transient") {
        await deferWorkItem(db, item, {
          retry: 1,
          delayMs: 1,
          handoff: null,
          message: null,
          now: 10,
        });
      } else if (recovery === "startup") {
        await recoverOnStartup(db, 10);
      } else {
        expect(await requeueOrphanedWork(db, 400_000)).toEqual(["item"]);
      }
      const job = (await listJobs(db)).at(-1)!;
      expect(job.payload).toMatchObject({ handoff: body, limit: 4 });
      expect((await pendingRestartHandoff(db, "item")).handoff).toBe(body);
      if (reason === "findings") expect((await getWorkItem(db, "item"))?.acceptedHead).toBeNull();
      await close();
    });
  }
}

test("completed input is not resurrected by recovery", async () => {
  const { db, close } = await tempStore();
  await insertQueuedItem(db, { id: "item" });
  await beginImplementRun(db, "item", 1, checkpoint);
  const id = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId: "item", handoff: "old review" },
    now: 1,
  });
  await updateJob(db, id, { status: "done" });
  await applyWorkItemEvent(db, "item", "turn_ended");
  await recoverOnStartup(db, 10);
  expect((await listJobs(db)).at(-1)!.payload).not.toHaveProperty("handoff");
  expect(await pendingRestartHandoff(db, "item")).toEqual({});
  await close();
});

test("pending input follows activation order when an older job row is reused", async () => {
  const { db, close } = await tempStore();
  await insertQueuedItem(db, { id: "item" });
  const first = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "reused",
    payload: { itemId: "item" },
    now: 1,
  });
  await updateJob(db, first, { status: "done" });
  await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId: "item", handoff: "older review" },
    now: 2,
  });
  await reenqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: "reused",
    payload: { itemId: "item", handoff: "new CI failure" },
    now: 3,
  });
  expect(await pendingRestartHandoff(db, "item")).toEqual({ handoff: "new CI failure" });
  await updateJob(db, first, { status: "done" });
  expect(await pendingRestartHandoff(db, "item")).toEqual({});
  await close();
});

async function acceptedFollowUp() {
  const { db, close } = await tempStore();
  await insertQueuedItem(db, { id: "item" });
  await beginImplementRun(db, "item", 1, checkpoint);
  await applyWorkItemEvent(db, "item", "turn_ended");
  await applyWorkItemEvent(db, "item", "closeout_accepted");
  await markCloseoutAccepted(db, "item", "s");
  const body = "Fix the failing CI checks on acme/widgets";
  const jobId = (await restart(db, (await getWorkItem(db, "item"))!, {
    reason: "follow_up",
    body,
    now: Date.now(),
  }))!;
  await applyWorkItemEvent(db, "item", "dispatched");
  return { db, close, body, jobId };
}

test("a follow-up whose turn a clean stop aborted is carried into the recovery resume", async () => {
  const { db, close, body, jobId } = await acceptedFollowUp();
  await updateJob(db, jobId, { status: "done", finishedAt: 6 });
  await recoverOnStartup(db, 10);
  expect((await listJobs(db)).at(-1)!.payload).toMatchObject({ handoff: body });
  expect((await pendingRestartHandoff(db, "item")).handoff).toBe(body);
  await close();
});

test("a follow-up whose turn a crash cut off is carried into the recovery resume", async () => {
  const { db, close, body, jobId } = await acceptedFollowUp();
  await updateJob(db, jobId, { status: "running", lockedUntil: 5 });
  await recoverOnStartup(db, 10);
  expect((await listJobs(db)).at(-1)!.payload).toMatchObject({ handoff: body });
  await close();
});

test("a follow-up whose turn finished is not repeated after a restart", async () => {
  const { db, close, jobId } = await acceptedFollowUp();
  await updateJob(db, jobId, { status: "done", finishedAt: 6 });
  await applyWorkItemEvent(db, "item", "turn_ended");
  await applyWorkItemEvent(db, "item", "closeout_accepted");
  await recoverOnStartup(db, 10);
  expect(await pendingRestartHandoff(db, "item")).toEqual({});
  await close();
});
