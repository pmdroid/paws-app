import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  activeAgentFleet,
  handleAgentSettingsRequest,
  type AgentFleet,
  type AgentSettingsOptions,
} from "../src/settings";
import { loadConfigFile, readAgentSettings, useMemorySettings } from "../src/config";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";
import { offerFixtureModels, seed, signInFixtureRunner } from "./pglite-fixtures";
import { NOW, workspaceWithRunners } from "./runner-slot-fixture";

const SOL = "gpt-6.2-sol";
const HOUR = 60 * 60 * 1000;

function fixture(fleet: AgentFleet) {
  const configPath = join(tempHome(), "config.toml");
  useMemorySettings(configPath);
  const options: AgentSettingsOptions = {
    configPath,
    csrfToken: "test-token",
    fleet: async () => fleet,
    now: () => NOW,
  };
  return options;
}

function put(body: unknown, options: AgentSettingsOptions) {
  return handleAgentSettingsRequest(
    new Request("http://127.0.0.1:8787/api/settings/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-paws-csrf": "test-token" },
      body: JSON.stringify(body),
    }),
    options,
  );
}

const defaults = (implementer: string | null, reviewer: string | null) => ({
  defaults: {
    implementer: { agent: "codex", model: implementer },
    reviewer: { agent: "codex", model: reviewer },
  },
});

const fresh = (name: string, agent: string, models: string[] | null) => ({
  name,
  agent,
  models,
  catalogAt: models ? NOW - HOUR : null,
});

const fleet: AgentFleet = {
  runners: [
    fresh("studio", "codex", [SOL, "gpt-6.1"]),
    fresh("laptop", "codex", ["gpt-6.1"]),
    fresh("mini", "codex", null),
  ],
  waitingReviews: [],
};

const saved = (options: AgentSettingsOptions) =>
  readAgentSettings(loadConfigFile(options.configPath)).defaults;

describe("agent defaults checked against the fleet", () => {
  test("a model no runner offers is refused and the file keeps the old defaults", async () => {
    const options = fixture(fleet);
    const response = await put({ ...defaults("gpt-7", null), confirm: true }, options);
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: "No runner offers codex gpt-7 for the implementer.",
      refusals: ["No runner offers codex gpt-7 for the implementer."],
    });
    expect(saved(options).implementer).toEqual({ agent: "claude", model: null });
  });

  test("a model on some runners warns, then saves with confirmation", async () => {
    const options = fixture(fleet);
    const warning = `Only some runners offer codex ${SOL} for the implementer: studio.`;
    const unconfirmed = await put(defaults(SOL, null), options);
    expect(unconfirmed?.status).toBe(409);
    expect(await unconfirmed!.json()).toEqual({
      error: "Confirm these warnings to save the agent defaults.",
      warnings: [warning],
      confirmRequired: true,
    });
    expect(saved(options).implementer.agent).toBe("claude");
    const confirmed = await put({ ...defaults(SOL, null), confirm: true }, options);
    expect(confirmed?.status).toBe(200);
    expect(((await confirmed!.json()) as { warnings: string[] }).warnings).toEqual([warning]);
    expect(saved(options).implementer).toEqual({ agent: "codex", model: SOL });
    expect((await put(defaults(SOL, null), options))?.status).toBe(200);
  });

  test("reviewer equal to implementer is refused", async () => {
    const response = await put({ ...defaults(SOL, SOL), confirm: true }, fixture(fleet));
    expect(response?.status).toBe(400);
  });

  test("names waiting items whose implementation model is the new reviewer, and stale catalogs", async () => {
    const options = fixture({
      runners: [
        { name: "studio", agent: "codex", models: [SOL, "gpt-6.1"], catalogAt: NOW - 25 * HOUR },
      ],
      waitingReviews: [
        { identifier: "PAS-2447", model: SOL },
        { identifier: "PAS-2448", model: "gpt-6.1" },
        { identifier: "PAS-2449", model: null },
      ],
    });
    const response = await put(defaults("gpt-6.1", SOL), options);
    expect(response?.status).toBe(409);
    expect(((await response!.json()) as { warnings: string[] }).warnings).toEqual([
      "These runners' model catalogs are more than 24 hours old: studio.",
      `These items wait for review and were implemented with ${SOL}, the new reviewer model: PAS-2447.`,
    ]);
  });
});

describe("active agent fleet", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  test("reads signed-in runners' catalogs and the implementation model of verifying items", async () => {
    const store = await tempStore();
    close = store.close;
    const { db } = store;
    const { pair, queue, userId } = await workspaceWithRunners(db);
    const studio = await pair("studio", 2, null);
    await pair("laptop", 2, null);
    await signInFixtureRunner(db, studio, "codex");
    await offerFixtureModels(db, studio, "claude", ["opus"], NOW);
    await queue("PAS-1");
    await queue("PAS-2");
    await seed(
      db,
      (q) =>
        q.orm.update(q.t.workItem).set({ state: "verifying" }).where(eq(q.t.workItem.id, "PAS-1")),
      (q) =>
        q.orm.insert(q.t.runnerExecutionUsage).values({
          commandId: "turn",
          runnerId: studio,
          ownerUserId: userId,
          itemId: "PAS-1",
          agent: "claude",
          model: "opus",
          resolvedModel: "opus",
          role: "implementer",
          purpose: "work",
          outcome: "success",
          startedAt: NOW,
          endedAt: NOW,
        }),
    );
    expect(await activeAgentFleet(db)).toEqual({
      runners: [
        { name: "laptop", agent: "claude", models: null, catalogAt: null },
        { name: "studio", agent: "claude", models: ["opus"], catalogAt: NOW },
        { name: "studio", agent: "codex", models: null, catalogAt: null },
      ],
      waitingReviews: [{ identifier: "PAS-1", model: "opus" }],
    });
  });
});
