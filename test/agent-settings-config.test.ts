import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  emptyConfigFile,
  loadConfigFile,
  parseAgentSettings,
  readAgentSettings,
  readConfigText,
  resolveAgentProfiles,
  useMemorySettings,
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
  test("persists role effort", async () => {
    const path = join(tempHome(), "config.toml");
    useMemorySettings(path);
    const next: AgentSettings = {
      defaults: {
        implementer: { ...settings.defaults.implementer, effort: "high" },
        reviewer: { agent: "codex", model: "another-model", effort: "xhigh" },
      },
    };
    await writeAgentSettings(path, next);
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

  test("writes valid TOML and saves the same settings again", async () => {
    const path = join(tempHome(), "config.toml");
    useMemorySettings(path, '[agents]\nimplementer = "grok"\n');
    await writeAgentSettings(path, settings);
    const text = readConfigText(path);
    expect(Bun.TOML.parse(text)).toMatchObject({ agents: { implementer: "claude" } });
    const config = loadConfigFile(path);
    expect(readAgentSettings(config)).toEqual(settings);
    expect(resolveAgentProfiles(config)).toEqual(settings.defaults);
    await writeAgentSettings(path, settings);
    expect(Bun.TOML.parse(readConfigText(path))).toEqual(Bun.TOML.parse(text));
  });

  test("keeps inline comments on the legacy implementer setting", async () => {
    const path = join(tempHome(), "config.toml");
    useMemorySettings(path, '[agents]\nimplementer = "grok" # selected locally\n');
    await writeAgentSettings(path, settings);
    expect(readConfigText(path)).toContain('implementer = "claude" # selected locally');
  });

  test("validates model values and reviewer independence before writing", async () => {
    expect(() => parseAgentSettings({ ...settings, executable: "/tmp/evil" })).toThrow();
    expect(() => parseAgentSettings({ ...settings, projects: [] })).toThrow();
    expect(() =>
      parseAgentSettings({ defaults: { ...settings.defaults, accounts: ["work"] } }),
    ).toThrow();
    const same = { agent: "codex", model: null };
    const invalid = {
      defaults: { implementer: same, reviewer: same },
    } as AgentSettings;
    const path = join(tempHome(), "config.toml");
    useMemorySettings(path, '[agents]\nimplementer = "grok"\n');
    await expect(writeAgentSettings(path, invalid)).rejects.toThrow(/different/);
    expect(readConfigText(path)).toBe('[agents]\nimplementer = "grok"\n');
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

  test("keeps an optional reviewer fallback that is independent of the implementer", async () => {
    const path = join(tempHome(), "config.toml");
    useMemorySettings(path);
    const next: AgentSettings = {
      defaults: {
        implementer: { agent: "codex", model: "gpt-6.1-sol" },
        reviewer: { agent: "claude", model: "opus" },
        reviewerFallback: { agent: "codex", model: "gpt-6-sol" },
      },
    };
    await writeAgentSettings(path, next);
    expect(readConfigText(path)).toContain(
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
