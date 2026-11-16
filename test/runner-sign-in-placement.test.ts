import { afterEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  bindAgentAccount,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  insertQueuedItem,
  recordAccountObservation,
  putWorkspaceUser,
  recordLinearInstallation,
  type Db,
} from "../src/db";
import {
  createRunnerPlacement,
  itemOwnerHasEligibleRunnerSteps,
  type PlacementRequest,
} from "../src/runner-placement";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { seed, seedCredential } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function setPolicy(db: Db, runnerId: string, set: Record<string, unknown>) {
  return seed(db, (q) =>
    q.orm
      .update(q.t.runnerAgentPolicy)
      .set(set)
      .where(
        and(
          eq(q.t.runnerAgentPolicy.runnerId, runnerId),
          eq(q.t.runnerAgentPolicy.agent, "claude"),
        ),
      ),
  );
}

async function acme() {
  const { db, close } = await tempStore();
  open.push(close);
  const now = Date.now();
  const ada = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "ada",
    name: "Ada",
    email: "ada@acme.test",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "acme-org",
    name: "Acme",
    userId: ada,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "acme-org", now)),
    now,
  });
  await recordLinearInstallation(db, {
    organizationId: "acme-org",
    oauthClientId: "app-client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  const item = await insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  await bindLinearSessionTask(db, "session", item.delegationId, { actorId: "ada" });
  await seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ ownerUserId: ada }).where(eq(q.t.workItem.id, item.id)),
  );
  for (const id of ["acme-1", "acme-2"])
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id,
          workspaceId: workspace.id,
          ownerUserId: ada,
          name: id,
          status: "active",
          createdAt: now,
          lastSeenAt: now,
        }),
      (q) =>
        q.orm.insert(q.t.runnerAgentPolicy).values([
          { runnerId: id, agent: "claude", ready: 1 },
          { runnerId: id, agent: "codex", ready: 0 },
        ]),
    );
  const placement = createRunnerPlacement({ store: db, now: () => now });
  const place = async (request: Partial<PlacementRequest> = {}) => {
    const rejected: { runnerId: string; reason: string; until?: number }[] = [];
    const placed = await placement.candidates({
      itemId: item.id,
      profile: { agent: "claude", model: "opus" },
      role: "implementer",
      purpose: "work",
      onRejected: (runnerId, reason, until) =>
        rejected.push({ runnerId, reason, ...(until === undefined ? {} : { until }) }),
      ...request,
    });
    return { placed, rejected };
  };
  const createAccount = async (label: string) => {
    const account = await createAgentAccount(db, {
      ownerUserId: ada,
      workspaceId: workspace.id,
      agent: "claude",
      label,
      now,
    });
    await seedCredential(db, account.id, "claude", now);
    return account;
  };
  const bind = (runnerId: string, accountId: string) =>
    bindAgentAccount(db, { userId: ada, workspaceId: workspace.id, runnerId, accountId, now });
  return { db, now, workspaceId: workspace.id, item, placement, place, createAccount, bind };
}

test("healthy bindings work without local sign-in; expired and full accounts are refused", async () => {
  const f = await acme();
  const account = await f.createAccount("Team");
  const bindings = await Promise.all(
    ["acme-1", "acme-2"].map((runnerId) => f.bind(runnerId, account.id)),
  );
  await recordAccountObservation(f.db, {
    bindingId: bindings[0]!.id,
    state: "auth_required",
    source: "result",
    sourceId: "expired",
    observedAt: f.now,
    now: f.now,
  });
  await seed(f.db, (q) => q.orm.update(q.t.agentAccount).set({ concurrency: 1 }));
  const admission = createRunnerPlacement({ store: f.db, now: () => f.now });
  const request = {
    itemId: f.item.id,
    profile: { agent: "claude" as const, model: "opus" },
    role: "implementer" as const,
    purpose: "work" as const,
  };
  await seed(f.db, (q) => q.orm.delete(q.t.runnerAgentPolicy));
  const { placed, rejected } = await f.place();
  expect(placed).toEqual([
    {
      id: "acme-2",
      workspaceId: f.workspaceId,
      account: {
        accountId: account.id,
        bindingId: bindings[1]!.id,
        named: true,
      },
    },
  ]);
  expect(rejected).toEqual([{ runnerId: "acme-1", reason: "auth-expired" }]);
  await seed(f.db, (q) =>
    q.orm.insert(q.t.runnerCommand).values({
      id: "cmd",
      runnerId: "acme-2",
      kind: "run",
      envelope: {},
      expiresAt: f.now + 3_600_000,
    }),
  );
  const start = (placement = f.placement, commandId = "cmd") =>
    f.db.transaction((q) =>
      placement.startedSteps(q, {
        commandId,
        runnerId: "acme-2",
        itemId: f.item.id,
        profile: { agent: "claude", model: "opus" },
        account: placed[0]!.account!,
        role: "implementer",
        purpose: "work",
        startedAt: f.now,
      }),
    );
  await start();
  expect(
    await f.db.run((q) =>
      q.all(
        q.orm
          .select({
            runnerId: q.t.runnerExecutionUsage.runnerId,
            revision: q.t.runnerExecutionUsage.accountPolicyRevision,
            fallback: q.t.runnerExecutionUsage.accountFallback,
          })
          .from(q.t.runnerExecutionUsage),
      ),
    ),
  ).toEqual([{ runnerId: "acme-2", revision: null, fallback: null }]);
  await admission.candidates(request);
  await seed(f.db, (q) =>
    q.orm.insert(q.t.runnerCommandAccount).values({
      commandId: "cmd",
      workspaceId: f.workspaceId,
      runnerId: "acme-2",
      agent: "claude",
      accountId: account.id,
      bindingId: bindings[1]!.id,
      named: 1,
      recordedAt: f.now,
    }),
  );
  const disabled = await f.createAccount("disabled");
  await f.bind("acme-2", disabled.id);
  await seed(f.db, (q) =>
    q.orm.update(q.t.agentAccount).set({ enabled: 0 }).where(eq(q.t.agentAccount.id, disabled.id)),
  );
  expect((await f.place()).rejected).toContainEqual({
    runnerId: "acme-2",
    reason: "account at its concurrency limit",
  });
  await expect(start(admission, "blocked")).rejects.toThrow("concurrency");
});

