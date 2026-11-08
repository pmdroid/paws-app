import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  chargeRunnerAgentSteps,
  delegationProjectLeadIdsSteps,
  finishRunnerExecutionUsageSteps,
  insertRunnerExecutionUsageSteps,
  lastSuccessfulImplementationSteps,
  linearSessionInstallationSteps,
  quotaRecheckAtSteps,
  runnerAgentQuotaSteps,
  runnerExecutionHistorySteps,
  runnerExecutionReceiptSteps,
  runnerPlacementPolicySteps,
  setRunnerAgentCooldownSteps,
  settleRunnerAgentSteps,
  type Db,
  type RunnerAgentSettlement,
  type RunnerExecutionStart,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function start(db: Db, commandId: string, fields: Partial<RunnerExecutionStart> = {}) {
  return db.run((q) =>
    insertRunnerExecutionUsageSteps(q, {
      commandId,
      runnerId: "box",
      ownerUserId: "owner",
      itemId: "item",
      runId: "run",
      agent: "codex",
      model: "requested",
      role: "implementer",
      purpose: "work",
      startedAt: 10,
      placementReason: null,
      ...fields,
    }),
  );
}

function finish(
  db: Db,
  commandId: string,
  endedAt: number,
  outcome = "success",
  resolvedModel: string | null = null,
) {
  return db.run((q) =>
    finishRunnerExecutionUsageSteps(q, {
      commandId,
      endedAt,
      outcome,
      resolvedModel,
      outputBytes: 7,
      resetsAt: null,
    }),
  );
}

function seedPolicy(db: Db, fields: Record<string, number | string | null> = {}) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: "box", agent: "codex", ...fields }),
  );
}

function readPolicy(db: Db) {
  return db.run(function* (q) {
    const { runnerAgentPolicy: p } = q.t;
    return (yield* q.one(q.orm.select().from(p).where(eq(p.runnerId, "box"))))!;
  });
}

const settlement = (fields: Partial<RunnerAgentSettlement>): RunnerAgentSettlement => ({
  runnerId: "box",
  agent: "codex",
  authRequired: false,
  success: false,
  quota: null,
  clearQuota: false,
  model: null,
  ...fields,
});

const settle = (db: Db, fields: Partial<RunnerAgentSettlement>) =>
  db.run((q) => settleRunnerAgentSteps(q, settlement(fields)));

