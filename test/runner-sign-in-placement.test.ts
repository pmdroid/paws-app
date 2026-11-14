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
import { seed } from "./dialects";
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
  return { db, now, workspaceId: workspace.id, item, placement, place };
}

test("healthy bindings work without local sign-in; expired and full accounts are refused", async () => {
  const f = await acme();
  const account = await createAgentAccount(f.db, {
    workspaceId: f.workspaceId,
    agent: "claude",
    label: "Team",
    now: f.now,
  });
  const bindings = await Promise.all(
    ["acme-1", "acme-2"].map((runnerId) =>
      bindAgentAccount(f.db, {
        workspaceId: f.workspaceId,
        accountId: account.id,
        runnerId,
        now: f.now,
      }),
    ),
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
  expect((await f.place()).placed).toEqual([]);
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
