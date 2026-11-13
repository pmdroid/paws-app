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
const config = () => parseConfigToml(renderAgentSettingsText("", input()));

test("presets round trip with both roles and replace old preset sections", () => {
  const text = renderAgentSettingsText("", input());
  expect(text).toContain('[agents.presets."Opus".implementer]');
  expect(text).toContain('[agents.presets."Opus".reviewer]');
  expect(parseAgentSettingsToml(text, "claude")).toEqual(input());
  expect(parseAgentSettingsToml(renderAgentSettingsText(text, input()), "claude")).toEqual(input());
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
  const text = renderAgentSettingsText("", fast);
  expect(text).toContain(
    '[agents.presets."Fast".implementer]\nagent = "codex"\nmodel = "codex"\nfast = true',
  );
  expect(parseAgentSettingsToml(text, "claude")).toEqual(fast);
  expect(
    parseAgentSettingsToml(
      '[agents.defaults.implementer]\nagent = "claude"\nfast = true\n[agents.defaults.reviewer]\nagent = "codex"',
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
      '[agents.presets.Twin.implementer]\nagent = "codex"\n[agents.presets.Twin.reviewer]\nagent = "codex"\n',
    ),
  ).toThrow("Preset Twin");
});

test("a legacy single-profile preset loads with the default reviewer, else the fallback", () => {
  const defaults = renderAgentSettingsText("", { defaults: settings.defaults });
  const legacy = (agent: string, model: string) =>
    parseAgentSettingsToml(
      `${defaults}\n[agents.presets.Old]\nagent = "${agent}"\nmodel = "${model}"\n`,
      "claude",
    )?.presets?.Old;
  expect(legacy("claude", "opus")).toEqual({
    implementer: { agent: "claude", model: "opus" },
    reviewer: settings.defaults.reviewer,
  });
  expect(legacy("codex", "review")).toEqual({
    implementer: { agent: "codex", model: "review" },
    reviewer: settings.defaults.reviewerFallback,
  });
  const noFallback = renderAgentSettingsText("", {
    defaults: { implementer: settings.defaults.implementer, reviewer: settings.defaults.reviewer },
  });
  expect(() =>
    parseAgentSettingsToml(
      `${noFallback}\n[agents.presets.Old]\nagent = "codex"\nmodel = "review"\n`,
      "claude",
    ),
  ).toThrow("Preset Old");
  const text = `${defaults}\n[agents.presets.Old]\nagent = "claude"\nmodel = "opus"\n`;
  const saved = renderAgentSettingsText(text, parseAgentSettingsToml(text, "claude")!);
  expect(saved).toContain('[agents.presets."Old".reviewer]');
  expect(saved).not.toMatch(/^\[agents\.presets\.Old\]$/m);
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

test("presets alone preserve legacy Codex defaults without weakening explicit profile validation", () => {
  const legacy = '[agents]\nimplementer = "codex"\n';
  const preset = '\n[agents.presets.Opus]\nagent = "claude"\nmodel = "opus"\n';
  const before = resolveAgentProfiles(parseConfigToml(legacy));
  const cfg = parseConfigToml(legacy + preset);
  expect(resolveAgentProfiles(cfg)).toEqual(before);
  expect(cfg.agentSettings?.presets?.Opus).toEqual({
    implementer: { agent: "claude", model: "opus" },
    reviewer: before.reviewer,
  });
  expect(resolveAgentProfiles(cfg, { implementer: "Opus" }).implementer).toEqual({
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
