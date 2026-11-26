import { expect, test } from "bun:test";
import {
  agentsSection,
  parseAgentSettings,
  parseAgentSettingsSection,
  resolveAgentProfiles,
} from "./agents";
import { configFromSections, parseConfigToml } from "./file";

const settings = {
  defaults: {
    implementer: { agent: "claude", model: "default" },
    reviewer: { agent: "codex", model: "review" },
    reviewerFallback: { agent: "grok", model: "fallback" },
  },
  presets: {
    Opus: {
      implementer: { agent: "claude", model: "opus", effort: "high" },
      reviewer: { agent: "codex", model: "review" },
    },
    Codex: {
      implementer: { agent: "codex", model: "codex" },
      reviewer: { agent: "claude", model: "sonnet" },
    },
  },
} as const;
const input = () => parseAgentSettings(settings);
const config = () => configFromSections({ agents: agentsSection(undefined, input()) });

test("presets round trip with both roles and replace old preset sections", () => {
  const section = agentsSection(undefined, input());
  expect(Object.keys(section["presets"] as object)).toEqual(["Opus", "Codex"]);
  expect(parseAgentSettingsSection(section, "claude")).toEqual(input());
  expect(parseAgentSettingsSection(agentsSection(section, input()), "claude")).toEqual(input());
});

test("fast = true parses, renders and round trips on a profile", () => {
  const fast = parseAgentSettings({
    ...settings,
    presets: {
      Fast: {
        implementer: { agent: "codex", model: "codex", fast: true },
        reviewer: { agent: "claude", model: "opus" },
      },
    },
  });
  const section = agentsSection(undefined, fast);
  expect((section["presets"] as Record<string, unknown>)["Fast"]).toMatchObject({
    implementer: { agent: "codex", model: "codex", fast: true },
  });
  expect(parseAgentSettingsSection(section, "claude")).toEqual(fast);
  expect(
    parseAgentSettingsSection(
      { defaults: { implementer: { agent: "claude", fast: true }, reviewer: { agent: "codex" } } },
      "claude",
    )?.defaults.implementer,
  ).toEqual({ agent: "claude", model: null, fast: true });
  expect(() =>
    parseAgentSettings({
      ...settings,
      presets: {
        X: { ...settings.presets.Opus, implementer: { agent: "codex", model: null, fast: "on" } },
      },
    }),
  ).toThrow();
});

test("a preset label in either group sets both roles, ignoring case and surrounding spaces", () => {
  for (const labels of [{ implementer: " opus " }, { reviewer: "Opus" }]) {
    const result = resolveAgentProfiles(config(), labels);
    expect(result.implementer).toEqual(settings.presets.Opus.implementer);
    expect(result.reviewer).toEqual(settings.presets.Opus.reviewer);
    expect(result.labelProblems).toEqual([]);
  }
  expect(resolveAgentProfiles(config(), { implementer: "Codex", reviewer: "codex" })).toMatchObject(
    { ...settings.presets.Codex, labelProblems: [] },
  );
});

test("unknown labels retain inherited profiles and report the original label", () => {
  expect(resolveAgentProfiles(config(), { implementer: "Nope" })).toMatchObject({
    implementer: settings.defaults.implementer,
    reviewer: settings.defaults.reviewer,
    labelProblems: [{ role: "implementer", label: "Nope", reason: "unknown_preset" }],
  });
});

test("two different preset labels are conflicting_presets and keep the defaults", () => {
  expect(resolveAgentProfiles(config(), { implementer: "Opus", reviewer: "Codex" })).toEqual({
    ...settings.defaults,
    labelProblems: [
      { role: "implementer", label: "Opus", reason: "conflicting_presets" },
      { role: "reviewer", label: "Codex", reason: "conflicting_presets" },
    ],
  });
});

test("fallback is filtered against the preset's roles; no labels preserve the old shape", () => {
  const cfg = config();
  cfg.agentSettings!.presets!.Grok = {
    implementer: { agent: "claude", model: "x" },
    reviewer: { agent: "grok", model: "review" },
  };
  expect(resolveAgentProfiles(cfg, { reviewer: "Grok" }).reviewerFallback).toBeUndefined();
  expect(resolveAgentProfiles(cfg, { reviewer: "Opus" }).reviewerFallback).toEqual(
    settings.defaults.reviewerFallback,
  );
  expect(resolveAgentProfiles(cfg)).toEqual(settings.defaults);
});

test("a preset whose two roles match is refused with its name", () => {
  const same = { agent: "claude", model: "opus" } as const;
  expect(() =>
    parseAgentSettings({ ...settings, presets: { Twin: { implementer: same, reviewer: same } } }),
  ).toThrow("Preset Twin: Implementer and reviewer must use different agents or different models");
  expect(() =>
    parseConfigToml(
      '[agents.defaults.implementer]\nagent = "claude"\n[agents.defaults.reviewer]\nagent = "codex"\n[agents.presets.Twin.implementer]\nagent = "codex"\n[agents.presets.Twin.reviewer]\nagent = "codex"\n',
    ),
  ).toThrow("Preset Twin");
});

test("preset names and profiles are validated, including duplicates after trimming", () => {
  for (const name of ["", " ", "x".repeat(41), "bad/name"]) {
    expect(() =>
      parseAgentSettings({ ...settings, presets: { [name]: settings.presets.Opus } }),
    ).toThrow();
  }
  for (const name of ["opus", " Opus "]) {
    expect(() =>
      parseAgentSettings({
        ...settings,
        presets: { ...settings.presets, [name]: settings.presets.Opus },
      }),
    ).toThrow("Duplicate preset");
  }
  expect(() =>
    parseAgentSettings({
      ...settings,
      presets: { Bad: { ...settings.presets.Opus, implementer: { agent: "unknown", model: "x" } } },
    }),
  ).toThrow();
});
