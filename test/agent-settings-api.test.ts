import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleAgentSettingsRequest, type AgentSettingsOptions } from "../src/settings";
import { loadConfigFile, readAgentSettings, type AgentSettings } from "../src/config";
import { startServer } from "../src/server";
import { tempHome } from "./helpers";

function fixture() {
  const configPath = join(tempHome(), "config.toml");
  const calls: unknown[] = [];
  const options: AgentSettingsOptions = {
    configPath,
    csrfToken: "test-token",
    repos: ["pmdroid/barkvisor"],
    async probe(profile) {
      calls.push(profile);
      return {
        ok: true,
        ...profile,
        models: [{ id: "test-model", name: "Test model" }],
        message: "Connected",
      };
    },
  };
  return { options, calls };
}

const settings: AgentSettings = {
  defaults: {
    implementer: { agent: "grok", model: "grok-4" },
    reviewer: { agent: "codex", model: null },
  },
  projects: [{ repo: "pmdroid/barkvisor", reviewer: { agent: "claude", model: null } }],
};

function request(
  path = "/api/settings/agents",
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
) {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-paws-csrf": "test-token", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("local agent settings API", () => {
  test("GET returns profiles and inherited configured projects without any vendor settings", async () => {
    const { options } = fixture();
    writeFileSync(
      options.configPath,
      '[github]\nrepo = "pmdroid/other"\n[agents.grok]\npath = "/secret/bin"\n',
    );
    const response = await handleAgentSettingsRequest(request(), options);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    const body = await response!.json();
    expect(body).toEqual({
      defaults: {
        implementer: { agent: "claude", model: null },
        reviewer: { agent: "codex", model: null },
      },
      projects: [{ repo: "pmdroid/other" }, { repo: "pmdroid/barkvisor" }],
    });
    expect(JSON.stringify(body)).not.toContain("/secret/bin");
  });

  test("PUT persists and reloads validated profiles while preserving config", async () => {
    const { options } = fixture();
    writeFileSync(options.configPath, "[caps]\nmax_turns = 31\n");
    const response = await handleAgentSettingsRequest(request(undefined, "PUT", settings), options);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual(settings);
    expect(readAgentSettings(loadConfigFile(options.configPath))).toEqual(settings);
    expect(readFileSync(options.configPath, "utf8")).toContain("max_turns = 31");
  });

  test("PUT repairs malformed saved profile sections without changing unrelated config", async () => {
    const { options } = fixture();
    writeFileSync(
      options.configPath,
      '[caps]\nmax_turns = 31\n[agents.defaults.implementer]\nagent = "missing-agent"\n',
    );
    expect((await handleAgentSettingsRequest(request(), options))?.status).toBe(503);
    const saved = await handleAgentSettingsRequest(request(undefined, "PUT", settings), options);
    expect(saved?.status).toBe(200);
    expect(readAgentSettings(loadConfigFile(options.configPath))).toEqual(settings);
    expect(readFileSync(options.configPath, "utf8")).toContain("max_turns = 31");
  });

  test("rejects hostile origins, hosts, missing CSRF, and preflight without writing or probing", async () => {
    const { options, calls } = fixture();
    const hostileHeaders: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "http://127.0.0.1:9000" },
      { origin: "null" },
      { host: "evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "x-paws-csrf": "" },
    ];
    for (const headers of hostileHeaders) {
      const response = await handleAgentSettingsRequest(
        request(undefined, "PUT", settings, headers),
        options,
      );
      expect(response?.status).toBe(403);
      expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await handleAgentSettingsRequest(request(undefined, "OPTIONS"), options))?.status).toBe(
      405,
    );
    expect(
      (
        await handleAgentSettingsRequest(
          new Request("https://public.example/api/settings/agents"),
          options,
        )
      )?.status,
    ).toBe(403);
    expect(existsSync(options.configPath)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("invalid or oversized input cannot execute commands or change config", async () => {
    const { options, calls } = fixture();
    expect(
      (
        await handleAgentSettingsRequest(
          request(undefined, "PUT", { ...settings, path: "/tmp/execute" }),
          options,
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await handleAgentSettingsRequest(
          request(undefined, "PUT", {
            ...settings,
            defaults: {
              implementer: settings.defaults.implementer,
              reviewer: settings.defaults.implementer,
            },
          }),
          options,
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await handleAgentSettingsRequest(
          request("/api/settings/agents/test", "POST", {
            profile: { agent: "grok", model: null, executable: "/tmp/execute" },
          }),
          options,
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await handleAgentSettingsRequest(
          request(undefined, "PUT", { payload: "a".repeat(129 * 1024) }),
          options,
        )
      )?.status,
    ).toBe(400);
    const malformed = new Request("http://127.0.0.1/api/settings/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-paws-csrf": "test-token" },
      body: "{",
    });
    expect((await handleAgentSettingsRequest(malformed, options))?.status).toBe(400);
    expect(existsSync(options.configPath)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("connection test forwards one validated profile and hides thrown credential errors", async () => {
    const { options, calls } = fixture();
    const response = await handleAgentSettingsRequest(
      request("/api/settings/agents/test", "POST", { profile: settings.defaults.implementer }),
      options,
    );
    expect(await response!.json()).toEqual({
      ok: true,
      ...settings.defaults.implementer,
      models: [{ id: "test-model", name: "Test model" }],
      message: "Connected",
    });
    expect(calls).toEqual([settings.defaults.implementer]);
    options.probe = async () => {
      throw new Error("secret-token");
    };
    const failed = await handleAgentSettingsRequest(
      request("/api/settings/agents/test", "POST", { profile: settings.defaults.implementer }),
      options,
    );
    expect(await failed!.json()).toMatchObject({ ok: false, agent: "grok" });
    expect(existsSync(options.configPath)).toBe(false);
  });

  test("live server shares the dashboard CSRF token with settings routes", async () => {
    const { options, calls } = fixture();
    const { csrfToken: _, ...agentSettings } = options;
    const server = startServer({ hostname: "127.0.0.1", port: 0, webhooks: false, agentSettings });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const page = await (await fetch(`${base}/status`)).text();
      const token = /name="paws-csrf" content="([^"]+)"/.exec(page)?.[1];
      expect(token).toBeDefined();
      const saved = await fetch(`${base}/api/settings/agents`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-paws-csrf": token!, origin: base },
        body: JSON.stringify(settings),
      });
      expect(saved.status).toBe(200);
      expect(saved.headers.get("access-control-allow-origin")).toBeNull();
      const probe = await fetch(`${base}/api/settings/agents/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paws-csrf": token!, origin: base },
        body: JSON.stringify({ profile: settings.defaults.implementer }),
      });
      expect(probe.status).toBe(200);
      expect(calls).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});
