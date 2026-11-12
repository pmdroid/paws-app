import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createRunnerWork } from "../src/runner-work";
import { putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import { createRunnerModels } from "../src/runner-models";
import { createRunnerPlacementBrowser } from "../src/runner-placement";
import { workspaceId } from "../src/workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function fixture() {
  const { db, close } = await tempStore();
  open.push(close);
  const now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "labels-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = workspaceId(),
    runnerId = workspaceId();
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: workspace, linearOrganizationId: workspace, name: "Labels", createdAt: now }),
  );
  await syncWorkspaceMember(db, {
    workspaceId: workspace,
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now,
  });
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: runnerId,
        workspaceId: workspace,
        ownerUserId: userId,
        name: "Labels host",
        status: "active",
        createdAt: now,
        lastSeenAt: now,
      }),
    (q) => q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId, agent: "claude", ready: 1 }),
    (q) =>
      q.orm.insert(q.t.agentModelCatalog).values({
        runnerId,
        userId,
        agent: "claude",
        model: "",
        resultJson: {
          executionId: "01M5GCQ27RE0YMKT767K0P3451",
          commandId: "probe-1",
          role: "reviewer",
          stopReason: "end_turn",
          timedOut: false,
          cancelled: false,
          authRequired: false,
          agentExited: true,
          models: [
            { id: "default", name: "Default (recommended)" },
            { id: "opus", name: "Opus 5.5" },
            { id: "opus[1m]", name: "Opus", description: "Opus 5.5 (1M context)" },
          ],
          efforts: [{ id: "high", name: "High" }],
        },
        updatedAt: now,
      }),
  );
  return { db, now, runnerId, userId, principal: { workspaceId: workspace, userId } };
}

test("the catalog lists the 1M entry next to its standard model", async () => {
  const { db, principal } = await fixture();
  const work = createRunnerWork({
    store: db,
    keyId: "labels",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  const [catalog] = await createRunnerModels({ store: db, work }).read(principal);
  expect(catalog?.models.map(({ id, name, longContext }) => ({ id, name, longContext }))).toEqual([
    { id: "opus", name: "Opus 5.5", longContext: false },
    { id: "opus[1m]", name: "Opus 5.5 · 1M context", longContext: true },
  ]);
});

test("a runner's run history labels the model it ran", async () => {
  const { db, now, runnerId, userId, principal } = await fixture();
  await seed(db, (q) =>
    q.orm.insert(q.t.runnerExecutionUsage).values({
      commandId: "run-1",
      runnerId,
      ownerUserId: userId,
      agent: "claude",
      model: "opus[1m]",
      resolvedModel: "opus[1m]",
      role: "implementer",
      purpose: "work",
      startedAt: now - 1000,
      endedAt: now,
      outcome: "success",
    }),
  );
  const response = await createRunnerPlacementBrowser({ store: db })(
    new Request("http://127.0.0.1/api/runners/usage"),
    { ...principal, role: "admin", authenticatedAt: now, teamIds: [] },
  );
  const body = (await response!.json()) as {
    usage: Array<{ resolvedModel: string; modelLabel: string }>;
  };
  expect(
    body.usage.map(({ resolvedModel, modelLabel }) => ({ resolvedModel, modelLabel })),
  ).toEqual([{ resolvedModel: "opus[1m]", modelLabel: "Opus 5.5 · 1M context" }]);
});

test("a runner's history names the issue each execution worked on", async () => {
  const { db, now, runnerId, userId, principal } = await fixture();
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workItem).values({
        id: "item-1",
        delegationId: "del-1",
        linearIssueId: "issue-1",
        linearIdentifier: "PAS-367",
        title: "Parse config files",
        state: "running",
        branchName: "paws/pas-367",
        position: 0,
        createdAt: 1,
      }),
    (q) =>
      q.orm.insert(q.t.runnerExecutionUsage).values([
        {
          commandId: "work-1",
          runnerId,
          ownerUserId: userId,
          itemId: "item-1",
          role: "implementer",
          purpose: "work",
          startedAt: now - 1000,
        },
        {
          commandId: "prepare-1",
          runnerId,
          ownerUserId: userId,
          role: "implementer",
          purpose: "prepare",
          startedAt: now - 2000,
        },
      ]),
  );
  const response = await createRunnerPlacementBrowser({ store: db })(
    new Request("http://127.0.0.1/api/runners/usage"),
    { ...principal, role: "admin", authenticatedAt: now, teamIds: [] },
  );
  const body = (await response!.json()) as {
    usage: Array<{ commandId: string; identifier: string | null; title: string | null }>;
  };
  expect(
    body.usage.map(({ commandId, identifier, title }) => ({ commandId, identifier, title })),
  ).toEqual([
    { commandId: "work-1", identifier: "PAS-367", title: "Parse config files" },
    { commandId: "prepare-1", identifier: null, title: null },
  ]);
});

test("the catalog reports the agent's default model and effort", async () => {
  const { db, runnerId, principal } = await fixture();
  const result = (model: string, effort: string) => ({
    executionId: "01M5GCQ27RE0YMKT767K0P3451",
    commandId: `probe-${model}`,
    role: "reviewer",
    stopReason: "end_turn",
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    identity: { session: "s", model, provider: "anthropic" },
    models: [{ id: "opus", name: "Opus 5.5" }],
    efforts: [
      { id: "high", name: "High" },
      { id: "max", name: "Max" },
    ],
    effort,
  });
  await seed(db, (q) =>
    q.orm
      .update(q.t.agentModelCatalog)
      .set({ resultJson: result("opus", "high") })
      .where(
        and(eq(q.t.agentModelCatalog.runnerId, runnerId), eq(q.t.agentModelCatalog.model, "")),
      ),
  );
  const work = createRunnerWork({
    store: db,
    keyId: "labels",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  const [catalog] = await createRunnerModels({ store: db, work }).read(principal);
  expect(catalog?.defaultModel).toBe("opus");
  expect(catalog?.models.find((model) => model.id === "opus")?.defaultEffort).toBe("high");
});
