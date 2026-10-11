import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyConfigFile,
  loadConfigFile,
  parseAgentSettings,
  readAgentSettings,
  resolveAgentProfiles,
  writeAgentSettings,
  writeConfigFile,
  writeImplementer,
  type AgentSettings,
} from "../src/config";
import { tempHome } from "./helpers";

const settings: AgentSettings = {
  defaults: {
    implementer: { agent: "claude", model: "claude-sonnet-4-5" },
    reviewer: { agent: "codex", model: null },
  },
  projects: [{ repo: "pmdroid/barkvisor", reviewer: { agent: "grok", model: "grok-4" } }],
};

describe("agent settings config", () => {
  test("legacy implementer remains the default and reviewer inherits Codex", () => {
    const config = emptyConfigFile();
    config.agents.implementer = "grok";
    expect(readAgentSettings(config).defaults.implementer).toEqual({ agent: "grok", model: null });
    expect(resolveAgentProfiles(config, "any/repo").reviewer).toEqual({
      agent: "codex",
      model: null,
    });
  });

  test("writes valid TOML, preserves other config and private permissions, and resolves overrides", () => {
    const path = join(tempHome(), "config.toml");
    const original =
      '[github]\nauth = "gh"\nrepo = "pmdroid/barkvisor"\n\n[agents]\nimplementer = "grok"\n\n[agents.grok]\npath = "/local/grok"\nallow_api_key = false\n\n[caps]\nmax_turns = 12\n';
    writeFileSync(path, original, { mode: 0o600 });
    writeAgentSettings(path, settings);
    const text = readFileSync(path, "utf8");
    expect(Bun.TOML.parse(text)).toMatchObject({
      agents: { implementer: "claude", grok: { path: "/local/grok", allow_api_key: false } },
      caps: { max_turns: 12 },
    });
    expect(text).toContain('[github]\nauth = "gh"\nrepo = "pmdroid/barkvisor"');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const config = loadConfigFile(path);
    expect(readAgentSettings(config)).toEqual(settings);
    expect(resolveAgentProfiles(config, "PMDROID/BARKVISOR")).toEqual({
      implementer: settings.defaults.implementer,
      reviewer: { agent: "grok", model: "grok-4" },
    });
    expect(resolveAgentProfiles(config, "elsewhere/project")).toEqual(settings.defaults);
    writeAgentSettings(path, settings);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("removes overrides and persists explicit inheritance rows", () => {
    const path = join(tempHome(), "config.toml");
    writeAgentSettings(path, settings);
    const next = { ...settings, projects: [{ repo: "pmdroid/barkvisor" }] };
    writeAgentSettings(path, next);
    expect(readAgentSettings(loadConfigFile(path))).toEqual(next);
    expect(readFileSync(path, "utf8")).not.toContain('model = "grok-4"');
  });

  test("validates duplicate repos, model values, and effective reviewer independence before writing", () => {
    expect(() => parseAgentSettings({ ...settings, executable: "/tmp/evil" })).toThrow();
    expect(() => parseAgentSettings({ ...settings, projects: [{ repo: "../repo" }] })).toThrow();
    expect(() =>
      parseAgentSettings({ ...settings, projects: [{ repo: "a/b" }, { repo: "A/B" }] }),
    ).toThrow(/Duplicate project/);
    const same = { agent: "codex", model: null };
    const invalid = {
      defaults: { implementer: same, reviewer: same },
      projects: [],
    } as AgentSettings;
    const path = join(tempHome(), "config.toml");
    writeFileSync(path, "[caps]\nmax_turns = 10\n");
    expect(() => writeAgentSettings(path, invalid)).toThrow(/different/);
    expect(readFileSync(path, "utf8")).toBe("[caps]\nmax_turns = 10\n");
    expect(() =>
      parseAgentSettings({
        ...settings,
        projects: [{ repo: "a/b", reviewer: settings.defaults.implementer }],
      }),
    ).toThrow(/different/);
    expect(() =>
      parseAgentSettings({
        ...settings,
        defaults: { ...settings.defaults, implementer: { agent: "claude", model: "bad\nmodel" } },
      }),
    ).toThrow();
  });

  test("legacy implementer selection updates the profile and resets a changed vendor model", () => {
    const path = join(tempHome(), "config.toml");
    writeAgentSettings(path, settings);
    writeImplementer(path, "claude");
    expect(readAgentSettings(loadConfigFile(path))).toEqual(settings);
    writeImplementer(path, "grok");
    expect(resolveAgentProfiles(loadConfigFile(path)).implementer).toEqual({
      agent: "grok",
      model: null,
    });
    expect(readAgentSettings(loadConfigFile(path)).projects).toEqual(settings.projects);
    const before = readFileSync(path, "utf8");
    expect(() => writeImplementer(path, "codex")).toThrow(/different/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("rerunning setup preserves explicit profiles and project overrides", () => {
    const path = join(tempHome(), "config.toml");
    writeAgentSettings(path, settings);
    const setup = {
      linearMode: "comments" as const,
      linearTeam: "ENG",
      linearTeamId: "team-eng",
      linearViewerId: "viewer",
      linearSecret: "secrets/linear-api-key",
      linearClientFile: null,
      githubAuth: "gh" as const,
      repo: "pmdroid/barkvisor",
      checkout: "/tmp/checkout",
      maxTurns: 40,
      maxAwakeMs: 1_000,
      implementer: "claude" as const,
    };
    expect(writeConfigFile(path, setup)).toBe(true);
    expect(readAgentSettings(loadConfigFile(path))).toEqual(settings);
    expect(writeConfigFile(path, setup)).toBe(false);
    writeConfigFile(path, { ...setup, implementer: "grok" });
    expect(resolveAgentProfiles(loadConfigFile(path)).implementer).toEqual({
      agent: "grok",
      model: null,
    });
    expect(readAgentSettings(loadConfigFile(path)).projects).toEqual(settings.projects);
  });

  test("normalizes repo names and allows different explicit models on one provider", () => {
    const parsed = parseAgentSettings({
      defaults: {
        implementer: { agent: "codex", model: "model-a" },
        reviewer: { agent: "codex", model: "model-b" },
      },
      projects: [{ repo: "PMDROID/BarkVisor" }],
    });
    expect(parsed.projects[0]?.repo).toBe("pmdroid/barkvisor");
  });
});
