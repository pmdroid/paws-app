import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyWorkItemEvent,
  activateLinearItem,
  bindLinearSessionTask,
  bindWorkItemRepository,
  insertRun,
  claimNextJob,
  completeJob,
  enqueueJob,
  getJob,
  insertQueuedItem,
  JobLoop,
  migrate,
  openDatabase,
  recordLinearInstallation,
} from "../../src/db";
import { JOB_KIND } from "../../src/core";
import { intakeDelegatedIssue, readyItems, syncItemDependencies } from "../../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../../src/linear";
import { dispatchReadyItems, registerScheduler, saveSchedulingContext } from "../../src/scheduler";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv[2] === "--contender") {
  const root = process.argv[3]!,
    contender = process.argv[4]!;
  const db = openDatabase(join(root, "paws.sqlite"));
  writeFileSync(join(root, `ready-${contender}`), "");
  const deadline = Date.now() + 15_000;
  while (!existsSync(join(root, "go"))) {
    if (Date.now() > deadline) throw new Error("Scheduler contender gate timed out");
    await pause(5);
  }
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM work_item")
    .all()
    .map((item) => item.id);
  const admitted = dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids });
  writeFileSync(join(root, `result-${contender}.json`), JSON.stringify(admitted));
  db.close();
}

export async function probeScheduler(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observed = (name: string, value: unknown) => observe(name, true, value);
  const setup = (
    name: string,
    count: number,
    paths: (index: number) => string[] = (index) => [`src/task-${index}`],
  ) => {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    const db = openDatabase(join(directory, "paws.sqlite"));
    migrate(db);
    const ids = Array.from({ length: count }, (_, index) => `${name}-${index}`);
    for (const [index, id] of ids.entries()) {
      insertQueuedItem(db, { id, now: index });
      bindWorkItemRepository(db, id, repository);
      saveSchedulingContext(db, { itemId: id, projectId: "project", paths: paths(index) });
    }
    return { directory, db, ids };
  };
  const count = (db: ReturnType<typeof openDatabase>, table: string) =>
    (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  {
    const { directory, db, ids } = setup("competing", 20);
    const children = Array.from({ length: 20 }, (_, index) =>
      Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          import.meta.filename,
          "--contender",
          directory,
          String(index),
        ],
        {
          env: { PATH: process.env["PATH"], HOME: directory, TMPDIR: directory },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    try {
      const deadline = Date.now() + 15_000;
      while (readdirSync(directory).filter((name) => name.startsWith("ready-")).length !== 20) {
        if (Date.now() > deadline) throw new Error("Contenders did not become ready");
        await pause(5);
      }
      writeFileSync(join(directory, "go"), "");
      for (const child of children) {
        const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        assert.equal(exit, 0, error);
      }
      assert.equal(count(db, "scheduler_admission"), 20);
      assert.equal(count(db, "job"), 20);
      observed("Twenty processes atomically admit every ready item once", {
        admissions: count(db, "scheduler_admission"),
        jobs: count(db, "job"),
      });
      const first = claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] })!;
      assert(first);
      applyWorkItemEvent(db, (first.payload as { itemId: string }).itemId, "dispatched");
      const secondDb = openDatabase(join(directory, "paws.sqlite"));
      const second = claimNextJob(secondDb, { now: 1000, queues: [JOB_KIND.start] })!;
      assert(second);
      assert.notEqual(second.id, first.id);
      const firstId = (first.payload as { itemId: string }).itemId;
      const resume = enqueueJob(db, {
        queue: JOB_KIND.resume,
        payload: { itemId: firstId },
        now: 1000,
      });
      assert.equal(claimNextJob(secondDb, { now: 1000, queues: [JOB_KIND.resume] }), null);
      observed("Reserved jobs claim concurrently but the same item cannot resume twice", {
        first: first.id,
        second: second.id,
        resume,
      });
      secondDb.close();
      db.close();
      const reopened = openDatabase(join(directory, "paws.sqlite"));
      assert.deepEqual(dispatchReadyItems(reopened, { now: 1001, legacyReadyItemIds: ids }), []);
      assert.equal(count(reopened, "scheduler_admission"), 20);
      observed("Restart retains queued or active reservations", {
        admissions: count(reopened, "scheduler_admission"),
      });
      reopened.close();
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
    }
  }
  for (const [name, paths] of [
    ["overlap", (index: number) => [index ? "src/shared/file.ts" : "src/shared/**"]],
    ["hot", (index: number) => [index ? "packages/other/package.json" : "bun.lock"]],
    ["unknown", () => []],
  ] as const) {
    const { db, ids } = setup(name, 2, paths);
    assert.equal(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids }).length, 2);
    const first = claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] })!;
    const second = claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] })!;
    assert.notEqual(first.id, second.id);
    const id = (first.payload as { itemId: string }).itemId;
    db.run("UPDATE work_item SET state='merged' WHERE id=?", [id]);
    assert(completeJob(db, first, 1001));
    assert.equal(dispatchReadyItems(db, { now: 1001, legacyReadyItemIds: ids }).length, 0);
    observed(`${name} footprints execute independently in separate task workspaces`, { ids });
    db.close();
  }
  {
    for (const glob of ["src*", "package*.json", "ab*"]) {
      const { db, ids } = setup(`root-glob-${glob.replaceAll("*", "")}`, 2, (index) => [
        index ? glob.replace("*", "concrete") : glob,
      ]);
      assert.equal(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids }).length, 2);
      db.close();
    }
    observed("Root-segment globs do not serialize private task workspaces", {
      globs: ["src*", "package*.json", "ab*"],
    });
  }
  {
    const { db, ids } = setup("claimed-retraction", 2, () => ["src/shared"]);
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids }), ids);
    const claimed = claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] })!;
    const first = (claimed.payload as { itemId: string }).itemId;
    const canDispatchEpic = (epicId: string) => epicId !== `epic-${first}`;
    assert.deepEqual(
      dispatchReadyItems(db, {
        now: 1001,
        legacyReadyItemIds: ids,
        canDispatchEpic,
      }),
      [],
    );
    assert.equal(getJob(db, claimed.id)!.status, "running");
    assert.equal(getJob(db, claimed.id)!.lockedBy, claimed.lockedBy);
    assert.equal(count(db, "scheduler_admission"), 2);
    assert(completeJob(db, claimed, 1002));
    assert.deepEqual(
      dispatchReadyItems(db, {
        now: 1002,
        legacyReadyItemIds: ids,
        canDispatchEpic,
      }),
      [],
    );
    assert.equal(count(db, "scheduler_admission"), 1);
    observed("A claimed start retains its locks until the actual job holder releases", {
      claimed: claimed.id,
    });
    db.close();
  }
  {
    for (const running of [false, true]) {
      const { db, ids } = setup(`stale-start-${running}`, 1);
      dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids });
      if (running) assert(claimNextJob(db, { now: 1000, leaseMs: 10, queues: [JOB_KIND.start] }));
      db.run("UPDATE work_item SET state='failed' WHERE id=?", [ids[0]!]);
      dispatchReadyItems(db, { now: 1011 });
      assert.equal(count(db, "scheduler_admission"), 0);
      db.run("UPDATE work_item SET state='queued' WHERE id=?", [ids[0]!]);
      assert.equal(claimNextJob(db, { now: 1011, queues: [JOB_KIND.start] }), null);
      assert.equal(
        db.query<{ status: string }, []>("SELECT status FROM job").get()!.status,
        "cancelled",
      );
      db.close();
    }
    observed("Removing admissions cancels pending and expired starts before a later restart", {
      pending: true,
      expired: true,
    });
  }
  {
    const { db, ids } = setup("idle-merge", 2, () => ["src/shared"]);
    db.run("UPDATE work_item SET delegation_id=? WHERE id=?", [`epic-${ids[0]!}`, ids[1]!]);
    recordLinearInstallation(db, {
      organizationId: "merge-org",
      oauthClientId: "merge-client",
      appUserId: "app",
      sessionId: "merge-session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "merge-session", `epic-${ids[0]!}`, { actorId: "owner" });
    const firstOnly = { now: 1000, legacyReadyItemIds: [ids[0]!] };
    assert.deepEqual(dispatchReadyItems(db, firstOnly), [ids[0]!]);
    const start = claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] })!;
    db.run("UPDATE work_item SET state='merge_queue' WHERE id=?", [ids[0]!]);
    assert.deepEqual(dispatchReadyItems(db, firstOnly), []);
    assert(completeJob(db, start, 1001));
    const mergeId = enqueueJob(db, {
      queue: `${JOB_KIND.merge}.deferred`,
      lane: "merge",
      payload: { itemId: ids[0]! },
      now: 1001,
    });
    const merge = claimNextJob(db, { now: 1001, queues: [`${JOB_KIND.merge}.deferred`] })!;
    assert.equal(merge.id, mergeId);
    assert.deepEqual(dispatchReadyItems(db, { now: 1002, legacyReadyItemIds: ids }), [ids[1]!]);
    assert.equal(count(db, "scheduler_admission"), 2);
    assert(completeJob(db, merge, 1003));
    assert.deepEqual(dispatchReadyItems(db, { now: 1003, legacyReadyItemIds: ids }), []);
    const blocker = claimNextJob(db, { now: 1003, queues: [JOB_KIND.start] })!;
    assert.equal((blocker.payload as { itemId: string }).itemId, ids[1]!);
    observed("A live merge admits a same-session sibling with an overlapping footprint", {
      originalStart: start.id,
      joinedMerge: merge.id,
      blockerStart: blocker.id,
    });
    db.close();
  }
  {
    for (const status of ["active", "provisioning"] as const) {
      const { db, ids } = setup(`merge-run-${status}`, 2, () => ["src/shared"]);
      assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: [ids[0]!] }), [
        ids[0]!,
      ]);
      const start = claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] })!;
      assert(completeJob(db, start, 1001));
      db.run("UPDATE work_item SET state='merge_queue' WHERE id=?", [ids[0]!]);
      const run = insertRun(db, { itemId: ids[0]!, now: 1001, status });
      assert.deepEqual(dispatchReadyItems(db, { now: 1002, legacyReadyItemIds: ids }), [ids[1]!]);
      db.run("UPDATE run SET status='ended' WHERE id=?", [run.id]);
      assert.deepEqual(dispatchReadyItems(db, { now: 1003, legacyReadyItemIds: ids }), []);
      db.close();
    }
    observed("Active or provisioning runs do not block another ready item", {
      statuses: ["active", "provisioning"],
    });
  }
  {
    const { db, ids } = setup("waiting-independent", 3, () => []);
    db.run("UPDATE work_item SET state='awaiting_input' WHERE id=?", [ids[0]!]);
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids }), ids.slice(1));
    observed("A waiting task without live work releases capacity for two independent tasks", {
      ids,
    });
    db.close();
  }
  {
    const { db, ids } = setup("duplicate-issue", 2, () => []);
    assert.throws(
      () =>
        db.run("UPDATE work_item SET linear_issue_id=? WHERE id=?", [
          `lin-item-${ids[0]!}`,
          ids[1]!,
        ]),
      /UNIQUE/,
    );
    observed("Separate sessions cannot execute the same Linear issue concurrently", { ids });
    db.close();
  }
  {
    const { db, ids } = setup("rollback", 2);
    db.run(
      "CREATE TRIGGER fail_admission BEFORE INSERT ON scheduler_admission BEGIN SELECT RAISE(ABORT,'injected crash'); END",
    );
    assert.throws(
      () => dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids }),
      /injected crash/,
    );
    assert.equal(count(db, "job"), 0);
    assert.equal(count(db, "scheduler_admission"), 0);
    observed("Failure after job insertion rolls back the whole dispatch", {
      jobs: count(db, "job"),
      admissions: count(db, "scheduler_admission"),
    });
    db.close();
  }
  {
    const { db, ids } = setup("priority", 4);
    const issue = (id: string) => `lin-item-${id}`;
    const epic = (id: string) => `epic-${id}`;
    db.run("UPDATE work_item SET delegation_id=? WHERE id LIKE 'priority-%'", [epic(ids[0]!)]);
    db.run("INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?)", [
      issue(ids[2]!),
      issue(ids[3]!),
    ]);
    const admitted = dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids.slice(0, 3) });
    assert.deepEqual(admitted, [ids[2], ids[0], ids[1]]);
    observed("Critical path wins before age with deterministic ties", { admitted });
    db.close();
  }
  {
    const { db } = setup("authoritative", 0);
    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "SCH-1",
        title: "Parent",
        description: null,
        subIssues: ["a", "b"].map((id) => ({ linearIssueId: id, identifier: id, title: id })),
      },
    ]);
    tracker.deps.set("parent", [{ blockerLinearIssueId: "a", blockedLinearIssueId: "b" }]);
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
    assert(intake.ok);
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.epic.id, { actorId: "owner" });
    const ids = intake.items.map((item) => item.id);
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids }), []);
    const lifecycle = createFakeLinearIssueLifecycle({
      id: "a",
      teamId: "team",
      stateType: "started",
      assigneeId: null,
      delegateId: null,
    });
    for (const item of intake.items)
      await syncItemDependencies(db, {
        itemId: item.id,
        workspaceId: "workspace",
        expectedGeneration: readyItems(db, { itemId: item.id, workspaceId: "workspace" })
          .generation,
        tracker,
        lifecycle,
      });
    assert.deepEqual(dispatchReadyItems(db, { now: 1001, legacyReadyItemIds: ids }), [
      intake.items[0]!.id,
    ]);
    db.run("UPDATE item_dependency_snapshot SET scope='[]'");
    assert.deepEqual(dispatchReadyItems(db, { now: 1002, legacyReadyItemIds: ids }), []);
    assert.equal(count(db, "scheduler_admission"), 0);
    assert.equal(
      db.query<{ status: string }, []>("SELECT status FROM job").get()!.status,
      "cancelled",
    );
    observed(
      "Workspace dispatch requires an authoritative snapshot and retracts stale queued jobs",
      { ids },
    );
    db.close();
  }
  {
    const { db } = setup("sessions", 0);
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    const tracker = createFakeTracker(
      ["one", "two"].map((parent) => ({
        linearIssueId: parent,
        identifier: parent,
        title: parent,
        description: null,
        subIssues: ["a", "b"].map((child) => ({
          linearIssueId: `${parent}-${child}`,
          identifier: `${parent}-${child}`,
          title: child,
        })),
      })),
    );
    const lifecycle = createFakeLinearIssueLifecycle({
      id: "unused",
      teamId: "team",
      stateType: "started",
      assigneeId: null,
      delegateId: null,
    });
    const sessions = new Map<string, string[]>();
    for (const parent of ["one", "two"]) {
      const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: parent, now: 1000 });
      assert(intake.ok);
      const sessionId = `session-${parent}`;
      recordLinearInstallation(db, {
        organizationId: "org",
        oauthClientId: "client",
        appUserId: "app",
        sessionId,
        teamId: "team",
        observedAtMs: 1000,
      });
      bindLinearSessionTask(db, sessionId, intake.epic.id, { actorId: "owner" });
      sessions.set(
        sessionId,
        intake.items.map((item) => item.id),
      );
      for (const item of intake.items)
        saveSchedulingContext(db, {
          itemId: item.id,
          projectId: "same-project",
          paths: [`src/${item.linearIssueId}`],
        });
      for (const item of intake.items)
        await syncItemDependencies(db, {
          itemId: item.id,
          workspaceId: "workspace",
          expectedGeneration: readyItems(db, { itemId: item.id, workspaceId: "workspace" })
            .generation,
          tracker,
          lifecycle,
        });
    }
    const admitted = dispatchReadyItems(db, { now: 1000, defaultRepository: repository });
    assert.equal(admitted.length, 4);
    for (const [sessionId, ids] of sessions) {
      const selected = ids.filter((id) => admitted.includes(id));
      assert.equal(selected.length, ids.length);
      activateLinearItem(db, sessionId, selected[0]!);
      applyWorkItemEvent(db, selected[0]!, "dispatched");
      assert.throws(
        () => activateLinearItem(db, sessionId, selected[1]!),
        /Previous Linear task is still active/,
      );
    }
    observed("Two canonical sessions admit every ready item and each activates one", {
      admitted,
      sessions: [...sessions],
    });
    db.close();
  }
  {
    const { db, ids } = setup("effects", 2);
    assert.deepEqual(
      dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids, canDispatchEpic: () => false }),
      [],
    );
    assert.equal(count(db, "job"), 0);
    assert.equal(dispatchReadyItems(db, { now: 1001, legacyReadyItemIds: ids }).length, 2);
    assert.deepEqual(
      dispatchReadyItems(db, { now: 1002, legacyReadyItemIds: ids, canDispatchEpic: () => false }),
      [],
    );
    assert.equal(count(db, "scheduler_admission"), 0);
    observed("Pending reconciliation effects prevent and retract queued admissions", {
      jobs: count(db, "job"),
    });
    db.close();
  }
  {
    const { db, ids } = setup("unknown-project", 3);
    for (const id of ids) saveSchedulingContext(db, { itemId: id, paths: ["src/a"] });
    db.run("UPDATE work_item_repository SET repo=item_id");
    assert.equal(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids }).length, 3);
    observed("Unknown project identity does not cap ready items across repositories", {
      admissions: count(db, "scheduler_admission"),
    });
    db.close();
  }
  {
    const { db, ids } = setup("draining", 2);
    dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids });
    insertRun(db, { itemId: ids[0]!, now: 1000, status: "active" });
    const claimed = claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] });
    assert(claimed);
    assert.equal((claimed.payload as { itemId: string }).itemId, ids[1]);
    assert.equal(claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] }), null);
    observed("Queued restart cannot claim while its previous run is still draining", {
      claimed: claimed.id,
    });
    db.close();
  }
  {
    const { db, ids } = setup("tick", 1);
    let now = 1000;
    const loop = new JobLoop(db, { now: () => now, mono: () => now });
    registerScheduler(loop, () => ({ now, legacyReadyItemIds: ids }));
    const first = await loop.tick();
    assert(first);
    assert.equal(getJob(db, first.id)!.runAt, 31_000);
    assert.equal(getJob(db, first.id)!.fireCount, 1);
    now = 30_999;
    assert.equal(await loop.tick(), null);
    now = 31_000;
    assert.equal((await loop.tick())!.id, first.id);
    assert.equal(count(db, "scheduler_admission"), 1);
    assert.equal(getJob(db, first.id)!.fireCount, 2);
    observed("A durable thirty-second scheduler tick recurs without duplicate starts", {
      tick: getJob(db, first.id),
    });
    db.close();
  }
  {
    const { db, ids } = setup("workers", 2);
    dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids });
    const controller = new AbortController();
    const entered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const loop = new JobLoop(
      db,
      { now: () => 1000, mono: () => 1000 },
      { concurrency: 2, pollMs: 1 },
    );
    loop.register(JOB_KIND.start, async (job) => {
      entered.push((job.payload as { itemId: string }).itemId);
      await gate;
      controller.abort();
    });
    const running = loop.run(controller.signal);
    const deadline = Date.now() + 1000;
    try {
      while (entered.length < 2 && Date.now() < deadline) await pause(1);
      assert.equal(entered.length, 2);
    } finally {
      controller.abort();
      release();
      await running;
    }
    observed("Opted-in production job workers execute both reserved handlers together", {
      entered,
    });
    db.close();
  }
}

if (import.meta.main && process.argv[2] !== "--contender") {
  const root = process.argv[2];
  if (!root) throw new Error("A disposable proof directory is required");
  const observations: unknown[] = [];
  await probeScheduler(root, (name, passed, observed) => {
    observations.push({ name, passed, observed });
  });
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(JSON.stringify({ root, passed: observations.length }));
}