test("runner-local sign-in alone requires adding or binding an account", async () => {
  const f = await acme();
  await setPolicy(f.db, "acme-1", { ready: 1 });
  const result = await f.place();
  expect(result.placed).toEqual([]);
  expect(result.rejected).toEqual([
    { runnerId: "acme-1", reason: "agent-not-signed-in" },
    { runnerId: "acme-2", reason: "agent-not-signed-in" },
  ]);
  expect(
    await f.placement.setupNeed!({
      itemId: f.item.id,
      purpose: "work",
      role: "implementer",
      profile: { agent: "claude" },
    }),
  ).toMatchObject({ reason: "agent-not-signed-in", agent: "claude" });
  expect(
    await f.db.run((q) =>
      itemOwnerHasEligibleRunnerSteps(q, {
        itemId: f.item.id,
        agent: "claude",
        now: f.now,
      }),
    ),
  ).toBe(false);
});

for (const state of ["exhausted", "restricted"] as const)
  test(state + " survives another disabled binding", async () => {
    const f = await acme();
    for (const disabled of [false, true]) {
      const account = await f.createAccount(String(disabled));
      const binding = await f.bind("acme-1", account.id);
      if (disabled)
        await seed(f.db, (q) =>
          q.orm
            .update(q.t.agentAccount)
            .set({ enabled: 0 })
            .where(eq(q.t.agentAccount.id, account.id)),
        );
      else
        await recordAccountObservation(f.db, {
          bindingId: binding.id,
          state,
          resetsAt: f.now + 60_000,
          source: "result",
          sourceId: state,
          observedAt: f.now,
          now: f.now,
        });
    }
    const { placed, rejected } = await f.place();
    expect(placed).toEqual([]);
    expect(rejected.some((r) => r.runnerId === "acme-1" && (r.until ?? 0) > f.now)).toBe(true);
  });

for (const oauth of [false, true])
  test(`placement gates only the selected bound credential, OAuth=${oauth}`, async () => {
    const f = await acme();
    const selected = await f.createAccount("Selected");
    const unrelated = await f.createAccount("Unrelated");
    for (const id of ["acme-1", "acme-2"]) await f.bind(id, selected.id);
    await seed(f.db, (q) =>
      q.orm.insert(q.t.runnerHostStatus).values([
        { runnerId: "acme-1", runnerVersion: "0.1.82", reportedAt: f.now },
        { runnerId: "acme-2", runnerVersion: "0.1.83", reportedAt: f.now },
      ]),
    );
    const placement = createRunnerPlacement({
      store: f.db,
      now: () => f.now,
      requiresOAuthSteps: function* (_q, accountId) {
        yield* [];
        return oauth || accountId === unrelated.id;
      },
    });
    const rejected: string[] = [];
    const placed = await placement.candidates({
      itemId: f.item.id,
      profile: { agent: "claude" },
      role: "implementer",
      purpose: "work",
      onRejected: (_id, reason) => {
        rejected.push(reason);
      },
    });
    expect(placed.map((r) => r.id).sort()).toEqual(oauth ? ["acme-2"] : ["acme-1", "acme-2"]);
    expect(placed.every((r) => r.account?.accountId === selected.id && r.account.named)).toBe(true);
    expect(rejected).toEqual(oauth ? ["Claude OAuth credentials need runner 0.1.83 or later"] : []);
  });
