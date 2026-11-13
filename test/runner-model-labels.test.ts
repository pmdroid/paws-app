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
    fast: true,
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
  expect(catalog?.models.find((model) => model.id === "opus")?.fast).toBe(true);
});

function models(db: Awaited<ReturnType<typeof fixture>>["db"], fetch?: typeof globalThis.fetch) {
  const work = createRunnerWork({
    store: db,
    keyId: "labels",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  return createRunnerModels({ store: db, work, ...(fetch ? { fetch } : {}) });
}

test("without runner catalogs the bundled choices stand in for claude, codex and grok", async () => {
  const { db, principal } = await fixture();
  await seed(db, (q) => q.orm.delete(q.t.agentModelCatalog));
  const response = await models(db).browser(
    new Request("http://localhost/api/runners/models"),
    principal,
  );
  const { catalogs } = (await response!.json()) as {
    catalogs: Array<{
      agent: string;
      defaultModel: string;
      models: Array<{ id: string; efforts: Array<{ id: string }>; defaultEffort: null }>;
    }>;
  };
  expect(catalogs.map(({ agent, defaultModel }) => [agent, defaultModel])).toEqual([
    ["claude", "fable"],
    ["codex", "gpt-6.1-sol"],
    ["grok", "grok-4.7"],
  ]);
  expect(catalogs[0]!.models.map((model) => model.id)).toEqual([
    "opus",
    "fable",
    "sonnet",
    "haiku",
  ]);
  expect(catalogs[2]!.models[0]!.efforts.map((effort) => effort.id)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  expect(catalogs[1]!.models[0]!.defaultEffort).toBeNull();
});

test("a runner's catalog replaces only its own agent's bundled choices", async () => {
  const { db, principal } = await fixture();
  const catalogs = await models(db).read(principal);
  expect(catalogs.map((catalog) => catalog.agent)).toEqual(["claude", "codex", "grok"]);
  expect(catalogs[0]!.models.map((model) => model.id)).toEqual(["opus", "opus[1m]"]);
  expect(catalogs[1]!.models[0]!.id).toBe("gpt-6.1-sol");
});

test("models.dev ids join the bundled lists and a failed refresh keeps the last good list", async () => {
  const { db, principal } = await fixture();
  await seed(db, (q) => q.orm.delete(q.t.agentModelCatalog));
  let answer: () => Response = () =>
    Response.json({
      anthropic: { models: { a: { id: "claude-opus-5-5" }, b: { id: "opus" } } },
      openai: { models: { c: { id: "gpt-6.1-sol" }, d: { id: "gpt-7" }, e: { id: "o9" } } },
      xai: { models: { f: { id: "grok-5" } } },
    });
  const catalog = models(db, (async () => answer()) as unknown as typeof fetch);
  const ids = async () =>
    (await catalog.read(principal)).map((entry) => entry.models.map((model) => model.id));
  await catalog.refreshDefaults();
  const refreshed = await ids();
  expect(refreshed[0]).toEqual(["opus", "fable", "sonnet", "haiku", "claude-opus-5-5"]);
  expect(refreshed[1]!.slice(-2)).toEqual(["gpt-5.6-luna", "gpt-7"]);
  expect(refreshed[2]).toEqual([
    "grok-4.7",
    "grok-4.7-build-fast",
    "grok-4.6",
    "grok-4.5",
    "grok-5",
  ]);
  answer = () => new Response("not json");
  await catalog.refreshDefaults();
  expect(await ids()).toEqual(refreshed);
  answer = () => {
    throw new Error("offline");
  };
  await catalog.refreshDefaults();
  expect(await ids()).toEqual(refreshed);
});
