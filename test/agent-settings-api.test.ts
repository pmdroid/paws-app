import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleAgentSettingsRequest, type AgentSettingsOptions } from "../src/settings";
import { loadConfigFile, readAgentSettings, type AgentSettings } from "../src/config";
import { startServer } from "../src/server";
import { tempHome } from "./helpers";

function fixture() {
  const configPath = join(tempHome(), "config.toml");
  const options: AgentSettingsOptions = {
    configPath,
    csrfToken: "test-token",
    repos: ["pmdroid/barkvisor"],
  };
  return { options };
}

const settings: AgentSettings = {
  defaults: {
    implementer: { agent: "grok", model: "grok-4", effort: "high" },
    reviewer: { agent: "codex", model: null },
  },
  projects: [
    { repo: "pmdroid/barkvisor", reviewer: { agent: "claude", model: null, effort: "low" } },
  ],
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
      '[github]\nrepo = "pmdroid/other"\nrepos = ["pmdroid/library", "pmdroid/other"]\n[agents.grok]\npath = "/secret/bin"\n',
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
      projects: [
        { repo: "pmdroid/other" },
        { repo: "pmdroid/library" },
        { repo: "pmdroid/barkvisor" },
      ],
      merge: { closeoutAfterUpdate: false, ciFixAttempts: 3 },
      queue: { startTimeoutHours: 24 },
    });
    expect(JSON.stringify(body)).not.toContain("/secret/bin");
  });

  test("PUT persists and reloads validated profiles while preserving config", async () => {
    const { options } = fixture();
    writeFileSync(options.configPath, "[caps]\nmax_turns = 31\n");
    const response = await handleAgentSettingsRequest(request(undefined, "PUT", settings), options);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      ...settings,
      merge: { closeoutAfterUpdate: false, ciFixAttempts: 3 },
      queue: { startTimeoutHours: 24 },
    });
    expect(readAgentSettings(loadConfigFile(options.configPath))).toEqual(settings);
    expect(readFileSync(options.configPath, "utf8")).toContain("max_turns = 31");
  });

  test("reads and writes the Closeout after update switch, and a missing key means off", async () => {
    const { options } = fixture();
    writeFileSync(options.configPath, "[caps]\nmax_turns = 31\n");
    const read = async () =>
      ((await (await handleAgentSettingsRequest(request(), options))!.json()) as { merge: unknown })
        .merge;
    expect(await read()).toEqual({ closeoutAfterUpdate: false, ciFixAttempts: 3 });

    const on = await handleAgentSettingsRequest(
      request(undefined, "PUT", { ...settings, merge: { closeoutAfterUpdate: true } }),
      options,
    );
    expect(on?.status).toBe(200);
    expect(((await on!.json()) as { merge: unknown }).merge).toEqual({
      closeoutAfterUpdate: true,
      ciFixAttempts: 3,
    });
    expect(readFileSync(options.configPath, "utf8")).toContain(
      "[merge]\ncloseout_after_update = true",
    );
    expect(await read()).toEqual({ closeoutAfterUpdate: true, ciFixAttempts: 3 });

    // Saving profiles without the switch keeps the stored value.
    await handleAgentSettingsRequest(request(undefined, "PUT", settings), options);
    expect(await read()).toEqual({ closeoutAfterUpdate: true, ciFixAttempts: 3 });

    await handleAgentSettingsRequest(
      request(undefined, "PUT", { ...settings, merge: { closeoutAfterUpdate: false } }),
      options,
    );
    expect(await read()).toEqual({ closeoutAfterUpdate: false, ciFixAttempts: 3 });
    const text = readFileSync(options.configPath, "utf8");
    expect(text.match(/\[merge\]/g)).toHaveLength(1);
    expect(text).toContain("max_turns = 31");
    expect(readAgentSettings(loadConfigFile(options.configPath))).toEqual(settings);

    for (const merge of [{ closeoutAfterUpdate: "yes" }, { other: true }, true]) {
      const rejected = await handleAgentSettingsRequest(
        request(undefined, "PUT", { ...settings, merge }),
        options,
      );
      expect(rejected?.status).toBe(400);
    }
    expect(await read()).toEqual({ closeoutAfterUpdate: false, ciFixAttempts: 3 });
  });

  test("reads and writes CI fix attempts from 0 to 10 and audits each change", async () => {
    const { options } = fixture();
    const audits: [string, string][] = [];
    options.audit = (action, subject) => audits.push([action, subject]);
    writeFileSync(options.configPath, "[merge]\ncloseout_after_update = true\n");
    const read = async () =>
      ((await (await handleAgentSettingsRequest(request(), options))!.json()) as { merge: unknown })
        .merge;
    expect(await read()).toEqual({ closeoutAfterUpdate: true, ciFixAttempts: 3 });

    const put = (merge: unknown) =>
      handleAgentSettingsRequest(request(undefined, "PUT", { ...settings, merge }), options);
    expect((await put({ ciFixAttempts: 5 }))?.status).toBe(200);
    expect(await read()).toEqual({ closeoutAfterUpdate: true, ciFixAttempts: 5 });
    expect(readFileSync(options.configPath, "utf8")).toContain(
      "[merge]\ncloseout_after_update = true\nci_fix_attempts = 5",
    );
    expect((await put({ closeoutAfterUpdate: true, ciFixAttempts: 0 }))?.status).toBe(200);
    expect(await read()).toEqual({ closeoutAfterUpdate: true, ciFixAttempts: 0 });
    // Saving the same value, or only the switch, is not a change.
    await put({ closeoutAfterUpdate: false, ciFixAttempts: 0 });
    await put({ closeoutAfterUpdate: true });
    expect(await read()).toEqual({ closeoutAfterUpdate: true, ciFixAttempts: 0 });
    expect(audits).toEqual([
      ["settings.ci-fix-attempts", "CI fix attempts 3 → 5"],
      ["settings.ci-fix-attempts", "CI fix attempts 5 → 0"],
    ]);

    for (const ciFixAttempts of [-1, 11, 2.5, "3", null]) {
      const rejected = await put({ ciFixAttempts });
      expect(rejected?.status).toBe(400);
    }
    expect(await read()).toEqual({ closeoutAfterUpdate: true, ciFixAttempts: 0 });
    expect(audits).toHaveLength(2);
  });

  test("reads and writes the queue start timeout from 1 to 720 hours and audits each change", async () => {
    const { options } = fixture();
    const audits: [string, string][] = [];
    options.audit = (action, subject) => audits.push([action, subject]);
    writeFileSync(options.configPath, "[merge]\nci_fix_attempts = 5\n");
    const read = async () =>
      ((await (await handleAgentSettingsRequest(request(), options))!.json()) as { queue: unknown })
        .queue;
    expect(await read()).toEqual({ startTimeoutHours: 24 });

    const put = (queue: unknown) =>
      handleAgentSettingsRequest(request(undefined, "PUT", { ...settings, queue }), options);
    const saved = await put({ startTimeoutHours: 6 });
    expect(saved?.status).toBe(200);
    expect(((await saved!.json()) as { queue: unknown }).queue).toEqual({ startTimeoutHours: 6 });
    expect(await read()).toEqual({ startTimeoutHours: 6 });
    const text = readFileSync(options.configPath, "utf8");
    expect(text).toContain("[queue]\nstart_timeout_hours = 6");
    expect(text).toContain("ci_fix_attempts = 5");
    // Saving profiles or merge settings without the queue keeps the stored value.
    await handleAgentSettingsRequest(
      request(undefined, "PUT", { ...settings, merge: { ciFixAttempts: 4 } }),
      options,
    );
    expect(await read()).toEqual({ startTimeoutHours: 6 });
    expect((await put({ startTimeoutHours: 720 }))?.status).toBe(200);
    await put({ startTimeoutHours: 720 });
    expect(readFileSync(options.configPath, "utf8").match(/\[queue\]/g)).toHaveLength(1);
    expect(audits).toEqual([
      ["settings.queue-start-timeout", "Queue start timeout 24 h → 6 h"],
      ["settings.ci-fix-attempts", "CI fix attempts 5 → 4"],
      ["settings.queue-start-timeout", "Queue start timeout 6 h → 720 h"],
    ]);

    for (const queue of [
      { startTimeoutHours: 0 },
      { startTimeoutHours: 721 },
      { startTimeoutHours: 1.5 },
      { startTimeoutHours: "24" },
      { other: 1 },
      24,
    ]) {
      expect((await put(queue))?.status).toBe(400);
    }
    expect(await read()).toEqual({ startTimeoutHours: 720 });
    expect(audits).toHaveLength(3);
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

  test("rejects hostile origins, hosts, missing CSRF, and preflight without writing", async () => {
    const { options } = fixture();
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
  });

  test("invalid or oversized input cannot change config or probe an agent", async () => {
    const { options } = fixture();
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
      await handleAgentSettingsRequest(
        request("/api/settings/agents/test", "POST", {
          profile: { agent: "grok", model: null, executable: "/tmp/execute" },
        }),
        options,
      ),
    ).toBeNull();
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
  });

  test("live server shares the dashboard CSRF token with settings routes", async () => {
    const { options } = fixture();
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
      expect(probe.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
