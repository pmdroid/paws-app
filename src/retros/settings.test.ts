import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginRetroCollection,
  failRetroAttempt,
  freezeRetroInput,
  getRetro,
  migrate,
  openDatabase,
  publishRetro,
  recordRetroEvidence,
  retroRepositories,
  startRetroAttempt,
  writeRetroArtifact,
} from "../db";
import type { AgentModelCatalog } from "../runner-models";
import {
  checkRetroProfile,
  DEFAULT_RETRO_PROMPT,
  freezeRetroPrompt,
  freezeRetroRun,
  nextRetroOccurrence,
  proposedRetroSettings,
  readRetroSettings,
  resolveRetroProfile,
  retroAttemptLimits,
  retroRunRepositories,
  saveRetroSettings,
  type RetroSettingsDraft,
} from "./index";

const APP = "pmdroid/paws-app";
const LANDING = "pmdroid/landing";
const DAY = 86_400_000;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const effort = (id: string) => ({ id, name: id });
const CATALOGS: AgentModelCatalog[] = [
  {
    agent: "codex",
    updatedAt: 1,
    efforts: [effort("low"), effort("medium"), effort("high")],
    defaultModel: "gpt-6-astra",
    models: [
      {
        id: "gpt-6-astra",
        name: "gpt-6-astra",
        longContext: false,
        efforts: [effort("low"), effort("medium"), effort("high")],
        defaultEffort: "medium",
      },
      {
        id: "gpt-6-mini",
        name: "gpt-6-mini",
        longContext: false,
        efforts: null,
        defaultEffort: null,
      },
    ],
  },
  {
    agent: "claude",
    updatedAt: 1,
    efforts: [],
    defaultModel: "opus",
    models: [
      { id: "opus", name: "Opus 5.5", longContext: false, efforts: [], defaultEffort: null },
    ],
  },
];

function harness() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run("INSERT INTO workspace VALUES ('ws', 'org', 'Kyku', 0)");
  const root = mkdtempSync(join(tmpdir(), "paws-retro-settings-"));
  roots.push(root);
  return { db, root: join(root, "artifacts") };
}

function draft(change: Partial<RetroSettingsDraft> = {}): RetroSettingsDraft {
  return {
    ...proposedRetroSettings([APP]),
    agentProfile: { agent: "codex", model: "gpt-6-astra", effort: "high" },
    ...change,
  };
}

function save(
  db: ReturnType<typeof harness>["db"],
  input: {
    expectedRevision: number;
    draft: unknown;
    catalogs?: AgentModelCatalog[] | null;
    accessible?: string[];
    now?: number;
  },
) {
  return saveRetroSettings(db, {
    workspaceId: "ws",
    actorId: "admin-1",
    expectedRevision: input.expectedRevision,
    draft: input.draft,
    catalogs: input.catalogs === undefined ? CATALOGS : input.catalogs,
    accessibleRepositories: input.accessible ?? [APP, LANDING],
    now: input.now ?? 1,
  });
}

function freeze(
  db: ReturnType<typeof harness>["db"],
  input: {
    id: string;
    start: number;
    accessible?: string[];
    catalogs?: AgentModelCatalog[] | null;
  },
) {
  return freezeRetroRun(db, {
    id: input.id,
    workspaceId: "ws",
    windowStart: input.start,
    windowEnd: input.start + 7 * DAY,
    origin: "scheduled",
    catalogs: input.catalogs === undefined ? CATALOGS : input.catalogs,
    accessibleRepositories: input.accessible ?? [APP, LANDING],
    now: input.start + 7 * DAY,
  });
}

function collectAndQueue(
  db: ReturnType<typeof harness>["db"],
  root: string,
  retroId: string,
  cursors: Record<string, number>,
) {
  expect(beginRetroCollection(db, { retroId, now: 1 }).ok).toBe(true);
  recordRetroEvidence(db, retroId, [
    {
      evidenceId: "e1",
      repository: APP,
      sourceKind: "linear_question",
      sourceRef: "question:1",
      occurredAt: 1,
      excerpt: "Fetch the branch.",
    },
  ]);
  for (const kind of ["digest", "manifest"] as const)
    writeRetroArtifact(db, root, {
      retroId,
      kind,
      bytes: new TextEncoder().encode(`${kind} ${retroId}`),
      now: 1,
    });
  freezeRetroInput(db, { retroId, endCursors: cursors, now: 1 });
}

