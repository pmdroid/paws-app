import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfigFile,
  parseAgentSettings,
  readAgentSettings,
  resolveAccountPolicy,
  resolveAgentProfiles,
  validateAccountReferences,
  writeAgentSettings,
  writeImplementer,
  type AgentAccountReference,
  type AgentSettings,
} from "../src/config";
import { tempHome } from "./helpers";

const A = "01J0000000000000000000000A";
const B = "01J0000000000000000000000B";
const C = "01J0000000000000000000000C";
const X = "01J0000000000000000000000X";

const settings: AgentSettings = {
  defaults: {
    implementer: { agent: "claude", model: "claude-sonnet-4-5", effort: "high" },
    reviewer: { agent: "codex", model: null },
    reviewerFallback: { agent: "grok", model: null },
    accounts: { implementer: [A, B], reviewer: [X], reviewerFallback: ["legacy_grok_W1"] },
  },
  projects: [
    { repo: "pmdroid/override", accounts: { implementer: [B] } },
    { repo: "pmdroid/switch", implementer: { agent: "codex", model: "gpt-6" } },
    { repo: "pmdroid/plain" },
  ],
};

function configured(input = settings) {
  const path = join(tempHome(), "config.toml");
  writeAgentSettings(path, input);
  return { path, config: loadConfigFile(path) };
}

