import assert from "node:assert/strict";
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
  sqliteDb,
  syncSteps,
  type Q,
} from "../../src/db";
import { JOB_KIND } from "../../src/core";
import { intakeDelegatedIssue, readyItemsSteps, syncItemDependencies } from "../../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../../src/linear";
import {
  createAdmission,
  dispatch,
  registerScheduler,
  saveSchedulingContextSteps,
} from "../../src/scheduler";
import { joinFakeWorkspace, workspaceAdmission, workspaceDispatch } from "../fake-workspace";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv[2] === "--contender") {
  const root = process.argv[3]!,
    contender = process.argv[4]!;
  try {
    // Warm the dispatch on a private copy so the contended write lock runs compiled code.
    const scratch = join(root, `scratch-${contender}.sqlite`);
    copyFileSync(join(root, "template.sqlite"), scratch);
    const warm = openDatabase(scratch);
    await dispatch(sqliteDb(warm), {
      now: 1000,
      admission: createAdmission({ db: sqliteDb(warm) }),
    });
    warm.close();
    const db = openDatabase(join(root, "paws.sqlite"));
    writeFileSync(join(root, `ready-${contender}`), "");
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(root, "go"))) {
      if (Date.now() > deadline) throw new Error("Scheduler contender gate timed out");
      await pause(5);
    }
    // The parent joined the fake workspace, so the write lock covers only the product dispatch.
    const admitted = await dispatch(sqliteDb(db), {
      now: 1000,
      admission: createAdmission({ db: sqliteDb(db) }),
    });
    writeFileSync(join(root, `result-${contender}.json`), JSON.stringify(admitted));
    db.close();
  } catch (error) {
    process.stderr.write(`Scheduler contender ${contender} failed: ${Bun.inspect(error)}\n`);
    process.exitCode = 1;
  }
}

