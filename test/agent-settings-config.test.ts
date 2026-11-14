import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyConfigFile,
  journalRetiredAgentProjects,
  loadConfigFile,
  parseAgentSettings,
  readAgentSettings,
  readConfigText,
  resolveAgentProfiles,
  useSettingsStore,
  writeAgentSettings,
  type AgentSettings,
} from "../src/config";
import { tempHome } from "./helpers";

const settings: AgentSettings = {
  defaults: {
    implementer: { agent: "claude", model: "claude-sonnet-4-5" },
    reviewer: { agent: "codex", model: null },
  },
};

describe("agent settings config", () => {
  test("persists role effort", () => {
    const path = join(tempHome(), "config.toml");
    const next: AgentSettings = {
      defaults: {
        implementer: { ...settings.defaults.implementer, effort: "high" },
        reviewer: { agent: "codex", model: "another-model", effort: "xhigh" },
      },
    };
    writeAgentSettings(path, next);
    expect(readAgentSettings(loadConfigFile(path))).toEqual(next);
    expect(resolveAgentProfiles(loadConfigFile(path)).reviewer.effort).toBe("xhigh");
    expect(() =>
      parseAgentSettings({
        ...next,
        defaults: {
          ...next.defaults,
          implementer: { ...next.defaults.implementer, effort: "bad\neffort" },
        },
      }),
    ).toThrow();
    expect(() =>
      parseAgentSettings({
        ...next,
        defaults: {
          implementer: { agent: "codex", model: null, effort: "low" },
          reviewer: { agent: "codex", model: null, effort: "high" },
        },
      }),
    ).toThrow(/different/);
  });
  test("legacy implementer remains the default and reviewer inherits Codex", () => {
    const config = emptyConfigFile();
    config.agents.implementer = "grok";
    expect(readAgentSettings(config).defaults.implementer).toEqual({ agent: "grok", model: null });
    expect(resolveAgentProfiles(config).reviewer).toEqual({
      agent: "codex",
      model: null,
    });
  });

  test("writes valid TOML, preserves other config and private permissions", () => {
    const path = join(tempHome(), "config.toml");
    const original =
      '[github]\nauth = "app"\nrepo = "pmdroid/barkvisor"\n\n[agents]\nimplementer = "grok"\n\n[agents.grok]\npath = "/local/grok"\nallow_api_key = false\n\n[caps]\nmax_turns = 12\n';
    writeFileSync(path, original, { mode: 0o600 });
    writeAgentSettings(path, settings);
    const text = readFileSync(path, "utf8");
    expect(Bun.TOML.parse(text)).toMatchObject({
      agents: { implementer: "claude", grok: { path: "/local/grok", allow_api_key: false } },
      caps: { max_turns: 12 },
    });
    expect(text).toContain('[github]\nauth = "app"\nrepo = "pmdroid/barkvisor"');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const config = loadConfigFile(path);
    expect(readAgentSettings(config)).toEqual(settings);
    expect(resolveAgentProfiles(config)).toEqual(settings.defaults);
    writeAgentSettings(path, settings);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("keeps inline comments on the legacy implementer setting", () => {
    const path = join(tempHome(), "config.toml");
    writeFileSync(path, '[agents]\nimplementer = "grok" # selected locally\n');
    writeAgentSettings(path, settings);
    expect(readFileSync(path, "utf8")).toContain('implementer = "claude" # selected locally');
  });

  test("a retired agents.projects table loads, uses the global profiles and journals once", () => {
    const path = join(tempHome(), "config.toml");
    writeAgentSettings(path, settings);
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n[agents.projects."acme/app".reviewer]\nagent = "grok"\nmodel = "grok-4"\n`,
    );
    const config = loadConfigFile(path);
    expect(readAgentSettings(config)).toEqual(settings);
    expect(resolveAgentProfiles(config)).toEqual(settings.defaults);
    const lines: string[] = [];
    journalRetiredAgentProjects(path, (line) => lines.push(line));
    expect(lines).toEqual(["agents.projects is no longer supported; using the global profiles"]);
    writeAgentSettings(path, settings);
    expect(readFileSync(path, "utf8")).not.toContain("agents.projects");
    lines.length = 0;
    journalRetiredAgentProjects(path, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  test("a retired agents.projects table in the file is journalled after the Settings page saved to the database", async () => {
    const path = join(tempHome(), "config.toml");
    writeFileSync(path, '[agents.projects."acme/app".reviewer]\nagent = "grok"\n');
    let stored: string | null =
      '[agents.defaults.implementer]\nagent = "claude"\n[agents.defaults.reviewer]\nagent = "codex"\n';
    const saved = await useSettingsStore(path, {
      read: async () => stored,
      update: async (change) => {
        stored = change(stored);
      },
    });
    try {
      expect(readConfigText(path)).not.toContain("agents.projects");
      const lines: string[] = [];
      journalRetiredAgentProjects(path, (line) => lines.push(line));
      expect(lines).toEqual(["agents.projects is no longer supported; using the global profiles"]);
    } finally {
      saved.release();
    }
  });

  test("a config with only a retired agents.projects table keeps the legacy defaults", () => {
    const path = join(tempHome(), "config.toml");
    writeFileSync(
      path,
      '[agents]\nimplementer = "grok"\n[agents.projects."acme/app".implementer]\nagent = "claude"\n',
    );
    const config = loadConfigFile(path);
    expect(config.agentSettings).toBeUndefined();
    expect(resolveAgentProfiles(config)).toEqual({
      implementer: { agent: "grok", model: null },
      reviewer: { agent: "codex", model: null },
    });
  });

  test("validates model values and reviewer independence before writing", () => {
    expect(() => parseAgentSettings({ ...settings, executable: "/tmp/evil" })).toThrow();
    expect(() => parseAgentSettings({ ...settings, projects: [] })).toThrow();
    const same = { agent: "codex", model: null };
    const invalid = {
      defaults: { implementer: same, reviewer: same },
    } as AgentSettings;
    const path = join(tempHome(), "config.toml");
    writeFileSync(path, "[caps]\nmax_turns = 10\n");
    expect(() => writeAgentSettings(path, invalid)).toThrow(/different/);
    expect(readFileSync(path, "utf8")).toBe("[caps]\nmax_turns = 10\n");
    expect(() =>
      parseAgentSettings({
        ...settings,
        defaults: { ...settings.defaults, implementer: { agent: "claude", model: "bad\nmodel" } },
      }),
    ).toThrow();
  });

  test("allows different explicit models on one provider", () => {
    const parsed = parseAgentSettings({
      defaults: {
        implementer: { agent: "codex", model: "model-a" },
        reviewer: { agent: "codex", model: "model-b" },
      },
    });
    expect(parsed.defaults.reviewer.model).toBe("model-b");
  });

  test("keeps an optional reviewer fallback that is independent of the implementer", () => {
    const path = join(tempHome(), "config.toml");
    const next: AgentSettings = {
      defaults: {
        implementer: { agent: "codex", model: "gpt-6.1-sol" },
        reviewer: { agent: "claude", model: "opus" },
        reviewerFallback: { agent: "codex", model: "gpt-6-sol" },
      },
    };
    writeAgentSettings(path, next);
    expect(readFileSync(path, "utf8")).toContain(
      '[agents.defaults.reviewer_fallback]\nagent = "codex"\nmodel = "gpt-6-sol"',
    );
    expect(readAgentSettings(loadConfigFile(path))).toEqual(next);
    expect(resolveAgentProfiles(loadConfigFile(path)).reviewerFallback).toEqual({
      agent: "codex",
      model: "gpt-6-sol",
    });
    expect(() =>
      parseAgentSettings({
        ...next,
        defaults: { ...next.defaults, reviewerFallback: { agent: "codex", model: "gpt-6.1-sol" } },
      }),
    ).toThrow(/different/);
    expect(() =>
      parseAgentSettings({
        ...next,
        defaults: { ...next.defaults, reviewerFallback: { agent: "claude", model: "sonnet" } },
      }),
    ).toThrow(/fallback/);
    expect(resolveAgentProfiles(loadConfigFile(join(tempHome(), "none.toml")))).not.toHaveProperty(
      "reviewerFallback",
    );
  });
});
