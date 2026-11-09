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
