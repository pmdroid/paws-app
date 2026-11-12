import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeRunnerReadiness,
  handleAgentSettingsRequest,
  type AgentSettingsOptions,
} from "../src/settings";
import { putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import { workspaceId } from "../src/workspace";
import { loadConfigFile, readAgentSettings, type AgentSettings } from "../src/config";
import { startServer } from "../src/server";
import { seed } from "./dialects";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

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
      merge: { ciFixAttempts: 3 },
      queue: { startTimeoutHours: 24, maxRunningPerOwner: null },
      revision: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(JSON.stringify(body)).not.toContain("/secret/bin");
  });

  test("a save from a stale revision is refused and the newer file is kept", async () => {
    const { options } = fixture();
    writeFileSync(options.configPath, "[caps]\nmax_turns = 31\n");
    const loaded = (await (await handleAgentSettingsRequest(request(), options))!.json()) as {
      revision: string;
    };
    const first = await handleAgentSettingsRequest(
      request(undefined, "PUT", { ...settings, revision: loaded.revision }),
      options,
    );
    expect(first?.status).toBe(200);
    const saved = readFileSync(options.configPath, "utf8");
    const { revision } = (await first!.json()) as { revision: string };
    expect(revision).not.toBe(loaded.revision);
    const stale = await handleAgentSettingsRequest(
      request(undefined, "PUT", {
        ...settings,
        defaults: {
          ...settings.defaults,
          implementer: { agent: "claude", model: "claude-opus-5" },
        },
        revision: loaded.revision,
      }),
      options,
    );
    expect(stale?.status).toBe(409);
    expect(await stale!.json()).toEqual({ error: expect.stringMatching(/changed/), revision });
    expect(readFileSync(options.configPath, "utf8")).toBe(saved);
    const bad = await handleAgentSettingsRequest(
      request(undefined, "PUT", { ...settings, revision: 7 }),
      options,
    );
    expect(bad?.status).toBe(400);
  });

  test("a retired account list is accepted and dropped, so the saved file holds none", async () => {
    const { options } = fixture();
    writeFileSync(
      options.configPath,
      '[agents.defaults.accounts]\nimplementer = ["01J0000000000000000000000A"]\n',
    );
    const saved = await handleAgentSettingsRequest(
      request(undefined, "PUT", {
        ...settings,
        defaults: { ...settings.defaults, accounts: { implementer: ["../../secrets/claude"] } },
      }),
      options,
    );
    expect(saved?.status).toBe(200);
    expect(readFileSync(options.configPath, "utf8")).not.toContain("accounts");
    expect(readAgentSettings(loadConfigFile(options.configPath)).defaults).not.toHaveProperty(
      "accounts",
    );
  });

  test("applyToWaiting is a per-save boolean and is never stored", async () => {
    const { options } = fixture();
    let calls = 0;
    options.applyToWaiting = async () => {
      calls++;
      return 3;
    };
    for (const applyToWaiting of ["true", 1, null]) {
      expect(
        (await handleAgentSettingsRequest(
          request(undefined, "PUT", { ...settings, applyToWaiting }),
          options,
        ))!.status,
      ).toBe(400);
    }
    expect(calls).toBe(0);
    const saved = await handleAgentSettingsRequest(
      request(undefined, "PUT", { ...settings, applyToWaiting: true }),
      options,
    );
    expect(await saved!.json()).toMatchObject({ waitingRuns: 3 });
    expect(calls).toBe(1);
    expect(readFileSync(options.configPath, "utf8")).not.toContain("applyToWaiting");
  });

  test("PUT persists and reloads validated profiles while preserving config", async () => {
    const { options } = fixture();
    writeFileSync(options.configPath, "[caps]\nmax_turns = 31\n");
    const response = await handleAgentSettingsRequest(request(undefined, "PUT", settings), options);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      ...settings,
      merge: { ciFixAttempts: 3 },
      queue: { startTimeoutHours: 24, maxRunningPerOwner: null },
      revision: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(readAgentSettings(loadConfigFile(options.configPath))).toEqual(settings);
    expect(readFileSync(options.configPath, "utf8")).toContain("max_turns = 31");
  });

  test("agent settings carry only CI fix attempts and keep the Merging tables", async () => {
    const { options } = fixture();
    writeFileSync(
      options.configPath,
      '[caps]\nmax_turns = 31\n\n[merge]\nmain_moved = "closeout"\n\n[[merge.rules]]\nlabel = "Bug"\norder = "ci-green"\n',
    );
    for (const merge of [{ closeoutAfterUpdate: true }, { other: true }, true]) {
      const rejected = await handleAgentSettingsRequest(
        request(undefined, "PUT", { ...settings, merge }),
        options,
      );
      expect(rejected?.status).toBe(400);
    }
    const saved = await handleAgentSettingsRequest(
      request(undefined, "PUT", { ...settings, merge: { ciFixAttempts: 4 } }),
      options,
    );
    expect(((await saved!.json()) as { merge: unknown }).merge).toEqual({ ciFixAttempts: 4 });
    const text = readFileSync(options.configPath, "utf8");
    expect(text).toContain('[merge]\nmain_moved = "closeout"\nci_fix_attempts = 4');
    expect(text).toContain('[[merge.rules]]\nlabel = "Bug"\norder = "ci-green"');
    expect(text).toContain("max_turns = 31");
    expect(readAgentSettings(loadConfigFile(options.configPath))).toEqual(settings);
  });

  test("reads and writes CI fix attempts from 0 to 10 and audits each change", async () => {
    const { options } = fixture();
    const audits: [string, string][] = [];
    options.audit = async (action, subject) => {
      audits.push([action, subject]);
    };
    writeFileSync(options.configPath, '[merge]\nmain_moved = "closeout"\n');
    const read = async () =>
      ((await (await handleAgentSettingsRequest(request(), options))!.json()) as { merge: unknown })
        .merge;
    expect(await read()).toEqual({ ciFixAttempts: 3 });

    const put = (merge: unknown) =>
      handleAgentSettingsRequest(request(undefined, "PUT", { ...settings, merge }), options);
    expect((await put({ ciFixAttempts: 5 }))?.status).toBe(200);
    expect(await read()).toEqual({ ciFixAttempts: 5 });
    expect(readFileSync(options.configPath, "utf8")).toContain(
      '[merge]\nmain_moved = "closeout"\nci_fix_attempts = 5',
    );
    expect((await put({ ciFixAttempts: 0 }))?.status).toBe(200);
    expect(await read()).toEqual({ ciFixAttempts: 0 });
    // Saving the same value, or no merge settings, is not a change.
    await put({ ciFixAttempts: 0 });
    await put({});
    expect(await read()).toEqual({ ciFixAttempts: 0 });
    expect(audits).toEqual([
      ["settings.ci-fix-attempts", "CI fix attempts 3 → 5"],
      ["settings.ci-fix-attempts", "CI fix attempts 5 → 0"],
    ]);

    for (const ciFixAttempts of [-1, 11, 2.5, "3", null]) {
      const rejected = await put({ ciFixAttempts });
      expect(rejected?.status).toBe(400);
    }
    expect(await read()).toEqual({ ciFixAttempts: 0 });
    expect(audits).toHaveLength(2);
  });

  test("reads and writes the queue start timeout from 1 to 720 hours and audits each change", async () => {
    const { options } = fixture();
    const audits: [string, string][] = [];
    options.audit = async (action, subject) => {
      audits.push([action, subject]);
    };
    writeFileSync(options.configPath, "[merge]\nci_fix_attempts = 5\n");
    const read = async () =>
      ((await (await handleAgentSettingsRequest(request(), options))!.json()) as { queue: unknown })
        .queue;
    expect(await read()).toEqual({ startTimeoutHours: 24, maxRunningPerOwner: null });

    const put = (queue: unknown) =>
      handleAgentSettingsRequest(request(undefined, "PUT", { ...settings, queue }), options);
    const saved = await put({ startTimeoutHours: 6 });
    expect(saved?.status).toBe(200);
    expect(((await saved!.json()) as { queue: unknown }).queue).toEqual({
      startTimeoutHours: 6,
      maxRunningPerOwner: null,
    });
    expect(await read()).toEqual({ startTimeoutHours: 6, maxRunningPerOwner: null });
    const text = readFileSync(options.configPath, "utf8");
    expect(text).toContain("[queue]\nstart_timeout_hours = 6");
    expect(text).toContain("ci_fix_attempts = 5");
    // Saving profiles or merge settings without the queue keeps the stored value.
    await handleAgentSettingsRequest(
      request(undefined, "PUT", { ...settings, merge: { ciFixAttempts: 4 } }),
      options,
    );
    expect(await read()).toEqual({ startTimeoutHours: 6, maxRunningPerOwner: null });
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
    expect(await read()).toEqual({ startTimeoutHours: 720, maxRunningPerOwner: null });
    expect(audits).toHaveLength(3);
  });

  test("reads, writes and clears the running task cap per owner and audits each change", async () => {
    const { options } = fixture();
    const audits: [string, string][] = [];
    options.audit = async (action, subject) => {
      audits.push([action, subject]);
    };
    const read = async () =>
      ((await (await handleAgentSettingsRequest(request(), options))!.json()) as { queue: unknown })
        .queue;
    const put = (queue: unknown) =>
      handleAgentSettingsRequest(request(undefined, "PUT", { ...settings, queue }), options);

    expect((await put({ maxRunningPerOwner: 3 }))?.status).toBe(200);
    expect(await read()).toEqual({ startTimeoutHours: 24, maxRunningPerOwner: 3 });
    expect(readFileSync(options.configPath, "utf8")).toContain(
      "[queue]\nstart_timeout_hours = 24\nmax_running_per_owner = 3",
    );
    expect((await put({ startTimeoutHours: 6 }))?.status).toBe(200);
    expect(await read()).toEqual({ startTimeoutHours: 6, maxRunningPerOwner: 3 });
    for (const queue of [{ maxRunningPerOwner: 0 }, { maxRunningPerOwner: 2.5 }])
      expect((await put(queue))?.status).toBe(400);
    expect((await put({ maxRunningPerOwner: null }))?.status).toBe(200);
    expect(await read()).toEqual({ startTimeoutHours: 6, maxRunningPerOwner: null });
    expect(readFileSync(options.configPath, "utf8")).not.toContain("max_running_per_owner");
    expect(audits).toEqual([
      ["settings.queue-owner-cap", "Running tasks per owner no cap → 3"],
      ["settings.queue-start-timeout", "Queue start timeout 24 h → 6 h"],
      ["settings.queue-owner-cap", "Running tasks per owner 3 → no cap"],
    ]);
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
      const page = await (await fetch(`${base}/dashboard`)).text();
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

describe("reviewer profile validation", () => {
  const put = (body: unknown, options: AgentSettingsOptions) =>
    handleAgentSettingsRequest(request(undefined, "PUT", body), options);

  test("refuses a reviewer with the implementer's agent and model and keeps the file", async () => {
    const { options } = fixture();
    writeFileSync(options.configPath, "[caps]\nmax_turns = 31\n");
    const same = {
      defaults: {
        implementer: { agent: "claude", model: "opus" },
        reviewer: { agent: "claude", model: "opus" },
      },
      projects: [],
    };
    const response = await put(same, options);
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: "Implementer and reviewer must use different agents or different models",
    });
    const project = await put(
      {
        ...settings,
        projects: [{ repo: "pmdroid/barkvisor", reviewer: settings.defaults.implementer }],
      },
      options,
    );
    expect(project?.status).toBe(400);
    expect(readFileSync(options.configPath, "utf8")).toBe("[caps]\nmax_turns = 31\n");
  });

  test("saves a reviewer that no active runner has signed in, with a warning naming the runners", async () => {
    const { options } = fixture();
    const asked: string[] = [];
    options.runnerReadiness = (agent) => {
      asked.push(agent);
      return agent === "claude"
        ? [{ name: "studio", ready: true }]
        : [
            { name: "laptop", ready: false },
            { name: "studio", ready: false },
          ];
    };
    const response = await put(settings, options);
    expect(response?.status).toBe(200);
    expect(((await response!.json()) as { warnings: unknown }).warnings).toEqual([
      "No active runner has codex signed in and ready to review: laptop, studio.",
    ]);
    expect(asked.sort()).toEqual(["claude", "codex"]);
    expect(readAgentSettings(loadConfigFile(options.configPath))).toEqual(settings);

    options.runnerReadiness = () => [];
    expect(
      ((await (await put(settings, options))!.json()) as { warnings: unknown }).warnings,
    ).toEqual([
      "No active runner can review with codex yet: there is no active runner.",
      "No active runner can review with claude yet: there is no active runner.",
    ]);
  });

  test("a valid reviewer that a runner has ready saves without warnings", async () => {
    const { options } = fixture();
    options.runnerReadiness = () => [{ name: "studio", ready: true }];
    const response = await put(settings, options);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({
      ...settings,
      merge: { ciFixAttempts: 3 },
      queue: { startTimeoutHours: 24, maxRunningPerOwner: null },
      revision: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  test("runner readiness counts only active runners with the agent ready and signed in", async () => {
    const { db, close } = await tempStore();
    const now = Date.now();
    const userId = await putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: "reviewer-owner",
      name: "Owner",
      email: "owner@example.invalid",
    });
    const workspace = workspaceId();
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: workspace, linearOrganizationId: workspace, name: "Review", createdAt: now }),
    );
    await syncWorkspaceMember(db, {
      workspaceId: workspace,
      userId,
      role: "admin",
      active: true,
      teamIds: [],
      now,
    });
    const runner = async (name: string, status: string) => {
      const id = workspaceId();
      await seed(db, (q) =>
        q.orm
          .insert(q.t.runner)
          .values({
            id,
            workspaceId: workspace,
            ownerUserId: userId,
            name,
            status,
            createdAt: now,
          }),
      );
      return id;
    };
    const ready = await runner("ready", "active");
    const expired = await runner("expired", "active");
    await runner("blank", "active");
    const paused = await runner("paused", "paused");
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerAgentPolicy).values([
        { runnerId: ready, agent: "codex", ready: 1 },
        { runnerId: expired, agent: "codex", ready: 1, authExpired: 1 },
        { runnerId: paused, agent: "codex", ready: 1 },
      ]),
    );
    expect(await activeRunnerReadiness(db, "codex")).toEqual([
      { name: "blank", ready: false },
      { name: "expired", ready: false },
      { name: "ready", ready: true },
    ]);
    expect((await activeRunnerReadiness(db, "claude")).every((entry) => !entry.ready)).toBe(true);
    await close();
  });
});
