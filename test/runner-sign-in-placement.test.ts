import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  bindAgentAccount,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  insertQueuedItem,
  recordAccountObservation,
  putWorkspaceUser,
  recordLinearInstallation,
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

test("two bound runners with one expired account: the implementer goes to the other", async () => {
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
  await f.db.transaction((q) =>
    f.placement.startedSteps(q, {
      commandId: "cmd",
      runnerId: "acme-2",
      itemId: f.item.id,
      profile: { agent: "claude", model: "opus" },
      account: placed[0]!.account!,
      role: "implementer",
      purpose: "work",
      startedAt: f.now,
    }),
  );
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
});

test("a healthy bound account places work without any runner-local sign-in", async () => {
  const f = await acme();
  const account = await createAgentAccount(f.db, {
    workspaceId: f.workspaceId,
    agent: "claude",
    label: "Team",
    now: f.now,
  });
  const binding = await bindAgentAccount(f.db, {
    workspaceId: f.workspaceId,
    accountId: account.id,
    runnerId: "acme-1",
    now: f.now,
  });
  await seed(f.db, (q) => q.orm.delete(q.t.runnerAgentPolicy));
  expect((await f.place()).placed).toEqual([
    {
      id: "acme-1",
      workspaceId: f.workspaceId,
      account: { accountId: account.id, bindingId: binding.id, named: true },
    },
  ]);
  await recordAccountObservation(f.db, {
    bindingId: binding.id,
    state: "auth_required",
    source: "result",
    sourceId: "expired",
    observedAt: f.now,
    now: f.now,
  });
  const expired = await f.place();
  expect(expired.placed).toEqual([]);
  expect(expired.rejected).toContainEqual({ runnerId: "acme-1", reason: "auth-expired" });
});

test("runner-local sign-in alone requires adding or binding an account", async () => {
  const f = await acme();
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