describe("saving retro settings", () => {
  test("before a save the proposed defaults show at revision 0", () => {
    const { db } = harness();
    const view = readRetroSettings(db, { workspaceId: "ws", accessibleRepositories: [APP] });
    expect(view).toMatchObject({ revision: 0, saved: false, defaultPrompt: DEFAULT_RETRO_PROMPT });
    expect(view.settings.executionLimits).toEqual({ activeMinutes: 15, retries: 1 });
    expect(view.settings.outputLimits).toEqual({ maxItems: 5, workedWell: 3 });
    expect(view.settings.repositories).toEqual([APP]);
  });

  test("each save is one revision across every field", () => {
    const { db } = harness();
    const first = save(db, { expectedRevision: 0, draft: draft() });
    expect(first.ok && first.view.revision).toBe(1);
    const second = save(db, {
      expectedRevision: 1,
      draft: draft({
        prompt: `Be brief.\n\n${DEFAULT_RETRO_PROMPT}`,
        repositories: [APP, LANDING],
        outputLimits: { maxItems: 3, workedWell: 1 },
        executionLimits: { activeMinutes: 20, retries: 2 },
        schedule: {
          cadence: "weekly",
          weekday: "friday",
          time: "10:30",
          timeZone: "Europe/Berlin",
        },
      }),
      now: 2,
    });
    expect(second.ok).toBe(true);
    const view = readRetroSettings(db, {
      workspaceId: "ws",
      accessibleRepositories: [APP, LANDING],
    });
    expect(view.revision).toBe(2);
    expect(view.settings).toMatchObject({
      repositories: [APP, LANDING],
      outputLimits: { maxItems: 3, workedWell: 1 },
      executionLimits: { activeMinutes: 20, retries: 2 },
      schedule: { weekday: "friday", time: "10:30", timeZone: "Europe/Berlin" },
    });
    expect(view.settings.prompt.startsWith("Be brief.")).toBe(true);
  });

  test("a stale expected revision keeps the draft and returns the saved revision", () => {
    const { db } = harness();
    save(db, { expectedRevision: 0, draft: draft() });
    save(db, {
      expectedRevision: 1,
      draft: draft({ outputLimits: { maxItems: 2, workedWell: 0 } }),
    });
    const mine = draft({ outputLimits: { maxItems: 4, workedWell: 2 } });
    const result = save(db, { expectedRevision: 1, draft: mine });
    expect(result).toMatchObject({ ok: false, reason: "conflict", draft: mine });
    if (result.ok || result.reason !== "conflict") throw new Error("expected a conflict");
    expect(result.current.revision).toBe(2);
    expect(result.current.settings.outputLimits).toEqual({ maxItems: 2, workedWell: 0 });
  });

  test("out-of-range values, a broken prompt and a bad time zone are rejected", () => {
    const { db } = harness();
    const result = save(db, {
      expectedRevision: 0,
      draft: draft({
        prompt: "No digest {{nope}}",
        outputLimits: { maxItems: 6, workedWell: 4 },
        executionLimits: { activeMinutes: 121, retries: 4 },
        schedule: { cadence: "weekly", weekday: "monday", time: "25:00", timeZone: "Mars/Base" },
      }),
    });
    if (result.ok || result.reason !== "invalid") throw new Error("expected invalid");
    expect(result.problems.map((problem) => problem.field).sort()).toEqual([
      "executionLimits.activeMinutes",
      "executionLimits.retries",
      "outputLimits.maxItems",
      "outputLimits.workedWell",
      "prompt",
      "schedule.time",
      "schedule.timeZone",
    ]);
    expect(readRetroSettings(db, { workspaceId: "ws", accessibleRepositories: [] }).saved).toBe(
      false,
    );
  });

  test("an inaccessible repository is rejected", () => {
    const { db } = harness();
    const result = save(db, {
      expectedRevision: 0,
      draft: draft({ repositories: [APP, "someone/private"] }),
    });
    expect(result).toMatchObject({ ok: false, reason: "inaccessible_repository" });
  });

  test("an unsupported model or effort is not an unavailable catalog", () => {
    const { db } = harness();
    expect(
      save(db, {
        expectedRevision: 0,
        draft: draft({ agentProfile: { agent: "codex", model: "gpt-5", effort: null } }),
      }),
    ).toMatchObject({ ok: false, reason: "unsupported" });
    expect(
      save(db, {
        expectedRevision: 0,
        draft: draft({ agentProfile: { agent: "codex", model: "gpt-6-astra", effort: "max" } }),
      }),
    ).toMatchObject({ ok: false, reason: "unsupported" });
    expect(
      save(db, {
        expectedRevision: 0,
        draft: draft({ agentProfile: { agent: "grok", model: "grok-5", effort: null } }),
      }),
    ).toMatchObject({ ok: false, reason: "catalog_unavailable" });
    expect(
      save(db, {
        expectedRevision: 0,
        draft: draft({ agentProfile: { agent: "codex", model: "gpt-6-mini", effort: "low" } }),
      }),
    ).toMatchObject({ ok: false, reason: "catalog_unavailable" });
  });

  test("the agent default saves without a catalog", () => {
    const { db } = harness();
    const result = save(db, {
      expectedRevision: 0,
      draft: draft({ agentProfile: { agent: "grok", model: null, effort: null } }),
      catalogs: null,
    });
    expect(result.ok).toBe(true);
  });

  test("only the selected agent's catalog decides", () => {
    const onlyCodex = CATALOGS.filter((catalog) => catalog.agent === "codex");
    expect(
      checkRetroProfile({ agent: "codex", model: "gpt-6-astra", effort: "high" }, onlyCodex).ok,
    ).toBe(true);
  });

  test("changing the agent resets choices the new agent does not offer", () => {
    const { db } = harness();
    save(db, { expectedRevision: 0, draft: draft() });
    const result = save(db, {
      expectedRevision: 1,
      draft: draft({ agentProfile: { agent: "claude", model: "gpt-6-astra", effort: "high" } }),
    });
    expect(result.ok && result.view.settings.agentProfile).toEqual({
      agent: "claude",
      model: null,
      effort: null,
    });
  });
});

