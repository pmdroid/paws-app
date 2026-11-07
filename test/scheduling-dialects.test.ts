import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  dropSchedulerAdmissionSteps,
  listSchedulerAdmissionsSteps,
  pendingRunnerWaitsSteps,
  runnerTaskSlotsSteps,
  saveItemSchedulingSteps,
  saveSchedulerAdmissionSteps,
  schedulerItemsSteps,
  schedulingProjectLeadSteps,
} from "../src/db";
import {
  forEachDialect,
  insertWorkItemSteps,
  json,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const NOW = 1_000_000;

forEachDialect((connect) => {
  async function start() {
    const handle = await connect();
    open.push(handle);
    await withoutForeignKeys(handle.db);
    return handle.db;
  }

  test("an item's scheduling keeps its project lead unless told to replace it", async () => {
    const db = await start();
    const save = (projectLeadId: string, replaceLead: number, paths: string | null) =>
      db.run((q) =>
        saveItemSchedulingSteps(q, {
          itemId: "item",
          projectId: "project",
          projectKnown: 1,
          priority: 2,
          paths,
          projectLeadId,
          replaceLead,
        }),
      );
    const lead = () => db.run((q) => schedulingProjectLeadSteps(q, "item"));

    expect(await lead()).toBeNull();
    await save("first", 0, '["src/a.ts"]');
    expect(await lead()).toBe("first");
    await save("second", 0, null);
    expect(await lead()).toBe("first");
    await save("third", 1, '["src/b.ts"]');
    expect(await lead()).toBe("third");
  });

  test("an admission is saved once, listed with its job and dropped", async () => {
    const db = await start();
    await seed(db, (q) =>
      q.orm.insert(q.t.job).values({
        id: 7,
        queue: "item.start",
        payload: json(db, { itemId: "item" }),
        runAt: 0,
        status: "running",
        lockedUntil: 500,
        createdAt: 0,
      }),
    );
    const row = { itemId: "item", jobId: 7, repositoryKey: "acme/app", sessionId: null, now: 9 };
    await db.run((q) => saveSchedulerAdmissionSteps(q, row));
    await db.run((q) => saveSchedulerAdmissionSteps(q, row, true));
    await expect(db.run((q) => saveSchedulerAdmissionSteps(q, row))).rejects.toThrow();

    expect(await db.run(listSchedulerAdmissionsSteps)).toEqual([
      {
        itemId: "item",
        jobId: 7,
        repositoryKey: "acme/app",
        sessionId: null,
        status: "running",
        lockedUntil: 500,
      },
    ]);
    await db.run((q) => dropSchedulerAdmissionSteps(q, "item"));
    expect(await db.run(listSchedulerAdmissionsSteps)).toEqual([]);
  });

  test("scheduler items carry their flags, merge position and merge time as numbers", async () => {
    const db = await start();
    await db.run(function* (q) {
      yield* insertWorkItemSteps(q, "merging", 1);
      yield* insertWorkItemSteps(q, "returned", 2);
      yield* insertWorkItemSteps(q, "done", 3);
      const { workItem } = q.t;
      yield* q.exec(
        q.orm.update(workItem).set({ state: "merge_queue" }).where(eq(workItem.id, "merging")),
      );
      yield* q.exec(
        q.orm
          .update(workItem)
          .set({ ownerUserId: "pascal", sessionKey: "session" })
          .where(eq(workItem.id, "returned")),
      );
      yield* q.exec(q.orm.update(workItem).set({ state: "merged" }).where(eq(workItem.id, "done")));
    });
    await seed(
      db,
      (q) =>
        q.orm
          .insert(q.t.mergeQueueEntry)
          .values({ itemId: "merging", repository: "acme/app", readyAt: 50 }),
      (q) =>
        q.orm.insert(q.t.workItemEvent).values([
          {
            itemId: "returned",
            version: 1,
            at: 10,
            fromState: "queued",
            toState: "merge_queue",
            event: "e",
          },
          {
            itemId: "returned",
            version: 2,
            at: 20,
            fromState: "merge_queue",
            toState: "queued",
            event: "e",
            kind: "restart",
            reason: "ci",
          },
        ]),
      (q) =>
        q.orm.insert(q.t.job).values({
          queue: "item.start",
          payload: json(db, { itemId: "returned" }),
          runAt: 0,
          status: "running",
          lockedUntil: NOW + 1,
          createdAt: 0,
        }),
      (q) =>
        q.orm
          .insert(q.t.workItemSpecification)
          .values({ itemId: "returned", hash: "h", revision: 1, present: 0 }),
      (q) =>
        q.orm
          .insert(q.t.runnerSetupHold)
          .values({ itemId: "returned", reason: "no-runner", since: 0 }),
      (q) =>
        q.orm
          .insert(q.t.linearSession)
          .values({ sessionId: "session", organizationId: "org", createdAt: 0 }),
      (q) =>
        q.orm.insert(q.t.workspace).values({
          id: "acme",
          linearOrganizationId: "org",
          name: "Acme",
          createdAt: 0,
        }),
      (q) =>
        q.orm
          .insert(q.t.workItemScheduling)
          .values({ itemId: "returned", projectKnown: 1, priority: 3 }),
      (q) =>
        q.orm
          .insert(q.t.workItemRepository)
          .values({ itemId: "returned", owner: "acme", repo: "app", remoteUrl: "u" }),
    );

    const items = await db.run((q) => schedulerItemsSteps(q, NOW));
    const byId = Object.fromEntries(items.map((item) => [item.id, item]));
    expect(Object.keys(byId).sort()).toEqual(["merging", "returned"]);
    expect(byId.merging).toEqual({
      id: "merging",
      delegationId: "delegation-merging",
      issueId: "issue-merging",
      identifier: "merging",
      position: 0,
      absent: 0,
      state: "merge_queue",
      version: 0,
      createdAt: 1,
      cancelRequested: 0,
      liveRun: 0,
      liveJob: 0,
      placed: 0,
      placing: 0,
      setupHeld: 0,
      workspaceId: null,
      sessionId: null,
      priority: null,
      owner: null,
      repo: null,
      turn: "",
      mergePosition: 1,
      mergeAt: 50,
    });
    expect(byId.returned).toMatchObject({
      absent: 1,
      liveJob: 1,
      placing: 1,
      setupHeld: 1,
      workspaceId: "acme",
      sessionId: "session",
      priority: 3,
      owner: "acme",
      repo: "app",
      turn: "user:pascal",
      mergePosition: null,
      mergeAt: 20,
    });
  });

  test("runner task slots cap capacity at desired and count work, helpers and reservations", async () => {
    const db = await start();
    const runner = (id: string, lastSeenAt: number) => ({
      id,
      workspaceId: "acme",
      ownerUserId: "owner",
      name: id,
      status: "active",
      createdAt: 0,
      lastSeenAt,
    });
    const work = (runId: string, endedAt: number | null) => ({
      runId,
      runnerId: "box",
      workspaceId: "acme",
      generation: 1,
      runnerFence: 0,
      commandId: `command-${runId}`,
      leaseUntil: NOW * 2,
      endedAt,
    });
    const run = (id: string) => ({
      id,
      itemId: `item-${id}`,
      kind: "work",
      agent: "codex",
      status: "active",
      createdAt: 0,
      updatedAt: 0,
    });
    const helper = (id: string, purpose: string | null) => ({
      id,
      runnerId: "box",
      workspaceId: "acme",
      sessionId: "session",
      sessionGeneration: 0,
      runnerFence: 0,
      envelope: json(db, {}),
      expiresAt: NOW + 1,
      purpose,
    });
    await seed(
      db,
      (q) =>
        q.orm
          .insert(q.t.runner)
          .values([runner("box", NOW), runner("idle", NOW), runner("stale", 1)]),
      (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: "box", capacity: 4, desired: 2 }),
      (q) => q.orm.insert(q.t.run).values([run("live"), run("ci"), run("reserved")]),
      (q) => q.orm.insert(q.t.runnerWork).values([work("live", null), work("ci", 1)]),
      (q) =>
        q.orm.insert(q.t.job).values({
          queue: "run.resume",
          payload: json(db, { itemId: "item-ci", awakeWait: { kind: "ci" } }),
          runAt: 0,
          status: "running",
          createdAt: 0,
        }),
      (q) =>
        q.orm
          .insert(q.t.runnerHelper)
          .values([helper("work", null), helper("talk", "conversation")]),
      (q) =>
        q.orm
          .insert(q.t.runnerReservation)
          .values({ runId: "reserved", runnerId: "box", instanceId: "i", expiresAt: NOW + 1 }),
    );

    const slots = await db.run((q) => runnerTaskSlotsSteps(q, NOW, 10));
    expect(slots.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "box", capacity: 2, used: 3 },
      { id: "idle", capacity: 1, used: 0 },
    ]);
  });

  test("a pending resume reports its latest job, pinned runner and payload text", async () => {
    const db = await start();
    await db.run(function* (q) {
      yield* insertWorkItemSteps(q, "waiting");
      yield* insertWorkItemSteps(q, "cancelled");
      const { workItem } = q.t;
      yield* q.exec(
        q.orm
          .update(workItem)
          .set({ state: "recovering", currentRunId: "run" })
          .where(eq(workItem.id, "waiting")),
      );
      yield* q.exec(
        q.orm
          .update(workItem)
          .set({ state: "recovering", cancelRequested: 1 })
          .where(eq(workItem.id, "cancelled")),
      );
    });
    const job = (id: number, itemId: string) => ({
      id,
      queue: "run.resume",
      payload: json(db, { itemId, n: id }),
      runAt: 0,
      createdAt: 0,
    });
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.job).values([job(1, "waiting"), job(2, "waiting"), job(3, "cancelled")]),
      (q) =>
        q.orm.insert(q.t.runner).values({
          id: "box",
          workspaceId: "acme",
          ownerUserId: "owner",
          name: "box",
          status: "active",
          createdAt: 0,
          lastSeenAt: NOW,
        }),
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: "run",
          runnerId: "box",
          workspaceId: "acme",
          generation: 1,
          runnerFence: 0,
          commandId: "command",
          leaseUntil: 0,
        }),
    );

    const online = await db.run((q) => pendingRunnerWaitsSteps(q, 10));
    expect(
      online.map(({ payload, ...wait }) => ({ ...wait, payload: JSON.parse(payload) })),
    ).toEqual([
      {
        itemId: "waiting",
        jobId: 2,
        runnerId: "box",
        online: 1,
        merging: 0,
        payload: { itemId: "waiting", n: 2 },
      },
    ]);
    const offline = await db.run((q) => pendingRunnerWaitsSteps(q, NOW));
    expect(offline.map(({ runnerId, online }) => ({ runnerId, online }))).toEqual([
      { runnerId: "box", online: 0 },
    ]);
  });
});