forEachDialect((connect) => {
  test("the placement policy is every fact an admission depends on", async () => {
    const db = await connected(connect);
    expect(await db.run((q) => runnerPlacementPolicySteps(q, "box", "codex"))).toEqual({
      runner: null,
      host: null,
      capacity: null,
      agent: null,
      membership: null,
      teams: [],
    });
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id: "box",
          workspaceId: "acme",
          ownerUserId: "owner",
          name: "box",
          status: "active",
          fence: 3,
          createdAt: 0,
        }),
      (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId: "box", sharing: 1 }),
      (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: "box", capacity: 2, ceiling: 4 }),
      (q) =>
        q.orm.insert(q.t.workspaceMember).values({
          workspaceId: "acme",
          userId: "owner",
          role: "member",
          source: "linear",
          active: 1,
          checkedAt: 5,
        }),
      (q) =>
        q.orm.insert(q.t.workspaceUserTeam).values([
          { workspaceId: "acme", userId: "owner", teamId: "t2" },
          { workspaceId: "acme", userId: "owner", teamId: "t1" },
          { workspaceId: "acme", userId: "someone-else", teamId: "t3" },
        ]),
    );
    await seedPolicy(db, { virtualFinish: 2, lastUsedAt: 9 });

    const policy = await db.run((q) => runnerPlacementPolicySteps(q, "box", "codex"));
    expect(policy.runner).toEqual({
      id: "box",
      workspaceId: "acme",
      ownerUserId: "owner",
      status: "active",
      fence: 3,
      revokedAt: null,
    });
    expect(policy.host).toEqual({ runnerId: "box", sharing: 1 });
    expect(policy.capacity).toEqual({ capacity: 2, ceiling: 4, desired: null });
    expect(policy.agent).toMatchObject({ virtualFinish: 2, lastUsedAt: 9, quotaState: "ok" });
    expect(policy.membership).toMatchObject({ userId: "owner", role: "member", active: 1 });
    expect(policy.teams.map((team) => team.teamId)).toEqual(["t1", "t2"]);
    const hostOnly = await db.run((q) => runnerPlacementPolicySteps(q, "box"));
    expect(hostOnly.agent).toBeNull();
  });

  test("execution history keeps what ended inside the window on that runner", async () => {
    const db = await connected(connect);
    await start(db, "before");
    await start(db, "inside");
    await start(db, "edge");
    await start(db, "unfinished");
    await start(db, "other", { runnerId: "other-box" });
    await finish(db, "before", 100);
    await finish(db, "inside", 150);
    await finish(db, "edge", 200);
    await finish(db, "other", 150);
    const history = await db.run((q) => runnerExecutionHistorySteps(q, "box", 100, 200));
    expect(history.map((row) => row.endedAt).sort()).toEqual([150, 200]);
    expect(history[0]!.startedAt).toBe(10);
  });

  test("the last implementation is the newest successful implementer turn", async () => {
    const db = await connected(connect);
    expect(await db.run((q) => lastSuccessfulImplementationSteps(q, "item"))).toBeNull();
    await start(db, "c1");
    await start(db, "c2", { runnerId: "newest-box" });
    await start(db, "failed");
    await start(db, "review", { role: "reviewer" });
    await start(db, "prepare", { purpose: "prepare" });
    await finish(db, "c1", 50, "success", "older");
    await finish(db, "c2", 50, "success", "newer");
    await finish(db, "failed", 90, "error", "failed");
    await finish(db, "review", 90, "success", "review");
    await finish(db, "prepare", 90, "success", "prepare");
    expect(await db.run((q) => lastSuccessfulImplementationSteps(q, "item"))).toEqual({
      runnerId: "newest-box",
      model: "newer",
    });
  });

  test("a receipt is bound to its runner and shows the recorded finish", async () => {
    const db = await connected(connect);
    await start(db, "c1", { itemId: null, placementReason: "extra_usage" });
    expect(await db.run((q) => runnerExecutionReceiptSteps(q, "c1", "other-box"))).toBeNull();
    expect(await db.run((q) => runnerExecutionReceiptSteps(q, "c1", "box"))).toEqual({
      ownerId: "owner",
      purpose: "work",
      agent: "codex",
      itemId: null,
      role: "implementer",
      startedAt: 10,
      endedAt: null,
      outcome: null,
      resetsAt: null,
    });
    await finish(db, "c1", 40, "quota_exhausted");
    expect(await db.run((q) => runnerExecutionReceiptSteps(q, "c1", "box"))).toMatchObject({
      endedAt: 40,
      outcome: "quota_exhausted",
    });
    const stored = await db.run(function* (q) {
      const { runnerExecutionUsage: u } = q.t;
      return (yield* q.one(q.orm.select().from(u).where(eq(u.commandId, "c1"))))!;
    });
    expect(stored).toMatchObject({ outputBytes: 7, placementReason: "extra_usage" });
  });

  test("charging an agent creates its row and weighs a low quota five times", async () => {
    const db = await connected(connect);
    expect(await db.run((q) => runnerAgentQuotaSteps(q, "box", "codex"))).toBeNull();
    await db.run((q) => chargeRunnerAgentSteps(q, { runnerId: "box", agent: "codex", at: 11 }));
    expect(await readPolicy(db)).toMatchObject({ virtualFinish: 1, lastUsedAt: 11 });
    await db.run(function* (q) {
      const { runnerAgentPolicy: p } = q.t;
      yield* q.exec(q.orm.update(p).set({ quotaState: "low" }).where(eq(p.runnerId, "box")));
    });
    await db.run((q) => chargeRunnerAgentSteps(q, { runnerId: "box", agent: "codex", at: 22 }));
    expect(await readPolicy(db)).toMatchObject({ virtualFinish: 6, lastUsedAt: 22 });
    expect(await db.run((q) => runnerAgentQuotaSteps(q, "box", "codex"))).toEqual({
      cooldownUntil: 0,
      quotaState: "low",
    });
  });

  test("a turn that shows nothing leaves the agent as it was", async () => {
    const db = await connected(connect);
    await seedPolicy(db, {
      ready: 1,
      authExpired: 1,
      quotaState: "low",
      resetsAt: 80,
      cooldownUntil: 90,
      resolvedModel: "kept",
    });
    await settle(db, {});
    expect(await readPolicy(db)).toMatchObject({
      ready: 1,
      authExpired: 1,
      quotaState: "low",
      resetsAt: 80,
      cooldownUntil: 90,
      resolvedModel: "kept",
    });
  });

  test("a sign-in failure marks the agent signed out", async () => {
    const db = await connected(connect);
    await seedPolicy(db, { ready: 1 });
    await settle(db, { authRequired: true, success: true });
    expect(await readPolicy(db)).toMatchObject({ ready: 0, authExpired: 1 });
  });

  test("a success clears a quota limit only when the turn may clear it", async () => {
    const db = await connected(connect);
    await seedPolicy(db, {
      authExpired: 1,
      quotaState: "exhausted",
      resetsAt: 80,
      cooldownUntil: 90,
    });
    await settle(db, { success: true, model: "resolved" });
    expect(await readPolicy(db)).toMatchObject({
      ready: 1,
      authExpired: 0,
      quotaState: "exhausted",
      resetsAt: 80,
      cooldownUntil: 90,
      resolvedModel: "resolved",
    });
    await settle(db, { success: true, clearQuota: true });
    expect(await readPolicy(db)).toMatchObject({
      quotaState: "ok",
      resetsAt: null,
      cooldownUntil: 0,
      resolvedModel: "resolved",
    });
  });

  test("a quota signal wins over clearing, and a cooldown can be set after it", async () => {
    const db = await connected(connect);
    await seedPolicy(db);
    await settle(db, {
      clearQuota: true,
      quota: { state: "exhausted", resetsAt: null, cooldownUntil: 70 },
    });
    expect(await readPolicy(db)).toMatchObject({
      quotaState: "exhausted",
      resetsAt: null,
      cooldownUntil: 70,
    });
    await db.run((q) => setRunnerAgentCooldownSteps(q, "box", "codex", 120));
    expect(await readPolicy(db)).toMatchObject({ cooldownUntil: 120 });
  });

  test("project leads are distinct people across the delegation", async () => {
    const db = await connected(connect);
    const item = (id: string, delegationId: string) => ({
      id,
      delegationId,
      linearIssueId: `issue-${id}`,
      linearIdentifier: id,
      title: id,
      state: "queued",
      branchName: `paws/${id}`,
      position: 0,
      createdAt: 0,
    });
    const scheduled = (itemId: string, projectLeadId: string) => ({
      itemId,
      projectKnown: 1,
      projectLeadId,
    });
    await seed(
      db,
      (q) =>
        q.orm
          .insert(q.t.workItem)
          .values([item("a", "d"), item("b", "d"), item("c", "d"), item("x", "other")]),
      (q) =>
        q.orm
          .insert(q.t.workItemScheduling)
          .values([
            scheduled("a", "linear-z"),
            scheduled("b", "linear-m"),
            scheduled("c", "linear-m"),
            scheduled("x", "linear-x"),
          ]),
      (q) =>
        q.orm.insert(q.t.workspaceUser).values(
          ["m", "x", "z"].map((name) => ({
            id: `user-${name}`,
            linearUserId: `linear-${name}`,
            name,
            email: `${name}@example.com`,
          })),
        ),
    );
    expect(await db.run((q) => delegationProjectLeadIdsSteps(q, "d"))).toEqual([
      "user-m",
      "user-z",
    ]);
  });

  test("a session's installation is its team and OAuth client", async () => {
    const db = await connected(connect);
    expect(await db.run((q) => linearSessionInstallationSteps(q, "s"))).toBeNull();
    await seed(db, (q) =>
      q.orm
        .insert(q.t.linearSession)
        .values({ sessionId: "s", teamId: "team", oauthClientId: "client", createdAt: 0 }),
    );
    expect(await db.run((q) => linearSessionInstallationSteps(q, "s"))).toEqual({
      teamId: "team",
      clientId: "client",
    });
  });

  test("a quota recheck belongs to the command and workspace that recorded it", async () => {
    const db = await connected(connect);
    const health = (kind: string, scopeId: string, workspaceId: string) => ({
      kind,
      scope: "binding",
      scopeId,
      workspaceId,
      agent: "codex",
      state: "exhausted",
      source: "result",
      sourceId: "command",
      bindingId: "binding",
      runnerId: "box",
      observedAt: 1,
      nextCheckAt: 500,
      updatedAt: 1,
    });
    await seed(db, (q) =>
      q.orm
        .insert(q.t.agentAccountHealth)
        .values([health("quota", "binding", "acme"), health("auth", "binding", "elsewhere")]),
    );
    expect(await db.run((q) => quotaRecheckAtSteps(q, "command", "acme"))).toBe(500);
    expect(await db.run((q) => quotaRecheckAtSteps(q, "command", "elsewhere"))).toBeNull();
    expect(await db.run((q) => quotaRecheckAtSteps(q, "other", "acme"))).toBeNull();
  });
});