export function spawnContender(directory: string, contender: number) {
  return Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      import.meta.filename,
      "--contender",
      directory,
      `${contender}`,
    ],
    {
      env: { PATH: process.env["PATH"], HOME: directory, TMPDIR: directory },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

/** Waits for a contender and fails with its exit code, signal, stderr and stdout. */
export async function contenderExited(child: ReturnType<typeof spawnContender>): Promise<void> {
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(
    exit,
    0,
    `Scheduler contender exited ${exit} (signal ${child.signalCode ?? "none"})\n` +
      `stderr: ${stderr || "(empty)"}\nstdout: ${stdout || "(empty)"}`,
  );
}

export async function probeScheduler(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observed = (name: string, value: unknown) => observe(name, true, value);
  const onlyStarts = (db: Database, only: string) => {
    const admission = workspaceAdmission(db);
    const decide = (itemId: string) =>
      itemId === only ? ({ ok: true } as const) : ({ ok: false, held: "blocked" } as const);
    return {
      ...admission,
      canStart: async (itemId: string) => decide(itemId),
      steps: {
        ...admission.steps,
        canStart: (_q: Q, itemId: string) => syncSteps(() => decide(itemId)),
      },
    };
  };
  const setup = async (
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
      await insertQueuedItem(db, { id, now: index });
      await bindWorkItemRepository(sqliteDb(db), id, repository);
      await sqliteDb(db).run((q) =>
        saveSchedulingContextSteps(q, { itemId: id, projectId: "project", paths: paths(index) }),
      );
    }
    return { directory, db, ids };
  };
  const count = (db: ReturnType<typeof openDatabase>, table: string) =>
    (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  {
    const { directory, db, ids } = await setup("competing", 20);
    for (const id of ids) await joinFakeWorkspace(db, `epic-${id}`);
    db.run("VACUUM INTO ?", [join(directory, "template.sqlite")]);
    const children = Array.from({ length: 20 }, (_, index) => spawnContender(directory, index));
    try {
      const deadline = Date.now() + 15_000;
      while (readdirSync(directory).filter((name) => name.startsWith("ready-")).length !== 20) {
        const exited = children.find((child) => child.exitCode !== null);
        if (exited) await contenderExited(exited);
        if (Date.now() > deadline) throw new Error("Contenders did not become ready");
        await pause(5);
      }
      writeFileSync(join(directory, "go"), "");
      await Promise.all(children.map(contenderExited));
      assert.equal(count(db, "scheduler_admission"), 20);
      assert.equal(count(db, "job"), 20);
      observed("Twenty processes atomically admit every ready item once", {
        admissions: count(db, "scheduler_admission"),
        jobs: count(db, "job"),
      });
      const first = (await claimNextJob(sqliteDb(db), { now: 1000, queues: [JOB_KIND.start] }))!;
      assert(first);
      await applyWorkItemEvent(
        sqliteDb(db),
        (first.payload as { itemId: string }).itemId,
        "dispatched",
      );
      const secondDb = openDatabase(join(directory, "paws.sqlite"));
      const second = (await claimNextJob(sqliteDb(secondDb), {
        now: 1000,
        queues: [JOB_KIND.start],
      }))!;
      assert(second);
      assert.notEqual(second.id, first.id);
      const firstId = (first.payload as { itemId: string }).itemId;
      const resume = await enqueueJob(sqliteDb(db), {
        queue: JOB_KIND.resume,
        payload: { itemId: firstId },
        now: 1000,
      });
      assert.equal(
        await claimNextJob(sqliteDb(secondDb), { now: 1000, queues: [JOB_KIND.resume] }),
        null,
      );
      observed("Reserved jobs claim concurrently but the same item cannot resume twice", {
        first: first.id,
        second: second.id,
        resume,
      });
      secondDb.close();
      db.close();
      const reopened = openDatabase(join(directory, "paws.sqlite"));
      assert.deepEqual(await workspaceDispatch(reopened, { now: 1001 }), []);
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
    const { db, ids } = await setup(name, 2, paths);
    assert.equal((await workspaceDispatch(db, { now: 1000 })).length, 2);
    const first = (await claimNextJob(sqliteDb(db), { now: 1000, queues: [JOB_KIND.start] }))!;
    const second = (await claimNextJob(sqliteDb(db), { now: 1000, queues: [JOB_KIND.start] }))!;
    assert.notEqual(first.id, second.id);
    const id = (first.payload as { itemId: string }).itemId;
    db.run("UPDATE work_item SET state='merged' WHERE id=?", [id]);
    assert(await completeJob(sqliteDb(db), first, 1001));
    assert.equal((await workspaceDispatch(db, { now: 1001 })).length, 0);
    observed(`${name} footprints execute independently in separate task workspaces`, { ids });
    db.close();
  }
  {
    for (const glob of ["src*", "package*.json", "ab*"]) {
      const { db } = await setup(`root-glob-${glob.replaceAll("*", "")}`, 2, (index) => [
        index ? glob.replace("*", "concrete") : glob,
      ]);
      assert.equal((await workspaceDispatch(db, { now: 1000 })).length, 2);
      db.close();
    }
    observed("Root-segment globs do not serialize private task workspaces", {
      globs: ["src*", "package*.json", "ab*"],
    });
  }
  {
    const { db, ids } = await setup("claimed-retraction", 2, () => ["src/shared"]);
    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ids);
    const claimed = (await claimNextJob(sqliteDb(db), { now: 1000, queues: [JOB_KIND.start] }))!;
    const first = (claimed.payload as { itemId: string }).itemId;
    const canDispatchDelegation = (delegationId: string) => delegationId !== `epic-${first}`;
    assert.deepEqual(
      await dispatch(sqliteDb(db), {
        now: 1001,
        admission: workspaceAdmission(db, { authority: canDispatchDelegation }),
      }),
      [],
    );
    assert.equal((await getJob(sqliteDb(db), claimed.id))!.status, "running");
    assert.equal((await getJob(sqliteDb(db), claimed.id))!.lockedBy, claimed.lockedBy);
    assert.equal(count(db, "scheduler_admission"), 2);
    assert(await completeJob(sqliteDb(db), claimed, 1002));
    assert.deepEqual(
      await dispatch(sqliteDb(db), {
        now: 1002,
        admission: workspaceAdmission(db, { authority: canDispatchDelegation }),
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
      const { db, ids } = await setup(`stale-start-${running}`, 1);
      await workspaceDispatch(db, { now: 1000 });
      if (running)
        assert(
          await claimNextJob(sqliteDb(db), { now: 1000, leaseMs: 10, queues: [JOB_KIND.start] }),
        );
      db.run("UPDATE work_item SET state='failed' WHERE id=?", [ids[0]!]);
      await workspaceDispatch(db, { now: 1011 });
      assert.equal(count(db, "scheduler_admission"), 0);
      db.run("UPDATE work_item SET state='queued' WHERE id=?", [ids[0]!]);
      assert.equal(await claimNextJob(sqliteDb(db), { now: 1011, queues: [JOB_KIND.start] }), null);
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
    const { db, ids } = await setup("idle-merge", 2, () => ["src/shared"]);
    db.run("UPDATE work_item SET delegation_id=? WHERE id=?", [`epic-${ids[0]!}`, ids[1]!]);
    await recordLinearInstallation(sqliteDb(db), {
      organizationId: "merge-org",
      oauthClientId: "merge-client",
      appUserId: "app",
      sessionId: "merge-session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(sqliteDb(db), "merge-session", `epic-${ids[0]!}`, {
      actorId: "owner",
    });
    const firstOnly = { now: 1000, admission: onlyStarts(db, ids[0]!) };
    assert.deepEqual(await dispatch(sqliteDb(db), firstOnly), [ids[0]!]);
    const start = (await claimNextJob(sqliteDb(db), { now: 1000, queues: [JOB_KIND.start] }))!;
    db.run("UPDATE work_item SET state='merge_queue' WHERE id=?", [ids[0]!]);
    assert.deepEqual(await dispatch(sqliteDb(db), firstOnly), []);
    assert(await completeJob(sqliteDb(db), start, 1001));
    const mergeId = await enqueueJob(sqliteDb(db), {
      queue: `${JOB_KIND.merge}.deferred`,
      payload: { itemId: ids[0]! },
      now: 1001,
    });
    const merge = (await claimNextJob(sqliteDb(db), {
      now: 1001,
      queues: [`${JOB_KIND.merge}.deferred`],
    }))!;
    assert.equal(merge.id, mergeId);
    assert.deepEqual(await workspaceDispatch(db, { now: 1002 }), [ids[1]!]);
    assert.equal(count(db, "scheduler_admission"), 2);
    assert(await completeJob(sqliteDb(db), merge, 1003));
    assert.deepEqual(await workspaceDispatch(db, { now: 1003 }), []);
    const blocker = (await claimNextJob(sqliteDb(db), { now: 1003, queues: [JOB_KIND.start] }))!;
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
      const { db, ids } = await setup(`merge-run-${status}`, 2, () => ["src/shared"]);
      assert.deepEqual(
        await dispatch(sqliteDb(db), { now: 1000, admission: onlyStarts(db, ids[0]!) }),
        [ids[0]!],
      );
      const start = (await claimNextJob(sqliteDb(db), { now: 1000, queues: [JOB_KIND.start] }))!;
      assert(await completeJob(sqliteDb(db), start, 1001));
      db.run("UPDATE work_item SET state='merge_queue' WHERE id=?", [ids[0]!]);
      const run = await insertRun(sqliteDb(db), { itemId: ids[0]!, now: 1001, status });
      assert.deepEqual(await workspaceDispatch(db, { now: 1002 }), [ids[1]!]);
      db.run("UPDATE run SET status='ended' WHERE id=?", [run.id]);
      assert.deepEqual(await workspaceDispatch(db, { now: 1003 }), []);
      db.close();
    }
    observed("Active or provisioning runs do not block another ready item", {
      statuses: ["active", "provisioning"],
    });
  }
  {
    const { db, ids } = await setup("waiting-independent", 3, () => []);
    db.run("UPDATE work_item SET state='awaiting_input' WHERE id=?", [ids[0]!]);
    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ids.slice(1));
    observed("A waiting task without live work releases capacity for two independent tasks", {
      ids,
    });
    db.close();
  }
  {
    const { db, ids } = await setup("duplicate-issue", 2, () => []);
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
    const { db } = await setup("rollback", 2);
    db.run(
      "CREATE TRIGGER fail_admission BEFORE INSERT ON scheduler_admission BEGIN SELECT RAISE(ABORT,'injected crash'); END",
    );
    await assert.rejects(workspaceDispatch(db, { now: 1000 }), /injected crash/);
    assert.equal(count(db, "job"), 0);
    assert.equal(count(db, "scheduler_admission"), 0);
    observed("Failure after job insertion rolls back the whole dispatch", {
      jobs: count(db, "job"),
      admissions: count(db, "scheduler_admission"),
    });
    db.close();
  }
  {
    const { db, ids } = await setup("priority", 4);
    const issue = (id: string) => `lin-item-${id}`;
    const epic = (id: string) => `epic-${id}`;
    db.run("UPDATE work_item SET delegation_id=? WHERE id LIKE 'priority-%'", [epic(ids[0]!)]);
    db.run("INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?)", [
      issue(ids[2]!),
      issue(ids[3]!),
    ]);
    const admitted = await workspaceDispatch(db, { now: 1000 });
    assert.deepEqual(admitted, [ids[2], ids[0], ids[1]]);
    observed("Critical path wins before age with deterministic ties", { admitted });
    db.close();
  }
  {
    const { db } = await setup("authoritative", 0);
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
    const intake = await intakeDelegatedIssue(sqliteDb(db), tracker, {
      linearIssueId: "parent",
      now: 1000,
    });
    assert(intake.ok);
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    await recordLinearInstallation(sqliteDb(db), {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(sqliteDb(db), "session", intake.delegation.id, {
      actorId: "owner",
    });
    const ids = intake.items.map((item) => item.id);
    assert.deepEqual(await dispatch(sqliteDb(db), { now: 1000 }), []);
    const lifecycle = createFakeLinearIssueLifecycle({
      id: "a",
      teamId: "team",
      stateType: "started",
      assigneeId: null,
      delegateId: null,
    });
    for (const item of intake.items)
      await syncItemDependencies(sqliteDb(db), {
        itemId: item.id,
        workspaceId: "workspace",
        expectedGeneration: (
          await sqliteDb(db).run((q) =>
            readyItemsSteps(q, { itemId: item.id, workspaceId: "workspace" }),
          )
        ).generation,
        tracker,
        lifecycle,
      });
    assert.deepEqual(await dispatch(sqliteDb(db), { now: 1001 }), [intake.items[0]!.id]);
    db.run("UPDATE item_dependency_snapshot SET scope='[]'");
    assert.deepEqual(await dispatch(sqliteDb(db), { now: 1002 }), []);
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
    const { db } = await setup("sessions", 0);
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
      const intake = await intakeDelegatedIssue(sqliteDb(db), tracker, {
        linearIssueId: parent,
        now: 1000,
      });
      assert(intake.ok);
      const sessionId = `session-${parent}`;
      await recordLinearInstallation(sqliteDb(db), {
        organizationId: "org",
        oauthClientId: "client",
        appUserId: "app",
        sessionId,
        teamId: "team",
        observedAtMs: 1000,
      });
      await bindLinearSessionTask(sqliteDb(db), sessionId, intake.delegation.id, {
        actorId: "owner",
      });
      sessions.set(
        sessionId,
        intake.items.map((item) => item.id),
      );
      for (const item of intake.items)
        await sqliteDb(db).run((q) =>
          saveSchedulingContextSteps(q, {
            itemId: item.id,
            projectId: "same-project",
            paths: [`src/${item.linearIssueId}`],
          }),
        );
      for (const item of intake.items)
        await syncItemDependencies(sqliteDb(db), {
          itemId: item.id,
          workspaceId: "workspace",
          expectedGeneration: (
            await sqliteDb(db).run((q) =>
              readyItemsSteps(q, { itemId: item.id, workspaceId: "workspace" }),
            )
          ).generation,
          tracker,
          lifecycle,
        });
    }
    const admitted = await dispatch(sqliteDb(db), { now: 1000, defaultRepository: repository });
    assert.equal(admitted.length, 4);
    for (const [sessionId, ids] of sessions) {
      const selected = ids.filter((id) => admitted.includes(id));
      assert.equal(selected.length, ids.length);
      await activateLinearItem(sqliteDb(db), sessionId, selected[0]!);
      await applyWorkItemEvent(sqliteDb(db), selected[0]!, "dispatched");
      await assert.rejects(
        activateLinearItem(sqliteDb(db), sessionId, selected[1]!),
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
    const { db } = await setup("effects", 2);
    assert.deepEqual(
      await dispatch(sqliteDb(db), {
        now: 1000,
        admission: workspaceAdmission(db, { authority: () => false }),
      }),
      [],
    );
    assert.equal(count(db, "job"), 0);
    assert.equal((await workspaceDispatch(db, { now: 1001 })).length, 2);
    assert.deepEqual(
      await dispatch(sqliteDb(db), {
        now: 1002,
        admission: workspaceAdmission(db, { authority: () => false }),
      }),
      [],
    );
    assert.equal(count(db, "scheduler_admission"), 0);
    observed("Pending reconciliation effects prevent and retract queued admissions", {
      jobs: count(db, "job"),
    });
    db.close();
  }
  {
    const { db, ids } = await setup("unknown-project", 3);
    for (const id of ids)
      await sqliteDb(db).run((q) =>
        saveSchedulingContextSteps(q, { itemId: id, paths: ["src/a"] }),
      );
    db.run("UPDATE work_item_repository SET repo=item_id");
    assert.equal((await workspaceDispatch(db, { now: 1000 })).length, 3);
    observed("Unknown project identity does not cap ready items across repositories", {
      admissions: count(db, "scheduler_admission"),
    });
    db.close();
  }
  {
    const { db, ids } = await setup("draining", 2);
    await workspaceDispatch(db, { now: 1000 });
    await insertRun(sqliteDb(db), { itemId: ids[0]!, now: 1000, status: "active" });
    const claimed = await claimNextJob(sqliteDb(db), { now: 1000, queues: [JOB_KIND.start] });
    assert(claimed);
    assert.equal((claimed.payload as { itemId: string }).itemId, ids[1]);
    assert.equal(await claimNextJob(sqliteDb(db), { now: 1000, queues: [JOB_KIND.start] }), null);
    observed("Queued restart cannot claim while its previous run is still draining", {
      claimed: claimed.id,
    });
    db.close();
  }
  {
    const { db } = await setup("tick", 1);
    let now = 1000;
    const loop = new JobLoop(db, { now: () => now, mono: () => now });
    await registerScheduler(
      loop,
      async () => {
        await workspaceDispatch(db, { now });
      },
      now,
    );
    const first = await loop.tick();
    assert(first);
    assert.equal((await getJob(sqliteDb(db), first.id))!.runAt, 31_000);
    assert.equal((await getJob(sqliteDb(db), first.id))!.fireCount, 1);
    now = 30_999;
    assert.equal(await loop.tick(), null);
    now = 31_000;
    assert.equal((await loop.tick())!.id, first.id);
    assert.equal(count(db, "scheduler_admission"), 1);
    assert.equal((await getJob(sqliteDb(db), first.id))!.fireCount, 2);
    observed("A durable thirty-second scheduler tick recurs without duplicate starts", {
      tick: await getJob(sqliteDb(db), first.id),
    });
    db.close();
  }
  {
    const { db } = await setup("workers", 2);
    await workspaceDispatch(db, { now: 1000 });
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
