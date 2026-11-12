import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../core";
import {
  beginImplementRun,
  enqueueJob,
  getJob,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  markCloseoutAccepted,
  OutboxDispatcher,
  type Db,
} from "../db";
import { createFakeTracker } from "../linear";
import { mergeAcceptedWork } from "./accepted-work";
import { MERGE_OWNER_POLL_MS } from "./merge-jobs";
import { attachOrchestrator } from "./orchestrator";
import { seed } from "../../test/dialects";
import { and, eq } from "drizzle-orm";
import { tempStore } from "../../test/pglite";

const ITEM = "pas-1305";
const HEAD = "a".repeat(40);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function hungTurn() {
  const root = await mkdtemp(join(tmpdir(), "paws-merge-turn-"));
  const { db, close } = await tempStore();
  const clock = new FakeClock(1_000_000);
  const tracker = createFakeTracker();
  const lines: string[] = [];
  const jobs = new JobLoop(db, clock);
  const orchestrator = attachOrchestrator({
    store: db,
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    clock,
    tracker,
    journal: (line) => lines.push(line),
  });
  await insertQueuedItem(db, { id: ITEM, sessionKey: "", now: clock.now() });
  await beginImplementRun(db, ITEM, clock.now());
  await markCloseoutAccepted(db, ITEM, HEAD);
  const read = tracker.issueMergeContext.bind(tracker);
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let hung = false;
  tracker.issueMergeContext = async (issueId, options) => {
    if (hung) return read(issueId, options);
    hung = true;
    entered();
    await released;
    return read(issueId);
  };
  const resumeId = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId: ITEM, reason: "answer" },
    now: clock.now(),
  });
  const turn = jobs.tick([JOB_KIND.resume]);
  await reached;
  cleanups.push(async () => {
    release();
    await turn.catch(() => undefined);
    await orchestrator.shutdown().catch(() => undefined);
    await close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, clock, jobs, lines, resumeId };
}

async function mergeJob(db: Db, now: number) {
  return await enqueueJob(db, {
    queue: JOB_KIND.merge,
    payload: { itemId: ITEM, head: HEAD },
    now,
  });
}

async function parkedForTurn(db: Db, id: number, now: number) {
  const job = (await getJob(db, id))!;
  return job.status === "pending" && job.attempts === 0 && job.runAt === now + MERGE_OWNER_POLL_MS;
}

test("a Merge answer that ends a hung turn's job no longer parks the merge behind it", async () => {
  const { db, clock, jobs, lines, resumeId } = await hungTurn();
  expect(await mergeAcceptedWork(db, ITEM, { now: clock.now() })).toBe(true);
  expect((await getJob(db, resumeId))?.status).toBe("cancelled");
  expect((await getWorkItem(db, ITEM))?.state).toBe("merge_queue");
  const merge = (await db.run((q) =>
    q.one(
      q.orm
        .select({ id: q.t.job.id })
        .from(q.t.job)
        .where(and(eq(q.t.job.queue, JOB_KIND.merge), eq(q.t.job.status, "pending"))),
    ),
  ))!.id;

  expect((await jobs.tick([JOB_KIND.merge]))?.id).toBe(merge);

  expect(await parkedForTurn(db, merge, clock.now())).toBe(false);
  expect((await getJob(db, merge))?.attempts).toBe(1);
  expect(lines).toContain(
    `merge for item ${ITEM} dropped the stale context of ${JOB_KIND.resume} job ${resumeId}, which is no longer running`,
  );
});

test("a merge parked behind a running job journals why, once per ten minutes", async () => {
  const { db, clock, jobs, lines, resumeId } = await hungTurn();
  const waiting = `merge for item ${ITEM} waits for its turn behind ${JOB_KIND.resume} job ${resumeId}`;
  const merge = await mergeJob(db, clock.now());

  await jobs.tick([JOB_KIND.merge]);
  expect(await parkedForTurn(db, merge, clock.now())).toBe(true);
  clock.advance(MERGE_OWNER_POLL_MS);
  await jobs.tick([JOB_KIND.merge]);
  expect(await parkedForTurn(db, merge, clock.now())).toBe(true);
  expect(lines.filter((line) => line === waiting)).toHaveLength(1);

  clock.advance(10 * 60_000);
  await jobs.tick([JOB_KIND.merge]);
  expect(await parkedForTurn(db, merge, clock.now())).toBe(true);
  expect(lines.filter((line) => line === waiting)).toHaveLength(2);
});

test("a context whose job finished in the job table is dropped and the merge goes ahead", async () => {
  const { db, clock, jobs, lines, resumeId } = await hungTurn();
  await seed(db, (q) =>
    q.orm
      .update(q.t.job)
      .set({ status: "done", lockedBy: null, lockedUntil: null })
      .where(eq(q.t.job.id, resumeId)),
  );
  const merge = await mergeJob(db, clock.now());

  await jobs.tick([JOB_KIND.merge]);

  expect(await parkedForTurn(db, merge, clock.now())).toBe(false);
  expect(lines.some((line) => line.includes("dropped the stale context"))).toBe(true);
  expect(lines.some((line) => line.includes("waits for its turn"))).toBe(false);
});
