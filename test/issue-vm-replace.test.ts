import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  discardStaleAgentSessionsSteps,
  insertRunSteps,
  moveIssueVmSteps,
  saveIssueVmSpendSettingsSteps,
  type Db,
  type IssueVm,
  type IssueVmProvider,
} from "../src/db";
import {
  createFakeIssueVmDriver,
  createIssueVmLifecycle,
  createIssueVmReplacer,
  recordIssueVmSteps,
  type FakeIssueVmDriver,
} from "../src/issue-vm";
import {
  describePglite,
  insertWorkItem,
  withoutForeignKeys,
  type PgliteTestDb,
} from "./pglite-fixtures";

const NOW = Date.UTC(2026, 10, 10);

const opened: PgliteTestDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

type World = { db: Db; driver: FakeIssueVmDriver; t: { now: number }; provider: IssueVmProvider };

async function world(connect: () => Promise<PgliteTestDb>, provider: IssueVmProvider) {
  const handle = await connect();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  await insertWorkItem(handle.db, "item-1", NOW);
  return { db: handle.db, driver: createFakeIssueVmDriver(), t: { now: NOW }, provider };
}

const options = (w: World) => ({
  drivers: { [w.provider]: w.driver },
  now: () => (w.t.now += 1),
});

async function failedVm(w: World) {
  const id = await w.db.run((q) =>
    recordIssueVmSteps(q, {
      workspaceId: "acme",
      itemId: "item-1",
      memberUserId: "ada",
      provider: w.provider,
      now: w.t.now,
    }),
  );
  await createIssueVmLifecycle(w.db, options(w)).sweep();
  const vm = (await rows(w.db))[0]!;
  expect(vm).toMatchObject({ id, state: "awake" });
  const set = { state: "failed" as const, failure: "The VM did not wake before its deadline" };
  await w.db.run((q) => moveIssueVmSteps(q, { id, generation: vm.generation, set, now: w.t.now }));
  return id;
}

async function rows(db: Db): Promise<IssueVm[]> {
  const found = await db.run((q) =>
    q.all(q.orm.select().from(q.t.issueVm).orderBy(q.t.issueVm.createdAt, q.t.issueVm.id)),
  );
  return found as IssueVm[];
}

async function savedSession(db: Db) {
  return db.run(function* (q) {
    const run = yield* insertRunSteps(q, { itemId: "item-1", now: NOW, agent: "claude" });
    yield* q.exec(
      q.orm.update(q.t.workItem).set({ currentRunId: run.id }).where(eq(q.t.workItem.id, "item-1")),
    );
    yield* q.exec(
      q.orm.insert(q.t.agentSessionSnapshot).values({
        runId: run.id,
        generation: 3,
        itemId: "item-1",
        workspaceId: "acme",
        runnerId: "runner-old",
        ownerUserId: "ada",
        agent: "claude",
        agentVersion: "2.1.0",
        sessionId: "session-1",
        workspacePath: "/work",
        commitSha: "abc123",
        turn: 2,
        sizeBytes: 10,
        sealedSize: 10,
        sha256: "f".repeat(64),
        status: "sealed",
        createdAt: NOW,
        sealedAt: NOW,
      }),
    );
    return run.id;
  });
}

function spendLimit(db: Db, monthlyLimitUsd: number) {
  return db.run((q) =>
    saveIssueVmSpendSettingsSteps(q, {
      workspaceId: "acme",
      changes: { monthlyLimitUsd, boatHourlyUsd: 0.5 },
      defaultLimitUsd: 50,
      updatedBy: "admin",
      now: NOW,
    }),
  );
}

describePglite((connect) => {
  test("a failed record is replaced through admission, keeps its session, and the old VM is deleted", async () => {
    const w = await world(connect, "host");
    const runId = await savedSession(w.db);
    const old = await failedVm(w);

    const [result] = await createIssueVmReplacer(w.db, options(w)).sweep();
    const [before, replacement] = await rows(w.db);
    expect(result).toEqual({
      failed: old,
      outcome: "replaced",
      vm: replacement!.id,
      session: { runId, generation: 3, sessionId: "session-1" },
      oldDeleted: true,
    });
    expect(before).toMatchObject({ id: old, state: "failed" });
    expect(before!.deletedAt).not.toBeNull();
    expect(replacement).toMatchObject({
      itemId: "item-1",
      memberUserId: "ada",
      state: "creating",
      generation: 0,
      failure: null,
      runnerId: null,
    });
    expect(w.driver.vms.has(old)).toBe(false);
    expect(w.driver.calls.slice(-2).map((call) => [call.op, call.name])).toEqual([
      ["reconcile", old],
      ["delete", old],
    ]);

    await createIssueVmLifecycle(w.db, options(w)).sweep();
    expect((await rows(w.db))[1]).toMatchObject({ state: "awake" });
    await w.db.transaction(discardStaleAgentSessionsSteps);
    const [snapshot] = await w.db.run((q) => q.all(q.orm.select().from(q.t.agentSessionSnapshot)));
    expect(snapshot).toMatchObject({ runId, generation: 3, status: "sealed" });

    expect(await createIssueVmReplacer(w.db, options(w)).sweep()).toEqual([]);
  });

  test("an over-budget replacement waits with the admission reason, then goes ahead", async () => {
    const w = await world(connect, "boat");
    await spendLimit(w.db, 50);
    const old = await failedVm(w);
    await spendLimit(w.db, 0);

    const replacer = createIssueVmReplacer(w.db, options(w));
    expect(await replacer.sweep()).toEqual([
      {
        failed: old,
        outcome: "waiting",
        refusal: {
          ok: false,
          reason: "spend_limit",
          spentUsd: expect.any(Number),
          limitUsd: 0,
          message: expect.stringContaining("Monthly issue VM spend limit reached"),
        },
        oldDeleted: true,
      },
    ]);
    expect(await rows(w.db)).toHaveLength(1);
    expect((await rows(w.db))[0]!.deletedAt).toBeNull();
    expect(w.driver.vms.has(old)).toBe(false);

    await spendLimit(w.db, 50);
    expect(await replacer.sweep()).toMatchObject([{ failed: old, outcome: "replaced" }]);
    expect(await rows(w.db)).toHaveLength(2);
    expect(w.driver.calls.filter((call) => call.op === "delete")).toHaveLength(1);
  });

  test("an item that ended gets no replacement, and its failed VM is still deleted", async () => {
    const w = await world(connect, "host");
    const old = await failedVm(w);
    await w.db.run((q) =>
      q.exec(
        q.orm.update(q.t.workItem).set({ state: "merged" }).where(eq(q.t.workItem.id, "item-1")),
      ),
    );
    expect(await createIssueVmReplacer(w.db, options(w)).sweep()).toEqual([
      { failed: old, outcome: "not_needed", oldDeleted: true },
    ]);
    expect(await rows(w.db)).toHaveLength(1);
    expect(w.driver.vms.has(old)).toBe(false);
  });
});
