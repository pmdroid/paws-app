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
  migrate,
  openDatabase,
  OutboxDispatcher,
  sqliteDb,
} from "../db";
import { createFakeTracker } from "../linear";
import { mergeAcceptedWork } from "./accepted-work";
import { MERGE_OWNER_POLL_MS } from "./merge-jobs";
import { attachOrchestrator } from "./orchestrator";

const ITEM = "pas-1305";
const HEAD = "a".repeat(40);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function hungTurn() {
  const root = await mkdtemp(join(tmpdir(), "paws-merge-turn-"));
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000_000);
  const tracker = createFakeTracker();
  const lines: string[] = [];
  const jobs = new JobLoop(db, clock);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    clock,
    tracker,
    journal: (line) => lines.push(line),
  });
  insertQueuedItem(db, { id: ITEM, sessionKey: "", now: clock.now() });
  await beginImplementRun(sqliteDb(db), ITEM, clock.now());
  await markCloseoutAccepted(sqliteDb(db), ITEM, HEAD);
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
  const resumeId = enqueueJob(db, {
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
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, clock, jobs, lines, resumeId };
}

function mergeJob(db: ReturnType<typeof openDatabase>, now: number) {
  return enqueueJob(db, { queue: JOB_KIND.merge, payload: { itemId: ITEM, head: HEAD }, now });
}

function parkedForTurn(db: ReturnType<typeof openDatabase>, id: number, now: number) {
  const job = getJob(db, id)!;
  return job.status === "pending" && job.attempts === 0 && job.runAt === now + MERGE_OWNER_POLL_MS;
}

test("a Merge answer that ends a hung turn's job no longer parks the merge behind it", async () => {
  const { db, clock, jobs, lines, resumeId } = await hungTurn();
  expect(await mergeAcceptedWork(sqliteDb(db), ITEM, { now: clock.now() })).toBe(true);
  expect(getJob(db, resumeId)?.status).toBe("cancelled");
  expect(getWorkItem(db, ITEM)?.state).toBe("merge_queue");
  const merge = db
    .query<{ id: number }, [string]>("SELECT id FROM job WHERE queue = ? AND status = 'pending'")
    .get(JOB_KIND.merge)!.id;

  expect((await jobs.tick([JOB_KIND.merge]))?.id).toBe(merge);

  expect(parkedForTurn(db, merge, clock.now())).toBe(false);
  expect(getJob(db, merge)?.attempts).toBe(1);
  expect(lines).toContain(
    `merge for item ${ITEM} dropped the stale context of ${JOB_KIND.resume} job ${resumeId}, which is no longer running`,
  );
});

test("a merge parked behind a running job journals why, once per ten minutes", async () => {
  const { db, clock, jobs, lines, resumeId } = await hungTurn();
  const waiting = `merge for item ${ITEM} waits for its turn behind ${JOB_KIND.resume} job ${resumeId}`;
  const merge = mergeJob(db, clock.now());

  await jobs.tick([JOB_KIND.merge]);
  expect(parkedForTurn(db, merge, clock.now())).toBe(true);
  clock.advance(MERGE_OWNER_POLL_MS);
  await jobs.tick([JOB_KIND.merge]);
  expect(parkedForTurn(db, merge, clock.now())).toBe(true);
  expect(lines.filter((line) => line === waiting)).toHaveLength(1);

  clock.advance(10 * 60_000);
  await jobs.tick([JOB_KIND.merge]);
  expect(parkedForTurn(db, merge, clock.now())).toBe(true);
  expect(lines.filter((line) => line === waiting)).toHaveLength(2);
});

test("a context whose job finished in the job table is dropped and the merge goes ahead", async () => {
  const { db, clock, jobs, lines, resumeId } = await hungTurn();
  db.run("UPDATE job SET status = 'done', locked_by = NULL, locked_until = NULL WHERE id = ?", [
    resumeId,
  ]);
  const merge = mergeJob(db, clock.now());

  await jobs.tick([JOB_KIND.merge]);

  expect(parkedForTurn(db, merge, clock.now())).toBe(false);
  expect(lines.some((line) => line.includes("dropped the stale context"))).toBe(true);
  expect(lines.some((line) => line.includes("waits for its turn"))).toBe(false);
});
