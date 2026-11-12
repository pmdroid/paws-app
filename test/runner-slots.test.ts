import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  insertRun,
  listRunnerOverview,
  markRun,
  noteRunnerSessionMove,
  putWorkspaceUser,
  releaseRunCapacity,
  requestRunnerSessionMove,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { RUNNER_LEASE_GRACE_MS } from "../src/runner-protocol";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function endWork(db: Db, runId: string, now: number) {
  return seed(db, (q) =>
    q.orm.update(q.t.runnerWork).set({ endedAt: now }).where(eq(q.t.runnerWork.runId, runId)),
  );
}

async function fixture(now: number) {
  const { db, close } = await tempStore();
  open.push(close);
  const userId = await putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "user-linear",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws-1", linearOrganizationId: "org-1", name: "Workspace", createdAt: now }),
  );
  await syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now,
  });
  await seed(db, (q) =>
    q.orm.insert(q.t.runner).values({
      id: "runner-1",
      workspaceId: "ws-1",
      ownerUserId: userId,
      name: "Runner",
      status: "active",
      createdAt: now,
      lastSeenAt: now,
    }),
  );
  async function work(
    index: number,
    lease: number,
    options: { state?: string; startedAt?: number; title?: string } = {},
  ) {
    await seed(db, (q) =>
      q.orm.insert(q.t.workItem).values({
        id: `item-${index}`,
        delegationId: `epic-${index}`,
        linearIssueId: `issue-${index}`,
        linearIdentifier: `ENG-${index}`,
        title: options.title ?? "Task",
        state: options.state ?? "running",
        branchName: `paws/eng-${index}`,
        position: 0,
        createdAt: now,
      }),
    );
    const run = await insertRun(db, {
      itemId: `item-${index}`,
      now: options.startedAt ?? now,
      status: "active",
    });
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerWork).values({
        runId: run.id,
        runnerId: "runner-1",
        workspaceId: "ws-1",
        generation: 1,
        runnerFence: 0,
        commandId: `cmd-${index}`,
        leaseUntil: lease,
      }),
    );
    return run.id;
  }
  return { db, work };
}

test("the runner overview reports used and total slots like placement counts them", async () => {
  const now = Date.now();
  const { db, work } = await fixture(now);
  expect((await listRunnerOverview(db, "ws-1", now))[0]?.slots).toEqual({
    used: 0,
    total: 1,
  });
  await seed(db, (q) =>
    q.orm.insert(q.t.runnerCapacity).values({ runnerId: "runner-1", capacity: 3 }),
  );
  await work(0, now + 60_000);
  await markRun(db, await work(1, now - RUNNER_LEASE_GRACE_MS - 1), "ended", now);
  expect((await listRunnerOverview(db, "ws-1", now))[0]?.slots).toEqual({
    used: 1,
    total: 3,
  });
  await work(2, now - 1);
  expect((await listRunnerOverview(db, "ws-1", now))[0]?.slots).toEqual({
    used: 2,
    total: 3,
  });
});