describe("agent account policy settings", () => {
  test("round-trips account lists without touching the profiles or unrelated settings", () => {
    const path = join(tempHome(), "config.toml");
    writeFileSync(path, '[github]\nrepo = "pmdroid/other"\n\n[queue]\nstart_timeout_hours = 6\n');
    writeAgentSettings(path, settings);
    const text = readFileSync(path, "utf8");
    expect(text).toContain('[github]\nrepo = "pmdroid/other"');
    expect(text).toContain("start_timeout_hours = 6");
    expect(text).toContain(`[agents.defaults.accounts]\nimplementer = ["${A}","${B}"]`);
    expect(text).toContain(`[agents.projects."pmdroid/override".accounts]\nimplementer = ["${B}"]`);
    const config = loadConfigFile(path);
    expect(readAgentSettings(config)).toEqual(settings);
    expect(config.repo).toBe("pmdroid/other");
    writeAgentSettings(path, readAgentSettings(config));
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("unconfigured installations keep the default sign-in", () => {
    const { config } = configured({
      defaults: {
        implementer: settings.defaults.implementer,
        reviewer: settings.defaults.reviewer,
      },
      projects: [],
    });
    expect(resolveAccountPolicy(config, "pmdroid/plain")).toBeNull();
    expect(resolveAccountPolicy(loadConfigFile(join(tempHome(), "none.toml")))).toBeNull();
  });

  test("a project list replaces the default list; a switched agent does not inherit it", () => {
    const { config } = configured();
    const plain = resolveAccountPolicy(config, "pmdroid/plain")!;
    expect(plain.implementer).toEqual({ agent: "claude", accounts: [A, B], source: "defaults" });
    expect(plain.reviewer).toEqual({ agent: "codex", accounts: [X], source: "defaults" });
    expect(plain.reviewerFallback).toEqual({
      agent: "grok",
      accounts: ["legacy_grok_W1"],
      source: "defaults",
    });
    const override = resolveAccountPolicy(config, "PMDROID/Override")!;
    expect(override.implementer).toEqual({ agent: "claude", accounts: [B], source: "project" });
    expect(override.reviewer).toEqual(plain.reviewer);
    expect(override.revision).not.toBe(plain.revision);
    const switched = resolveAccountPolicy(config, "pmdroid/switch")!;
    expect(switched.implementer).toBeUndefined();
    expect(resolveAgentProfiles(config, "pmdroid/switch").implementer.agent).toBe("codex");
    expect(resolveAccountPolicy(config, "pmdroid/plain")!.revision).toBe(plain.revision);
  });

  test("a project reviewer on the fallback agent drops the fallback and its accounts", () => {
    const { config } = configured({
      ...settings,
      projects: [{ repo: "pmdroid/grok", reviewer: { agent: "grok", model: null } }],
    });
    const policy = resolveAccountPolicy(config, "pmdroid/grok")!;
    expect(policy.reviewer).toBeUndefined();
    expect(policy.reviewerFallback).toBeUndefined();
  });

  test("rejects empty, duplicate, oversized and non-id account lists", () => {
    const parse = (accounts: unknown) =>
      parseAgentSettings({ ...settings, defaults: { ...settings.defaults, accounts } });
    expect(() => parse({ implementer: [] })).toThrow(/at least one account/);
    expect(() => parse({ implementer: [A, A] })).toThrow(/twice/);
    expect(() =>
      parse({ implementer: Array.from({ length: 9 }, (_, i) => `01J000000000000000000000${i}A`) }),
    ).toThrow(/at most 8/);
    for (const reference of [
      "/home/me/.claude",
      "~/.paws/secrets/claude.json",
      "sk-ant-api03-abcdefghijklmnop",
      "Work account",
      "legacy_unknown_W1",
    ])
      expect(() => parse({ implementer: [reference] })).toThrow(/account ids/);
    expect(() => parse({ implementer: [A], token: [A] })).toThrow();
    expect(parse({})).toEqual({
      ...settings,
      defaults: { ...settings.defaults, accounts: undefined },
    });
  });

  test("reviewer fallback accounts need a reviewer fallback profile", () => {
    const { reviewerFallback: _fallback, ...defaults } = settings.defaults;
    expect(() => parseAgentSettings({ ...settings, defaults })).toThrow(
      /reviewer fallback profile/,
    );
    expect(() =>
      parseAgentSettings({
        defaults: settings.defaults,
        projects: [{ repo: "a/b", accounts: { reviewerFallback: [A] } }],
      }),
    ).toThrow();
  });

  test("a different account never satisfies independent review", () => {
    expect(() =>
      parseAgentSettings({
        defaults: {
          implementer: { agent: "claude", model: null },
          reviewer: { agent: "claude", model: null },
          accounts: { implementer: [A], reviewer: [B] },
        },
        projects: [],
      }),
    ).toThrow(/different agents or different models/);
  });

  test("validates references against unknown, removed, disabled and other-agent accounts", () => {
    const accounts: AgentAccountReference[] = [
      { id: A, agent: "claude", enabled: true, removed: false },
      { id: B, agent: "claude", enabled: true, removed: false },
      { id: X, agent: "codex", enabled: true, removed: false },
      { id: "legacy_grok_W1", agent: "grok", enabled: true, removed: false },
    ];
    expect(() => validateAccountReferences(settings, accounts)).not.toThrow();
    const check =
      (list: AgentAccountReference[], next = settings) =>
      () =>
        validateAccountReferences(next, list);
    expect(check(accounts.filter((account) => account.id !== B))).toThrow(/unknown agent account/);
    expect(check(accounts.map((a) => (a.id === A ? { ...a, enabled: false } : a)))).toThrow(
      /disabled/,
    );
    expect(check(accounts.map((a) => (a.id === X ? { ...a, removed: true } : a)))).toThrow(
      /removed/,
    );
    expect(
      check(accounts, {
        ...settings,
        projects: [
          {
            repo: "pmdroid/switch",
            implementer: { agent: "codex", model: "gpt-6" },
            accounts: { implementer: [A] },
          },
        ],
      }),
    ).toThrow(/claude account for a codex profile/);
    expect(
      check([...accounts, { id: C, agent: "codex", enabled: true, removed: false }], {
        ...settings,
        defaults: { ...settings.defaults, accounts: { implementer: [C] } },
      }),
    ).toThrow(/cannot change the agent/);
  });

  test("changing the default implementer agent drops its account list", () => {
    const { path } = configured();
    writeImplementer(path, "opencode");
    const next = readAgentSettings(loadConfigFile(path));
    expect(next.defaults.implementer.agent).toBe("opencode");
    expect(next.defaults.accounts).toEqual({ reviewer: [X], reviewerFallback: ["legacy_grok_W1"] });
  });
});
