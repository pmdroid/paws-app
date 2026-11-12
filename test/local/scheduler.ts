import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { count as rows, eq, like, sql, type SQL } from "drizzle-orm";
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
  openPawsStore,
  openPostgres,
  postgresDb,
  recordLinearInstallation,
  syncSteps,
  type Db,
  type PgDb,
  type Q,
} from "../../src/db";
import { JOB_KIND, type WorkItemState } from "../../src/core";
import { intakeDelegatedIssue, readyItemsSteps, syncItemDependencies } from "../../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../../src/linear";
import {
  createAdmission,
  dispatch,
  registerScheduler,
  saveSchedulingContextSteps,
} from "../../src/scheduler";
import { joinFakeWorkspacePg, workspaceAdmission, workspaceDispatchPg } from "../fake-workspace";
import { pgliteServer, tempStore } from "../pglite";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv[2] === "--contender") {
  const root = process.argv[3]!,
    contender = process.argv[4]!;
  try {
    const url = readFileSync(join(root, "database-url"), "utf8");
    const pg = openPostgres(url);
    const db = postgresDb(pg);
    writeFileSync(join(root, `ready-${contender}`), "");
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(root, "go"))) {
      if (Date.now() > deadline) throw new Error("Scheduler contender gate timed out");
      await pause(5);
    }
    const admitted = await dispatch(db, { now: 1000, admission: createAdmission({ db }) });
    writeFileSync(join(root, `result-${contender}.json`), JSON.stringify(admitted));
    await pg.$client.close();
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
  const onlyStarts = (db: Db, only: string) => {
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
  const fill = async (
    db: Db,
    name: string,
    count: number,
    paths: (index: number) => string[] = (index) => [`src/task-${index}`],
  ) => {
    const ids = Array.from({ length: count }, (_, index) => `${name}-${index}`);
    for (const [index, id] of ids.entries()) {
      await insertQueuedItem(db, { id, now: index });
      await bindWorkItemRepository(db, id, repository);
      await db.run((q) =>
        saveSchedulingContextSteps(q, { itemId: id, projectId: "project", paths: paths(index) }),
      );
    }
    return ids;
  };
  const setup = async (name: string, count: number, paths?: (index: number) => string[]) => {
    const { db, close } = await tempStore();
    return { db, close, ids: await fill(db, name, count, paths) };
  };
  const count = (db: Db, table: "job" | "schedulerAdmission") =>
    db.run(function* (q) {
      const [row] = yield* q.all(q.orm.select({ n: rows() }).from(q.t[table]));
      return row!.n;
    });
  const jobStatus = (db: Db) =>
    db.run(function* (q) {
      return (yield* q.one(q.orm.select({ status: q.t.job.status }).from(q.t.job)))!.status;
    });
  const setState = (db: Db, id: string, state: WorkItemState) =>
    db.run((q) => q.exec(q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, id))));
  const insertWorkspace = (db: Db) =>
    db.run((q) =>
      q.exec(
        q.orm.insert(q.t.workspace).values({
          id: "workspace",
          linearOrganizationId: "org",
          name: "Workspace",
          createdAt: 1000,
        }),
      ),
    );
  const execute = (db: Db, query: SQL) => (db as PgDb).orm.execute(query);
  const failedWith = (pattern: RegExp) => (error: unknown) => {
    assert.match(`${String(error)} ${String((error as Error).cause)}`, pattern);
    return true;
  };
  {
    const directory = join(root, "competing");
    mkdirSync(directory, { recursive: true });
    const server = await pgliteServer(process.env, { maxConnections: 32 });
    const db = server.store;
    const ids = await fill(db, "competing", 20);
    for (const id of ids) await joinFakeWorkspacePg(db, `epic-${id}`);
    writeFileSync(join(directory, "database-url"), server.url);
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
      assert.equal(await count(db, "schedulerAdmission"), 20);
      assert.equal(await count(db, "job"), 20);
      observed("Twenty processes atomically admit every ready item once", {
        admissions: await count(db, "schedulerAdmission"),
        jobs: await count(db, "job"),
      });
      const first = (await claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] }))!;
      assert(first);
      await applyWorkItemEvent(db, (first.payload as { itemId: string }).itemId, "dispatched");
      const { store: secondDb, close: closeSecond } = await openPawsStore({
        url: server.url,
        pgliteDir: "",
      });
      const second = (await claimNextJob(secondDb, {
        now: 1000,
        queues: [JOB_KIND.start],
      }))!;
      assert(second);
      assert.notEqual(second.id, first.id);
      const firstId = (first.payload as { itemId: string }).itemId;
      const resume = await enqueueJob(db, {
        queue: JOB_KIND.resume,
        payload: { itemId: firstId },
        now: 1000,
      });
      assert.equal(await claimNextJob(secondDb, { now: 1000, queues: [JOB_KIND.resume] }), null);
      observed("Reserved jobs claim concurrently but the same item cannot resume twice", {
        first: first.id,
        second: second.id,
        resume,
      });
      await closeSecond();
      const { store: reopened, close: closeReopened } = await openPawsStore({
        url: server.url,
        pgliteDir: "",
      });
      assert.deepEqual(await workspaceDispatchPg(reopened, { now: 1001 }), []);
      assert.equal(await count(reopened, "schedulerAdmission"), 20);
      observed("Restart retains queued or active reservations", {
        admissions: await count(reopened, "schedulerAdmission"),
      });
      await closeReopened();
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
      await server.close();
    }
  }
  for (const [name, paths] of [
    ["overlap", (index: number) => [index ? "src/shared/file.ts" : "src/shared/**"]],
    ["hot", (index: number) => [index ? "packages/other/package.json" : "bun.lock"]],
    ["unknown", () => []],
  ] as const) {
    const { db, ids, close } = await setup(name, 2, paths);
    assert.equal((await workspaceDispatchPg(db, { now: 1000 })).length, 2);
    const first = (await claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] }))!;
    const second = (await claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] }))!;
    assert.notEqual(first.id, second.id);
    const id = (first.payload as { itemId: string }).itemId;
    await setState(db, id, "merged");
    assert(await completeJob(db, first, 1001));
    assert.equal((await workspaceDispatchPg(db, { now: 1001 })).length, 0);
    observed(`${name} footprints execute independently in separate task workspaces`, { ids });
    await close();
  }
  {
    for (const glob of ["src*", "package*.json", "ab*"]) {
      const { db, close } = await setup(`root-glob-${glob.replaceAll("*", "")}`, 2, (index) => [
        index ? glob.replace("*", "concrete") : glob,
      ]);
      assert.equal((await workspaceDispatchPg(db, { now: 1000 })).length, 2);
      await close();
    }
    observed("Root-segment globs do not serialize private task workspaces", {
      globs: ["src*", "package*.json", "ab*"],
    });
  }
  {
    const { db, ids, close } = await setup("claimed-retraction", 2, () => ["src/shared"]);
    assert.deepEqual(await workspaceDispatchPg(db, { now: 1000 }), ids);
    const claimed = (await claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] }))!;
    const first = (claimed.payload as { itemId: string }).itemId;
    const canDispatchDelegation = (delegationId: string) => delegationId !== `epic-${first}`;
    assert.deepEqual(
      await dispatch(db, {
        now: 1001,
        admission: workspaceAdmission(db, { authority: canDispatchDelegation }),
      }),
      [],
    );
    assert.equal((await getJob(db, claimed.id))!.status, "running");
    assert.equal((await getJob(db, claimed.id))!.lockedBy, claimed.lockedBy);
    assert.equal(await count(db, "schedulerAdmission"), 2);
    assert(await completeJob(db, claimed, 1002));
    assert.deepEqual(
      await dispatch(db, {
        now: 1002,
        admission: workspaceAdmission(db, { authority: canDispatchDelegation }),
      }),
      [],
    );
    assert.equal(await count(db, "schedulerAdmission"), 1);
    observed("A claimed start retains its locks until the actual job holder releases", {
      claimed: claimed.id,
    });
    await close();
  }
  {
    for (const running of [false, true]) {
      const { db, ids, close } = await setup(`stale-start-${running}`, 1);
      await workspaceDispatchPg(db, { now: 1000 });
      if (running)
        assert(await claimNextJob(db, { now: 1000, leaseMs: 10, queues: [JOB_KIND.start] }));
      await setState(db, ids[0]!, "failed");
      await workspaceDispatchPg(db, { now: 1011 });
      assert.equal(await count(db, "schedulerAdmission"), 0);
      await setState(db, ids[0]!, "queued");
      assert.equal(await claimNextJob(db, { now: 1011, queues: [JOB_KIND.start] }), null);
      assert.equal(await jobStatus(db), "cancelled");
      await close();
    }
    observed("Removing admissions cancels pending and expired starts before a later restart", {
      pending: true,
      expired: true,
    });
  }
  {
    const { db, ids, close } = await setup("idle-merge", 2, () => ["src/shared"]);
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.workItem)
          .set({ delegationId: `epic-${ids[0]!}` })
          .where(eq(q.t.workItem.id, ids[1]!)),
      ),
    );
    await recordLinearInstallation(db, {
      organizationId: "merge-org",
      oauthClientId: "merge-client",
      appUserId: "app",
      sessionId: "merge-session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(db, "merge-session", `epic-${ids[0]!}`, {
      actorId: "owner",
    });
    const firstOnly = { now: 1000, admission: onlyStarts(db, ids[0]!) };
    assert.deepEqual(await dispatch(db, firstOnly), [ids[0]!]);
    const start = (await claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] }))!;
    await setState(db, ids[0]!, "merge_queue");
    assert.deepEqual(await dispatch(db, firstOnly), []);
    assert(await completeJob(db, start, 1001));
    const mergeId = await enqueueJob(db, {
      queue: `${JOB_KIND.merge}.deferred`,
      payload: { itemId: ids[0]! },
      now: 1001,
    });
    const merge = (await claimNextJob(db, {
      now: 1001,
      queues: [`${JOB_KIND.merge}.deferred`],
    }))!;
    assert.equal(merge.id, mergeId);
    assert.deepEqual(await workspaceDispatchPg(db, { now: 1002 }), [ids[1]!]);
    assert.equal(await count(db, "schedulerAdmission"), 2);
    assert(await completeJob(db, merge, 1003));
    assert.deepEqual(await workspaceDispatchPg(db, { now: 1003 }), []);
    const blocker = (await claimNextJob(db, { now: 1003, queues: [JOB_KIND.start] }))!;
    assert.equal((blocker.payload as { itemId: string }).itemId, ids[1]!);
    observed("A live merge admits a same-session sibling with an overlapping footprint", {
      originalStart: start.id,
      joinedMerge: merge.id,
      blockerStart: blocker.id,
    });
    await close();
  }
  {
    for (const status of ["active", "provisioning"] as const) {
      const { db, ids, close } = await setup(`merge-run-${status}`, 2, () => ["src/shared"]);
      assert.deepEqual(await dispatch(db, { now: 1000, admission: onlyStarts(db, ids[0]!) }), [
        ids[0]!,
      ]);
      const start = (await claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] }))!;
      assert(await completeJob(db, start, 1001));
      await setState(db, ids[0]!, "merge_queue");
      const run = await insertRun(db, { itemId: ids[0]!, now: 1001, status });
      assert.deepEqual(await workspaceDispatchPg(db, { now: 1002 }), [ids[1]!]);
      await db.run((q) =>
        q.exec(q.orm.update(q.t.run).set({ status: "ended" }).where(eq(q.t.run.id, run.id))),
      );
      assert.deepEqual(await workspaceDispatchPg(db, { now: 1003 }), []);
      await close();
    }
    observed("Active or provisioning runs do not block another ready item", {
      statuses: ["active", "provisioning"],
    });
  }
  {
    const { db, ids, close } = await setup("waiting-independent", 3, () => []);
    await setState(db, ids[0]!, "awaiting_input");
    assert.deepEqual(await workspaceDispatchPg(db, { now: 1000 }), ids.slice(1));
    observed("A waiting task without live work releases capacity for two independent tasks", {
      ids,
    });
    await close();
  }
  {
    const { db, ids, close } = await setup("duplicate-issue", 2, () => []);
    await assert.rejects(
      db.run((q) =>
        q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ linearIssueId: `lin-item-${ids[0]!}` })
            .where(eq(q.t.workItem.id, ids[1]!)),
        ),
      ),
      failedWith(/duplicate key value violates unique constraint/),
    );
    observed("Separate sessions cannot execute the same Linear issue concurrently", { ids });
    await close();
  }
  {
    const { db, close } = await setup("rollback", 2);
    await execute(
      db,
      sql`CREATE FUNCTION fail_admission() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected crash'; END $$ LANGUAGE plpgsql`,
    );
    await execute(
      db,
      sql`CREATE TRIGGER fail_admission BEFORE INSERT ON scheduler_admission FOR EACH ROW EXECUTE FUNCTION fail_admission()`,
    );
    await assert.rejects(workspaceDispatchPg(db, { now: 1000 }), failedWith(/injected crash/));
    assert.equal(await count(db, "job"), 0);
    assert.equal(await count(db, "schedulerAdmission"), 0);
    observed("Failure after job insertion rolls back the whole dispatch", {
      jobs: await count(db, "job"),
      admissions: await count(db, "schedulerAdmission"),
    });
    await close();
  }
  {
    const { db, ids, close } = await setup("priority", 4);
    const issue = (id: string) => `lin-item-${id}`;
    const epic = (id: string) => `epic-${id}`;
    await db.run(function* (q) {
      yield* q.exec(
        q.orm
          .update(q.t.workItem)
          .set({ delegationId: epic(ids[0]!) })
          .where(like(q.t.workItem.id, "priority-%")),
      );
      yield* q.exec(
        q.orm
          .insert(q.t.taskBlock)
          .values({ blockerLinearIssueId: issue(ids[2]!), blockedLinearIssueId: issue(ids[3]!) }),
      );
    });
    const admitted = await workspaceDispatchPg(db, { now: 1000 });
    assert.deepEqual(admitted, [ids[2], ids[0], ids[1]]);
    observed("Critical path wins before age with deterministic ties", { admitted });
    await close();
  }
  {
    const { db, close } = await setup("authoritative", 0);
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
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      now: 1000,
    });
    assert(intake.ok);
    await insertWorkspace(db);
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(db, "session", intake.delegation.id, {
      actorId: "owner",
    });
    const ids = intake.items.map((item) => item.id);
    assert.deepEqual(await dispatch(db, { now: 1000 }), []);
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
        expectedGeneration: (
          await db.run((q) => readyItemsSteps(q, { itemId: item.id, workspaceId: "workspace" }))
        ).generation,
        tracker,
        lifecycle,
      });
    assert.deepEqual(await dispatch(db, { now: 1001 }), [intake.items[0]!.id]);
    await db.run((q) => q.exec(q.orm.update(q.t.itemDependencySnapshot).set({ scope: [] })));
    assert.deepEqual(await dispatch(db, { now: 1002 }), []);
    assert.equal(await count(db, "schedulerAdmission"), 0);
    assert.equal(await jobStatus(db), "cancelled");
    observed(
      "Workspace dispatch requires an authoritative snapshot and retracts stale queued jobs",
      { ids },
    );
    await close();
  }
  {
    const { db, close } = await setup("sessions", 0);
    await insertWorkspace(db);
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
      const intake = await intakeDelegatedIssue(db, tracker, {
        linearIssueId: parent,
        now: 1000,
      });
      assert(intake.ok);
      const sessionId = `session-${parent}`;
      await recordLinearInstallation(db, {
        organizationId: "org",
        oauthClientId: "client",
        appUserId: "app",
        sessionId,
        teamId: "team",
        observedAtMs: 1000,
      });
      await bindLinearSessionTask(db, sessionId, intake.delegation.id, {
        actorId: "owner",
      });
      sessions.set(
        sessionId,
        intake.items.map((item) => item.id),
      );
      for (const item of intake.items)
        await db.run((q) =>
          saveSchedulingContextSteps(q, {
            itemId: item.id,
            projectId: "same-project",
            paths: [`src/${item.linearIssueId}`],
          }),
        );
      for (const item of intake.items)
        await syncItemDependencies(db, {
          itemId: item.id,
          workspaceId: "workspace",
          expectedGeneration: (
            await db.run((q) => readyItemsSteps(q, { itemId: item.id, workspaceId: "workspace" }))
          ).generation,
          tracker,
          lifecycle,
        });
    }
    const admitted = await dispatch(db, { now: 1000, defaultRepository: repository });
    assert.equal(admitted.length, 4);
    for (const [sessionId, ids] of sessions) {
      const selected = ids.filter((id) => admitted.includes(id));
      assert.equal(selected.length, ids.length);
      await activateLinearItem(db, sessionId, selected[0]!);
      await applyWorkItemEvent(db, selected[0]!, "dispatched");
      await assert.rejects(
        activateLinearItem(db, sessionId, selected[1]!),
        /Previous Linear task is still active/,
      );
    }
    observed("Two canonical sessions admit every ready item and each activates one", {
      admitted,
      sessions: [...sessions],
    });
    await close();
  }
  {
    const { db, close } = await setup("effects", 2);
    assert.deepEqual(
      await dispatch(db, {
        now: 1000,
        admission: workspaceAdmission(db, { authority: () => false }),
      }),
      [],
    );
    assert.equal(await count(db, "job"), 0);
    assert.equal((await workspaceDispatchPg(db, { now: 1001 })).length, 2);
    assert.deepEqual(
      await dispatch(db, {
        now: 1002,
        admission: workspaceAdmission(db, { authority: () => false }),
      }),
      [],
    );
    assert.equal(await count(db, "schedulerAdmission"), 0);
    observed("Pending reconciliation effects prevent and retract queued admissions", {
      jobs: await count(db, "job"),
    });
    await close();
  }
  {
    const { db, ids, close } = await setup("unknown-project", 3);
    for (const id of ids)
      await db.run((q) => saveSchedulingContextSteps(q, { itemId: id, paths: ["src/a"] }));
    await db.run((q) =>
      q.exec(
        q.orm.update(q.t.workItemRepository).set({ repo: sql`${q.t.workItemRepository.itemId}` }),
      ),
    );
    assert.equal((await workspaceDispatchPg(db, { now: 1000 })).length, 3);
    observed("Unknown project identity does not cap ready items across repositories", {
      admissions: await count(db, "schedulerAdmission"),
    });
    await close();
  }
  {
    const { db, ids, close } = await setup("draining", 2);
    await workspaceDispatchPg(db, { now: 1000 });
    await insertRun(db, { itemId: ids[0]!, now: 1000, status: "active" });
    const claimed = await claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] });
    assert(claimed);
    assert.equal((claimed.payload as { itemId: string }).itemId, ids[1]);
    assert.equal(await claimNextJob(db, { now: 1000, queues: [JOB_KIND.start] }), null);
    observed("Queued restart cannot claim while its previous run is still draining", {
      claimed: claimed.id,
    });
    await close();
  }
  {
    const { db, close } = await setup("tick", 1);
    let now = 1000;
    const loop = new JobLoop(db, { now: () => now, mono: () => now });
    await registerScheduler(
      loop,
      async () => {
        await workspaceDispatchPg(db, { now });
      },
      now,
    );
    const first = await loop.tick();
    assert(first);
    assert.equal((await getJob(db, first.id))!.runAt, 31_000);
    assert.equal((await getJob(db, first.id))!.fireCount, 1);
    now = 30_999;
    assert.equal(await loop.tick(), null);
    now = 31_000;
    assert.equal((await loop.tick())!.id, first.id);
    assert.equal(await count(db, "schedulerAdmission"), 1);
    assert.equal((await getJob(db, first.id))!.fireCount, 2);
    observed("A durable thirty-second scheduler tick recurs without duplicate starts", {
      tick: await getJob(db, first.id),
    });
    await close();
  }
  {
    const { db, close } = await setup("workers", 2);
    await workspaceDispatchPg(db, { now: 1000 });
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
    await close();
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
