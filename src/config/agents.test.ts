import { expect, test } from "bun:test";
import {
  parseAgentSettings,
  parseAgentSettingsToml,
  renderAgentSettingsText,
  resolveAgentProfiles,
} from "./agents";
import { parseConfigToml } from "./file";

const settings = {
  defaults: {
    implementer: { agent: "claude", model: "default" },
    reviewer: { agent: "codex", model: "review" },
    reviewerFallback: { agent: "grok", model: "fallback" },
  },
  projects: [{ repo: "acme/app", reviewer: { agent: "codex", model: "project" } }],
  presets: {
    Opus: { agent: "claude", model: "opus", effort: "high" },
    Codex: { agent: "codex", model: "codex" },
  },
} as const;
const input = () => parseAgentSettings(settings);
const config = () => parseConfigToml(renderAgentSettingsText("", input()));

test("presets round trip with profiles and replace old preset sections", () => {
  const text = renderAgentSettingsText("", input());
  expect(parseAgentSettingsToml(text, "claude")).toEqual(input());
  expect(parseAgentSettingsToml(renderAgentSettingsText(text, input()), "claude")).toEqual(input());
  expect(
    parseAgentSettingsToml('[agents.presets.Opus]\nagent = "claude"\nmodel = "opus"', "claude")
      ?.presets?.Opus?.model,
  ).toBe("opus");
});

test("labels override each role independently, ignoring case and surrounding spaces", () => {
  const result = resolveAgentProfiles(config(), "acme/app", { implementer: " opus " });
  expect(result.implementer).toEqual(settings.presets.Opus);
  expect(result.reviewer).toEqual(settings.projects[0].reviewer);
  expect(result.labelProblems).toEqual([]);
  expect(resolveAgentProfiles(config(), "acme/app", { reviewer: "Codex" }).reviewer).toEqual(
    settings.presets.Codex,
  );
});

test("unknown labels retain inherited profiles and report the original label", () => {
  expect(resolveAgentProfiles(config(), "acme/app", { implementer: "Nope" })).toMatchObject({
    implementer: settings.defaults.implementer,
    labelProblems: [{ role: "implementer", label: "Nope", reason: "unknown_preset" }],
  });
});

test("a reviewer preset matching the resolved implementer reports a problem", () => {
  expect(
    resolveAgentProfiles(config(), "acme/app", { implementer: "Opus", reviewer: "opus" }),
  ).toMatchObject({
    reviewer: settings.projects[0].reviewer,
    labelProblems: [{ role: "reviewer", label: "opus", reason: "same_as_implementer" }],
  });
});

test("fallback is filtered against the label-resolved reviewer; no labels preserve the old shape", () => {
  const cfg = config();
  cfg.agentSettings!.presets!.Grok = { agent: "grok", model: "review" };
  expect(
    resolveAgentProfiles(cfg, "acme/app", { reviewer: "Grok" }).reviewerFallback,
  ).toBeUndefined();
  expect(resolveAgentProfiles(cfg, "acme/app")).toEqual({
    ...settings.defaults,
    reviewer: settings.projects[0].reviewer,
  });
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
    parseAgentSettings({ ...settings, presets: { Bad: { agent: "unknown", model: "x" } } }),
  ).toThrow();
});

test("an implementer label cannot match an inherited project or global reviewer", () => {
  for (const repo of ["acme/app", "acme/other"]) {
    const cfg = config();
    const inherited = resolveAgentProfiles(cfg, repo);
    cfg.agentSettings!.presets!.Same = { ...inherited.reviewer, effort: "high" };
    expect(resolveAgentProfiles(cfg, repo, { implementer: "Same" })).toEqual({
      ...inherited,
      labelProblems: [{ role: "implementer", label: "Same", reason: "same_as_implementer" }],
    });
  }
});

test("rejecting a reviewer label also checks the inherited reviewer against the implementer", () => {
  const cfg = config();
  cfg.agentSettings!.presets!.Same = settings.projects[0].reviewer;
  const result = resolveAgentProfiles(cfg, "acme/app", { implementer: "Same", reviewer: "Same" });
  expect(result.implementer).toEqual(settings.defaults.implementer);
  expect(result.reviewer).toEqual(settings.projects[0].reviewer);
  expect(result.labelProblems).toHaveLength(2);
});

test("fallback cannot review a matching label-selected implementer, but a different model can", () => {
  const cfg = config();
  cfg.agentSettings!.presets!.Grok = { ...settings.defaults.reviewerFallback };
  expect(
    resolveAgentProfiles(cfg, "acme/app", { implementer: "Grok" }).reviewerFallback,
  ).toBeUndefined();
  cfg.agentSettings!.presets!.Grok.model = "another-model";
  expect(resolveAgentProfiles(cfg, "acme/app", { implementer: "Grok" }).reviewerFallback).toEqual(
    settings.defaults.reviewerFallback,
  );
});

test("presets alone preserve legacy Codex defaults without weakening explicit profile validation", () => {
  const legacy = '[agents]\nimplementer = "codex"\n';
  const preset = '\n[agents.presets.Opus]\nagent = "claude"\nmodel = "opus"\n';
  const before = resolveAgentProfiles(parseConfigToml(legacy), "acme/app");
  const cfg = parseConfigToml(legacy + preset);
  expect(resolveAgentProfiles(cfg, "acme/app")).toEqual(before);
  expect(cfg.agentSettings?.presets?.Opus).toEqual({ agent: "claude", model: "opus" });
  expect(resolveAgentProfiles(cfg, "acme/app", { implementer: "Opus" }).implementer).toEqual({
    agent: "claude",
    model: "opus",
  });
  expect(() =>
    parseConfigToml(legacy + preset + '\n[agents.defaults.implementer]\nagent = "codex"\n'),
  ).toThrow("Implementer and reviewer");
  expect(() => parseAgentSettings(cfg.agentSettings)).toThrow("Implementer and reviewer");
  expect(() =>
    parseConfigToml(legacy + preset.replace('agent = "claude"', 'agent = "invalid"')),
  ).toThrow();
  expect(() => parseConfigToml(legacy + preset + preset.replace("Opus", "opus"))).toThrow(
    "Duplicate preset",
  );
});