describe("frozen retro runs", () => {
  test("an agent default resolves once to a concrete model and effort", () => {
    expect(resolveRetroProfile({ agent: "codex", model: null, effort: null }, CATALOGS)).toEqual({
      ok: true,
      profile: {
        agent: "codex",
        model: "gpt-6-astra",
        effort: "medium",
        selected: { model: null, effort: null },
      },
    });
    expect(
      resolveRetroProfile({ agent: "claude", model: null, effort: null }, CATALOGS),
    ).toMatchObject({ ok: true, profile: { model: "opus", effort: null } });
    expect(
      resolveRetroProfile({ agent: "grok", model: null, effort: null }, CATALOGS),
    ).toMatchObject({ ok: false, reason: "catalog_unavailable" });
  });

  test("a queued run and its retries keep their values after a new save", () => {
    const { db, root } = harness();
    save(db, {
      expectedRevision: 0,
      draft: draft({ agentProfile: { agent: "codex", model: null, effort: null } }),
    });
    const frozen = freeze(db, { id: "r1", start: 0 });
    if (!frozen.ok) throw new Error(frozen.message);
    collectAndQueue(db, root, "r1", { [APP]: 5 });
    save(db, {
      expectedRevision: 1,
      draft: draft({
        prompt: `Changed.\n${DEFAULT_RETRO_PROMPT}`,
        agentProfile: { agent: "claude", model: null, effort: null },
        executionLimits: { activeMinutes: 60, retries: 3 },
      }),
      now: 2,
    });
    const rendered: string[] = [];
    const render = (template: string, digest: Uint8Array) => {
      const text = template.replace("{{digest}}", new TextDecoder().decode(digest));
      rendered.push(text);
      return text;
    };
    const prompt = freezeRetroPrompt(db, root, { retroId: "r1", render, now: 3 });
    if (!prompt.ok) throw new Error(prompt.reason);
    expect(prompt.prompt).toContain("digest r1");
    expect(prompt.prompt).not.toContain("Changed.");

    const limits = retroAttemptLimits(getRetro(db, "r1")!.executionLimits);
    expect(limits).toEqual({ maxAttempts: 2, activeExecutionMs: 15 * 60_000 });
    const attempt = startRetroAttempt(db, {
      retroId: "r1",
      owner: "runner-a",
      now: 4,
      leaseMs: 1000,
      maxAttempts: limits.maxAttempts,
    })!;
    failRetroAttempt(db, { retroId: "r1", ...attempt, owner: "runner-a", error: "lost", now: 5 });
    expect(
      startRetroAttempt(db, { retroId: "r1", owner: "runner-b", now: 6, leaseMs: 1000, ...limits }),
    ).toEqual({ attempt: 2 });
    const retry = freezeRetroPrompt(db, root, { retroId: "r1", render, now: 7 });
    expect(retry).toEqual(prompt);
    expect(rendered).toHaveLength(1);

    const again = freeze(db, { id: "r1-again", start: 0, catalogs: null });
    expect(again.ok && again.retro).toMatchObject({
      id: "r1",
      settingsRevision: 1,
      agentProfile: { agent: "codex", model: "gpt-6-astra", effort: "medium" },
      executionLimits: { activeMinutes: 15, retries: 1 },
    });
  });

  test("a run leaves out a repository whose access was revoked and a save cannot add it back", () => {
    const { db } = harness();
    save(db, { expectedRevision: 0, draft: draft({ repositories: [APP, LANDING] }) });
    const frozen = freeze(db, { id: "r1", start: 0, accessible: [APP] });
    expect(frozen.ok && frozen.retro.repositories).toEqual([APP]);
    expect(retroRunRepositories([APP], [APP, LANDING])).toEqual([APP]);
    expect(retroRunRepositories([APP, LANDING], [LANDING])).toEqual([LANDING]);
    expect(freeze(db, { id: "r2", start: 7 * DAY, accessible: [] })).toMatchObject({
      ok: false,
      reason: "no_accessible_repository",
    });
  });

  test("a run needs a saved revision", () => {
    const { db } = harness();
    expect(freeze(db, { id: "r1", start: 0 })).toMatchObject({ ok: false, reason: "no_settings" });
  });
});