test("the runner overview lists each live session with its issue and phase", async () => {
  const now = Date.now();
  const { db, work } = await fixture(now);
  expect((await listRunnerOverview(db, "ws-1", now))[0]?.running).toEqual([]);
  const lease = now + 60_000;
  const working = await work(0, lease, { startedAt: now - 50_000, title: "Write the parser" });
  const closeout = await work(1, lease, { state: "verifying", startedAt: now - 40_000 });
  const fixing = await work(2, lease, { startedAt: now - 30_000 });
  await seed(db, (q) =>
    q.orm.insert(q.t.closeoutProgress).values({
      id: "p-2",
      itemId: "item-2",
      taskId: "task",
      base: "a",
      head: "b",
      policyDigest: "d",
      decision: "rejected",
      startedAt: now - 20_000,
      updatedAt: now - 20_000,
      finishedAt: now - 20_000,
    }),
  );
  const merging = await work(3, lease, { state: "merge_queue", startedAt: now - 20_000 });
  await markRun(
    db,
    await work(4, now - RUNNER_LEASE_GRACE_MS - 1, { startedAt: now - 10_000 }),
    "ended",
    now,
  );
  await releaseRunCapacity(db, await work(5, lease, { startedAt: now - 5_000 }), now);

  expect((await listRunnerOverview(db, "ws-1", now))[0]?.running).toEqual([
    {
      runId: working,
      identifier: "ENG-0",
      title: "Write the parser",
      phase: "working",
      startedAt: now - 50_000,
      movable: true,
      move: null,
    },
    {
      runId: closeout,
      identifier: "ENG-1",
      title: "Task",
      phase: "closeout",
      startedAt: now - 40_000,
      movable: true,
      move: null,
    },
    {
      runId: fixing,
      identifier: "ENG-2",
      title: "Task",
      phase: "fixing",
      startedAt: now - 30_000,
      movable: true,
      move: null,
    },
    {
      runId: merging,
      identifier: "ENG-3",
      title: "Task",
      phase: "merging",
      startedAt: now - 20_000,
      movable: true,
      move: null,
    },
  ]);
});

test("a run placed on a runner stays in its list through Closeout and leaves when it ends", async () => {
  const now = Date.now();
  const { db, work } = await fixture(now);
  const runId = await work(0, now + 60_000, { startedAt: now - 30_000, title: "Write the parser" });
  const session = {
    runId,
    identifier: "ENG-0",
    title: "Write the parser",
    phase: "working" as const,
    startedAt: now - 30_000,
    movable: true,
    move: null,
  };
  expect((await listRunnerOverview(db, "ws-1", now))[0]?.running).toEqual([session]);

  await endWork(db, runId, now);
  await seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ state: "verifying" }).where(eq(q.t.workItem.id, "item-0")),
  );
  const [held] = await listRunnerOverview(db, "ws-1", now + 120_000);
  expect(held?.running).toEqual([{ ...session, phase: "closeout", movable: false }]);
  expect(held?.slots.used).toBe(1);

  await releaseRunCapacity(db, runId, now + 130_000);
  const [after] = await listRunnerOverview(db, "ws-1", now + 130_000);
  expect(after?.running).toEqual([]);
  expect(after?.slots.used).toBe(0);
});

test("a session moving off a runner shows its move there, and not once it landed elsewhere", async () => {
  const now = Date.now();
  const { db, work } = await fixture(now);
  const runId = await work(0, now + 60_000);
  await requestRunnerSessionMove(db, {
    runId,
    runnerId: "runner-1",
    userId: "owner",
    now,
  });
  expect((await listRunnerOverview(db, "ws-1", now))[0]?.running[0]?.move).toEqual({
    status: "moving",
    reason: null,
  });
  // Handed over and waiting: the slot is held, the lease ended, and the row says why.
  await endWork(db, runId, now);
  await noteRunnerSessionMove(db, {
    runId,
    runnerId: "runner-1",
    status: "waiting",
    reason: "Every other runner is busy.",
    now,
  });
  const [waiting] = (await listRunnerOverview(db, "ws-1", now))[0]!.running;
  expect(waiting).toMatchObject({
    movable: false,
    move: { status: "waiting", reason: "Every other runner is busy." },
  });
  // It lands on runner-2: it leaves runner-1's list and shows on runner-2's with no move.
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "runner-2",
        workspaceId: "ws-1",
        ownerUserId: "user-1",
        name: "other",
        status: "active",
        createdAt: now,
        lastSeenAt: now,
      }),
    (q) =>
      q.orm
        .update(q.t.runnerWork)
        .set({ runnerId: "runner-2", endedAt: null })
        .where(eq(q.t.runnerWork.runId, runId)),
  );
  const overview = await listRunnerOverview(db, "ws-1", now);
  expect(overview.find((runner) => runner.id === "runner-1")?.running).toEqual([]);
  expect(overview.find((runner) => runner.id === "runner-2")?.running).toMatchObject([
    { runId, movable: true, move: null },
  ]);
});
