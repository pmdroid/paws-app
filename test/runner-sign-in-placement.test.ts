import { afterEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  bindAgentAccount,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  insertQueuedItem,
  legacyAgentAccountId,
  legacyAgentBindingId,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerAccountCapability,
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

const HOUR = 3_600_000;

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

test("two runners signed in to Claude, one with its 5-hour window spent: the implementer goes to the other", async () => {
  const f = await acme();
  const reset = f.now + 5 * HOUR;
  await setPolicy(f.db, "acme-1", {
    quotaState: "exhausted",
    resetsAt: reset,
    cooldownUntil: reset,
  });
  const { placed, rejected } = await f.place();
  expect(placed).toEqual([
    {
      id: "acme-2",
      workspaceId: f.workspaceId,
      account: {
        accountId: legacyAgentAccountId(f.workspaceId, "claude"),
        bindingId: legacyAgentBindingId("acme-2", "claude"),
        named: false,
      },
    },
  ]);
  expect(rejected).toEqual([{ runnerId: "acme-1", reason: "agent quota cooldown", until: reset }]);
  await seed(f.db, (q) =>
    q.orm.insert(q.t.runnerCommand).values({
      id: "cmd",
      runnerId: "acme-2",
      kind: "run",
      envelope: {},
      expiresAt: f.now + HOUR,
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

test("no runner signed in to the reviewer's agent: placement offers none and waits for a sign-in", async () => {
  const f = await acme();
  const reviewer = {
    role: "reviewer" as const,
    profile: { agent: "codex" as const, model: "gpt-5" },
  };
  const { placed, rejected } = await f.place(reviewer);
  expect(placed).toEqual([]);
  expect(rejected).toEqual([
    { runnerId: "acme-1", reason: "agent-not-signed-in" },
    { runnerId: "acme-2", reason: "agent-not-signed-in" },
  ]);
  expect(
    await f.placement.setupNeed!({ itemId: f.item.id, purpose: "work", ...reviewer }),
  ).toMatchObject({ reason: "agent-not-signed-in", runnerId: "acme-1", agent: "codex" });
  expect(
    await f.db.run((q) =>
      itemOwnerHasEligibleRunnerSteps(q, { itemId: f.item.id, agent: "codex", now: f.now }),
    ),
  ).toBe(false);
});

test("a named account bound to a runner no longer stands in for that runner's own sign-in", async () => {
  const f = await acme();
  const named = await createAgentAccount(f.db, {
    workspaceId: f.workspaceId,
    agent: "claude",
    label: "Acme team Claude",
    now: f.now,
  });
  const binding = await bindAgentAccount(f.db, {
    workspaceId: f.workspaceId,
    accountId: named.id,
    runnerId: "acme-1",
    now: f.now,
  });
  await seed(f.db, (q) =>
    q.orm
      .insert(q.t.runnerHostStatus)
      .values({ runnerId: "acme-1", runnerVersion: "0.1.61", reportedAt: f.now }),
  );
  await recordRunnerAccountCapability(
    f.db,
    "acme-1",
    { protocol: 1, bindings: [{ bindingId: binding.id, agent: "claude" }] },
    f.now,
  );
  await setPolicy(f.db, "acme-1", { ready: 0 });
  const { placed, rejected } = await f.place();
  expect(placed.map((entry) => entry.id)).toEqual(["acme-2"]);
  expect(rejected).toEqual([{ runnerId: "acme-1", reason: "agent-not-signed-in" }]);
  await setPolicy(f.db, "acme-2", { ready: 0 });
  expect(
    await f.db.run((q) =>
      itemOwnerHasEligibleRunnerSteps(q, { itemId: f.item.id, agent: "claude", now: f.now }),
    ),
  ).toBe(false);
});