describe("repository selection", () => {
  test("a newly enabled repository starts with its retained history", () => {
    const { db, root } = harness();
    const publish = (retroId: string, owner: string) => {
      const attempt = startRetroAttempt(db, { retroId, owner, now: 1, leaseMs: 1000 })!;
      expect(
        publishRetro(db, { retroId, ...attempt, owner, result: {}, items: [], now: 2 }).ok,
      ).toBe(true);
    };
    save(db, { expectedRevision: 0, draft: draft({ repositories: [APP] }) });
    const first = freeze(db, { id: "r1", start: 0 });
    if (!first.ok) throw new Error(first.message);
    collectAndQueue(db, root, "r1", { [APP]: 10 });
    publish("r1", "a");

    save(db, { expectedRevision: 1, draft: draft({ repositories: [LANDING] }) });
    expect(freeze(db, { id: "r2", start: 7 * DAY }).ok).toBe(true);
    expect(beginRetroCollection(db, { retroId: "r2", now: 3 }).ok).toBe(true);
    expect(retroRepositories(db, "r2")).toEqual([
      { repository: LANDING, startCursor: 0, endCursor: null },
    ]);
  });

  test("re-enabling a repository continues from its last reported cursor", () => {
    const { db, root } = harness();
    save(db, { expectedRevision: 0, draft: draft({ repositories: [APP] }) });
    freeze(db, { id: "r1", start: 0 });
    collectAndQueue(db, root, "r1", { [APP]: 10 });
    const attempt = startRetroAttempt(db, { retroId: "r1", owner: "a", now: 1, leaseMs: 1000 })!;
    publishRetro(db, { retroId: "r1", ...attempt, owner: "a", result: {}, items: [], now: 2 });
    save(db, { expectedRevision: 1, draft: draft({ repositories: [LANDING] }) });
    save(db, { expectedRevision: 2, draft: draft({ repositories: [APP] }) });
    freeze(db, { id: "r2", start: 21 * DAY });
    expect(beginRetroCollection(db, { retroId: "r2", now: 3 }).ok).toBe(true);
    expect(retroRepositories(db, "r2")).toEqual([
      { repository: APP, startCursor: 10, endCursor: null },
    ]);
  });
});

describe("schedule", () => {
  const weekly = { cadence: "weekly", weekday: "monday", time: "09:00" } as const;

  test("the next occurrence follows the saved weekday, time and zone", () => {
    const sunday = Date.UTC(2026, 10, 1, 12);
    expect(nextRetroOccurrence({ ...weekly, timeZone: "UTC" }, sunday)).toBe(
      Date.UTC(2026, 10, 2, 9),
    );
    expect(nextRetroOccurrence({ ...weekly, timeZone: "Europe/Berlin" }, sunday)).toBe(
      Date.UTC(2026, 10, 2, 8),
    );
    expect(nextRetroOccurrence({ ...weekly, timeZone: "UTC" }, Date.UTC(2026, 10, 2, 9))).toBe(
      Date.UTC(2026, 10, 9, 9),
    );
    expect(
      nextRetroOccurrence({ ...weekly, timeZone: "America/New_York" }, Date.UTC(2026, 2, 7)),
    ).toBe(Date.UTC(2026, 2, 9, 13));
  });

  test("a paused schedule has no next occurrence", () => {
    expect(
      nextRetroOccurrence({ ...weekly, cadence: "paused", timeZone: "UTC" }, Date.UTC(2026, 0, 1)),
    ).toBeNull();
  });
});
