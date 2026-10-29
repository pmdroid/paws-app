import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROK_AGENT_ARGS, GROK_LOGIN_MESSAGE } from "../src/acp";
import type { FakeResult } from "../src/acp/testing/script";
import type { AgentsConfig } from "../src/config";
import { emptyConfigFile } from "../src/config";
import {
  appEventsFact,
  doctorChecks,
  formatDoctor,
  GITHUB_APP_EVENTS,
  realProbe,
  type DoctorProbe,
  type GitHubDoctorFacts,
  type ProbeFacts,
} from "../src/doctor";
import { LINEAR_WEBHOOK_FIX } from "../src/db";
import { grokLoginStatus } from "../src/install";
import { migratedDatabase } from "./helpers";

const NAMES = [
  "git",
  "bun",
  "home",
  "linear",
  "linear-workspace",
  "linear-team",
  "github-app",
  "github-app-installation",
  "github-app-push",
  "github-rate",
  "github-app-events",
  "claude-acp",
  "codex-acp",
  "claude",
  "codex",
  "closeout",
  "repository",
];

test("doctor reports the local prerequisites and skips webhook checks", () => {
  const checks = doctorChecks(probe(true));
  expect(checks.map((item) => item.name)).toEqual(NAMES);
  expect(checks.every((item) => item.ok)).toBe(true);
  const text = formatDoctor(checks);
  expect(text.startsWith("paws doctor\n")).toBe(true);
  expect(text).toContain("ok claude:");
  expect(text).toContain("ok github-app: app 99 configured");
  expect(text).toContain("ok github-app-installation: installation 22 on pmdroid/paws-demo");
  expect(text).toContain("ok github-app-push: push access to pmdroid/paws-demo");
  expect(text).not.toContain("token-store");
  expect(text).not.toContain("github-auth");
  expect(text).not.toContain("ngrok");
  expect(text).not.toContain("linear-webhook");
  expect(text).not.toContain("public-url");
  expect(text).not.toContain("BEGIN OPENSSH");
  expect(text).not.toContain("\n  fix:");
});

test("doctor reports whether the exe.dev token is present and readable", () => {
  const exeDev = (status: ProbeFacts["exeDevToken"]) => {
    const ready = probe(true);
    if (status !== undefined) ready.facts.exeDevToken = status;
    return doctorChecks(ready).find((item) => item.name === "exe-dev");
  };
  expect(exeDev(undefined)).toBeUndefined();
  expect(exeDev("readable")).toEqual({
    name: "exe-dev",
    ok: true,
    detail: "token present and readable",
  });
  expect(exeDev("absent")).toMatchObject({ ok: true, note: true });
  for (const status of ["empty", "unreadable"] as const) {
    const item = exeDev(status);
    expect(item?.ok).toBe(false);
    expect(item?.fix).toContain("~/.paws/secrets/exe-dev-token");
  }
});

test("doctor reports the Tailscale auth key like the exe.dev token", () => {
  const tailscale = (status: ProbeFacts["tailscaleAuthKey"], publicUrl?: string) => {
    const ready = probe(true);
    if (status !== undefined) ready.facts.tailscaleAuthKey = status;
    if (publicUrl !== undefined) ready.facts.publicUrl = publicUrl;
    return doctorChecks(ready).find((item) => item.name === "tailscale-authkey");
  };
  expect(tailscale(undefined)).toBeUndefined();
  expect(tailscale("readable")).toEqual({
    name: "tailscale-authkey",
    ok: true,
    detail: "auth key present and readable",
  });
  expect(tailscale("absent", "https://paws.example.com")).toMatchObject({ ok: true, note: true });
  const tailnet = tailscale("absent", "https://agentbox.taile07e4.ts.net:8787");
  expect(tailnet?.ok).toBe(false);
  expect(tailnet?.fix).toContain("~/.paws/secrets/tailscale-authkey");
  for (const status of ["empty", "unreadable"] as const) {
    const item = tailscale(status);
    expect(item?.ok).toBe(false);
    expect(item?.fix).toContain("tag:paws-runner");
  }
});

test("doctor fails without a Linear workspace and says how to configure one", () => {
  const unconfigured = probe(true);
  delete unconfigured.env.PAWS_PUBLIC_DASHBOARD;
  const checks = doctorChecks(unconfigured);
  const workspace = checks.find((item) => item.name === "linear-workspace");
  expect(workspace?.ok).toBe(false);
  expect(workspace?.fix).toContain("PAWS_PUBLIC_DASHBOARD=1");
  expect(workspace?.fix).toContain("docs/workspace-access.md");
  expect(formatDoctor(checks)).toContain("missing linear-workspace:");
});

test("doctor fails while no Linear workspace admin has signed in", () => {
  const pending = probe(true);
  pending.facts.workspace = null;
  const workspace = doctorChecks(pending).find((item) => item.name === "linear-workspace");
  expect(workspace?.ok).toBe(false);
  expect(workspace?.detail).toContain("signed in");
});

test("doctor names what is missing and does not print secret values", () => {
  const checks = doctorChecks(
    probe(
      false,
      {
        LINEAR_WEBHOOK_SECRET: "whsec_do_not_print",
        GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/missing.pem",
      },
      { webhooks: true },
    ),
  );
  expect(checks.every((item) => item.ok)).toBe(false);
  const text = formatDoctor(checks);
  expect(text).toContain("missing linear:");
  expect(text).toContain("missing github-app:");
  expect(text).toContain("ok linear-webhook:");
  expect(text).not.toContain("ngrok");
  expect(text).not.toContain("linear-mode");
  expect(text).toContain("missing public-url:");
  expect(text).toContain(".agents/closeout.yaml: invalid YAML");
  expect(checks.filter((item) => !item.ok).every((item) => item.fix !== undefined)).toBe(true);
  expect(text).not.toContain("whsec_do_not_print");
});

test("doctor warns when Linear may have disabled the webhook and says how to re-enable it", () => {
  const ready = probe(true);
  ready.facts.webhooks = true;
  ready.facts.linearWebhook = null;
  expect(doctorChecks(ready).find((item) => item.name === "linear-webhook-delivery")?.ok).toBe(
    true,
  );
  ready.facts.linearWebhook = { reason: "missed", lastVerifiedMs: 1000, missedMs: 2000 };
  const text = formatDoctor(doctorChecks(ready));
  expect(text).toContain(
    "missing linear-webhook-delivery: Linear may have disabled the Paws webhook: the catch-up poll found events no webhook delivered.",
  );
  expect(text).toContain(`  fix: ${LINEAR_WEBHOOK_FIX}`);
  ready.facts.webhooks = false;
  expect(formatDoctor(doctorChecks(ready))).not.toContain("linear-webhook-delivery");
});

test("doctor shows whether GitHub webhook deliveries arrive", () => {
  const waiting = probe(true);
  waiting.env.GITHUB_WEBHOOK_SECRET = "github-secret";
  const missing = doctorChecks(waiting).find((item) => item.name === "github-webhook");
  expect(missing).toMatchObject({
    ok: false,
    detail: "no signed GitHub webhook delivery has arrived",
  });
  expect(missing?.fix).toContain("Merge groups");
  waiting.facts.githubDelivery = { event: "check_suite", receivedAt: Date.UTC(2026, 9, 23, 9) };
  expect(doctorChecks(waiting).find((item) => item.name === "github-webhook")).toMatchObject({
    ok: true,
    detail: "last check_suite delivery at 2026-10-23T09:00:00.000Z",
  });
  expect(doctorChecks(probe(true)).map((item) => item.name)).not.toContain("github-webhook");
});

test("doctor passes Closeout without a checkout and loads configured local policies", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-doctor-policy-"));
  const db = migratedDatabase(join(home, "paws.db"));
  db.run("INSERT INTO sync_cursor (name, cursor_ms) VALUES ('linear:webhook', 1000)");
  db.run("INSERT INTO sync_cursor (name, cursor_ms) VALUES ('linear:webhook-missed', 2000)");
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
  db.run("INSERT INTO workspace_repository VALUES('workspace','acme/widgets','team_a')");
  db.run("INSERT INTO workspace_repository VALUES('workspace','acme/widgets','team_b')");
  db.run("INSERT INTO workspace_repository VALUES('workspace','acme/api','team_a')");
  db.close();
  const env = { HOME: home, PAWS_HOME: home, PATH: process.env.PATH ?? "" };
  const ready = await realProbe(env);
  expect(ready.facts.linearWebhook).toEqual({
    reason: "missed",
    lastVerifiedMs: 1000,
    missedMs: 2000,
  });
  expect(ready.facts.repos).toEqual(["acme/api", "acme/widgets"]);
  expect(ready.facts.closeout).toEqual({
    ok: true,
    detail: "policy loads from each repository's origin/main on the runner",
    fix: null,
  });

  const localRoot = join(home, "policies");
  mkdirSync(join(localRoot, ".agents"), { recursive: true });
  writeFileSync(join(localRoot, ".agents/closeout.yaml"), 'specVersion: "0.1"\nitems: []\n');
  writeFileSync(
    join(home, "config.toml"),
    '[closeout.projects."acme/widgets"]\npolicy_root = "policies"\n',
  );
  expect((await realProbe(env)).facts.closeout).toEqual({
    ok: true,
    detail: "local policy loads for acme/widgets",
    fix: null,
  });
  writeFileSync(join(localRoot, ".agents/closeout.yaml"), "invalid");
  const broken = await realProbe(env);
  expect(broken.facts.closeout).toMatchObject({
    ok: false,
    detail: "configured local Closeout policy for acme/widgets is invalid",
  });
  expect(broken.facts.closeout.fix?.includes("\n")).toBe(false);
  const lines = formatDoctor(doctorChecks(broken)).split("\n");
  const index = lines.findIndex((line) => line.startsWith("missing closeout:"));
  expect(lines[index]).toBe(
    "missing closeout: configured local Closeout policy for acme/widgets is invalid",
  );
  expect(lines[index + 1]).toBe(`  fix: ${broken.facts.closeout.fix}`);
}, 30_000);

test("doctor names the chosen repositories and fails when none is chosen", () => {
  const ready = probe(true);
  ready.facts.repos = ["acme/api", "acme/widgets"];
  expect(doctorChecks(ready).find((item) => item.name === "repository")).toMatchObject({
    ok: true,
    detail: "acme/api, acme/widgets",
  });
  ready.facts.repos = [];
  expect(doctorChecks(ready).find((item) => item.name === "repository")).toMatchObject({
    ok: false,
    detail: "no repository is chosen",
  });
});

test("bun run paws doctor exits nonzero until prerequisites exist", async () => {
  const home = mkdtempSync(join(tmpdir(), "paws-doctor-"));
  const proc = Bun.spawn([process.execPath, "src/index.ts", "doctor"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const diagnostics = stderr.trim().split("\n");
  expect(diagnostics.length).toBeGreaterThan(0);
  for (const line of diagnostics) {
    expect(line).toStartWith("catch item=none operation=");
    expect(line).toContain("code=ENOENT");
    expect(line).toContain("expected=prerequisite may be absent");
  }
  expect(stdout).toContain("paws doctor");
  expect(stdout).toContain("missing linear:");
  expect(code).toBe(1);
});

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

test("doctor is green with no claude when the implementer is grok", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-doctor-grok-"));
  const scriptPath = join(root, "script.json");
  const resultPath = join(root, "result.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({ authMethods: [{ id: "cached_token", name: "Cached login" }], steps: [] }),
  );
  const agents: AgentsConfig = {
    implementer: "grok",
    grok: { path: null, allowApiKey: false },
  };
  const status = await grokLoginStatus({
    agents,
    command: process.execPath,
    args: [fakeAgent, resultPath, scriptPath, ...GROK_AGENT_ARGS],
    env: {
      ...process.env,
    },
  });
  expect(status.loggedIn).toBe(true);
  expect(status.detail).toBe("cached_token");
  expect(status.args).toEqual([fakeAgent, resultPath, scriptPath, ...GROK_AGENT_ARGS]);
  expect(status.args.join(" ")).not.toContain("yolo");
  expect(status.args.join(" ")).not.toContain("always-approve");
  const trace = JSON.parse(await Bun.file(resultPath).text()) as FakeResult;
  expect(trace.methods).toEqual(["initialize"]);
  expect(trace.argv).toEqual([...GROK_AGENT_ARGS]);
  const ready = probe(true);
  const checks = doctorChecks(
    {
      ...ready,
      facts: {
        ...ready.facts,
        claudeAdapter: { ok: false, detail: "claude-agent-acp is not installed" },
        claudeLogin: { ok: false, detail: "claude is not installed" },
      },
    },
    { config: { agents }, grok: status },
  );
  expect(checks.every((item) => item.ok)).toBe(true);
  const text = formatDoctor(checks);
  expect(text).toContain("ok grok: cached_token");
  expect(text).toContain("note claude: not required by configured agent profiles");
  expect(text).toContain("note claude-acp: not required by configured agent profiles");
  expect(text).toContain("ok codex:");
  expect(text).not.toContain("missing");
});

test("doctor requires providers used by either default role and project overrides", () => {
  const config = emptyConfigFile();
  config.agentSettings = {
    defaults: {
      implementer: { agent: "claude", model: "model-a" },
      reviewer: { agent: "claude", model: "model-b" },
    },
    projects: [],
  };
  const ready = probe(true);
  ready.facts.codexAdapter = { ok: false, detail: "Codex adapter absent" };
  ready.facts.codexLogin = { ok: false, detail: "Codex login absent" };
  const defaults = doctorChecks(ready, { config });
  expect(defaults.every((item) => item.ok)).toBe(true);
  expect(defaults.find((item) => item.name === "codex")?.note).toBe(true);
  config.agentSettings.projects.push({
    repo: "pmdroid/barkvisor",
    reviewer: { agent: "grok", model: null },
  });
  const missingGrok = doctorChecks(ready, { config });
  expect(missingGrok.find((item) => item.name === "grok")?.ok).toBe(false);
  expect(missingGrok.find((item) => item.name === "codex")?.note).toBe(true);
  config.agentSettings.projects.push({
    repo: "pmdroid/paws-app",
    implementer: { agent: "codex", model: null },
  });
  const missingBoth = doctorChecks(ready, { config });
  expect(missingBoth.filter((item) => !item.ok).map((item) => item.name)).toEqual([
    "codex-acp",
    "grok",
    "codex",
  ]);
});

test("doctor uses role profiles and Grok status carried by the real probe", () => {
  const ready = probe(true);
  ready.facts.agentProfiles = [
    { implementer: { agent: "grok", model: null }, reviewer: { agent: "claude", model: null } },
  ];
  ready.facts.grokLogin = {
    installed: true,
    loggedIn: true,
    authMethods: ["cached_token"],
    detail: "cached_token",
    args: [],
  };
  ready.facts.codexAdapter = { ok: false, detail: "unused" };
  ready.facts.codexLogin = { ok: false, detail: "unused" };
  const checks = doctorChecks(ready);
  expect(checks.every((item) => item.ok)).toBe(true);
  expect(checks.find((item) => item.name === "grok")?.detail).toBe("cached_token");
  expect(checks.find((item) => item.name === "codex")?.note).toBe(true);
});

test("doctor requires Linear credentials alongside the GitHub App checks", () => {
  const ready = probe(true);
  ready.facts = {
    ...ready.facts,
    team: null,
    teamId: null,
    linear: {
      attempted: false,
      reachable: false,
      viewerId: null,
      viewerMatches: false,
      teamFound: false,
      error: null,
    },
  };
  const checks = doctorChecks(ready);
  expect(checks.find((item) => item.name === "linear")?.ok).toBe(false);
  const names = checks.map((item) => item.name);
  for (const name of ["github-app", "github-app-installation", "github-app-push", "linear"])
    expect(names).toContain(name);
  for (const name of ["github-auth", "github-token-store", "gh-login", "gh-push"])
    expect(names).not.toContain(name);
  expect(formatDoctor(checks)).not.toContain("ghs_");
});

test("missing App credentials are one actionable line that names the GitHub App doc", () => {
  const ready = probe(true);
  ready.facts = { ...ready.facts, githubDoctor: { ...githubReady(), appId: null } };
  const checks = doctorChecks(ready);
  const text = formatDoctor(checks);
  const missing = text.split("\n").filter((line) => line.startsWith("missing"));
  expect(missing).toEqual(["missing github-app: GitHub App id is required"]);
  expect(text).toContain("docs/github-app.md");
  expect(checks.map((item) => item.name)).not.toContain("github-app-installation");
  expect(text).not.toContain("login github");
});

test("a missing installation or push access fails with the App fix", () => {
  const notInstalled = probe(true);
  notInstalled.facts = {
    ...notInstalled.facts,
    githubDoctor: {
      ...githubReady(),
      installation: { ok: false, detail: "the GitHub App is not installed on pmdroid/paws-demo" },
      push: { ok: false, detail: "GitHub App installation was not checked" },
    },
  };
  const installation = doctorChecks(notInstalled).find(
    (item) => item.name === "github-app-installation",
  );
  expect(installation?.ok).toBe(false);
  expect(installation?.fix).toContain("Settings > Integrations");

  const readOnly = probe(true);
  readOnly.facts = {
    ...readOnly.facts,
    githubDoctor: {
      ...githubReady(),
      push: { ok: false, detail: "no push access to pmdroid/paws-demo" },
    },
  };
  const push = doctorChecks(readOnly).find((item) => item.name === "github-app-push");
  expect(push?.ok).toBe(false);
  expect(push?.fix).toContain("Contents, Pull requests and Issues write");
});

test("a GitHub App without the comment and review events is reported", () => {
  const facts = appEventsFact(200, {
    events: ["check_run", "check_suite", "status", "pull_request", "merge_group", "push"],
  });
  expect(facts).toEqual({
    ok: false,
    detail: "not subscribed to pull_request_review, pull_request_review_comment, issue_comment",
  });
  expect(appEventsFact(200, { events: [...GITHUB_APP_EVENTS] }).ok).toBe(true);
  expect(appEventsFact(401, {}).ok).toBe(false);

  const missing = probe(true);
  missing.facts = { ...missing.facts, githubDoctor: { ...githubReady(), events: facts } };
  const events = doctorChecks(missing).find((item) => item.name === "github-app-events");
  expect(events?.ok).toBe(false);
  expect(events?.fix).toContain("Pull request review comment, Issue comment");
});

test("doctor fails with one actionable line when grok has no auth method", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-doctor-nologin-"));
  const scriptPath = join(root, "script.json");
  const resultPath = join(root, "result.json");
  writeFileSync(scriptPath, JSON.stringify({ authMethods: [], steps: [{ type: "hang" }] }));
  const agents: AgentsConfig = {
    implementer: "grok",
    grok: { path: null, allowApiKey: false },
  };
  const status = await grokLoginStatus({
    agents,
    command: process.execPath,
    args: [fakeAgent, resultPath, scriptPath, ...GROK_AGENT_ARGS],
    env: {
      ...process.env,
    },
    timeoutMs: 5_000,
  });
  expect(status.loggedIn).toBe(false);
  expect(status.detail).toBe(GROK_LOGIN_MESSAGE);
  const checks = doctorChecks(probe(true), {
    config: { agents },
    grok: status,
  });
  const missing = formatDoctor(checks)
    .split("\n")
    .filter((line) => line.startsWith("missing"));
  expect(missing).toEqual([`missing grok: ${GROK_LOGIN_MESSAGE}`]);
});

function probe(
  ok: boolean,
  env: Record<string, string> = {},
  facts: Partial<ProbeFacts> = {},
): DoctorProbe {
  const ready = ok
    ? {
        PAWS_PUBLIC_DASHBOARD: "1",
      }
    : env;
  return {
    env: { HOME: "/tmp/paws-home", ...ready },
    bunVersion: ok ? "1.4.2" : null,
    facts: ok ? greenFacts() : redFacts(facts),
    which(bin) {
      return ok ? `/usr/bin/${bin}` : null;
    },
    stat() {
      return ok ? { mode: 0o100600 } : null;
    },
    canWrite() {
      return ok;
    },
  };
}

function githubReady(): GitHubDoctorFacts {
  return {
    appId: "99",
    installationId: "22",
    privateKeyPath: "/tmp/paws-home/.paws/secrets/github-app.pem",
    installation: { ok: true, detail: "installation 22 on pmdroid/paws-demo" },
    push: { ok: true, detail: "push access to pmdroid/paws-demo" },
    rate: { ok: true, detail: "4800 remaining" },
    events: { ok: true, detail: "subscribed to 8 events Paws uses" },
  };
}

function greenFacts(): ProbeFacts {
  return {
    configError: null,
    configured: true,
    trackerKind: "linear",
    githubDoctor: githubReady(),
    webhooks: false,
    workspace: "Paws Demo",
    publicUrl: null,
    repos: ["pmdroid/paws-demo"],
    team: "ENG",
    teamId: "team_eng",
    claudeAdapter: { ok: true, detail: "claude-agent-acp 0.88.0" },
    codexAdapter: { ok: true, detail: "codex-acp 2.1.1" },
    claudeLogin: { ok: true, detail: "claude.ai" },
    codexLogin: { ok: true, detail: "logged in" },
    closeout: { ok: true, detail: "policy loads on origin/main", fix: null },
    linear: {
      attempted: true,
      reachable: true,
      viewerId: "viewer_1",
      viewerMatches: true,
      teamFound: true,
      error: null,
    },
  };
}

function redFacts(override: Partial<ProbeFacts>): ProbeFacts {
  return {
    configError: null,
    configured: false,
    trackerKind: "linear",
    githubDoctor: {
      appId: null,
      installationId: null,
      privateKeyPath: "/tmp/missing.pem",
      installation: { ok: false, detail: "GitHub App credentials are missing" },
      push: { ok: false, detail: "GitHub App installation was not checked" },
      rate: { ok: false, detail: "rate limit was not read" },
      events: { ok: false, detail: "GitHub App events were not read" },
    },
    webhooks: false,
    publicUrl: null,
    repos: [],
    team: null,
    teamId: null,
    claudeAdapter: { ok: false, detail: "claude-agent-acp is not installed" },
    codexAdapter: { ok: false, detail: "codex-acp is not installed" },
    claudeLogin: { ok: false, detail: "claude auth login" },
    codexLogin: { ok: false, detail: "codex login" },
    closeout: {
      ok: false,
      detail: "policy on origin/main is malformed",
      fix: ".agents/closeout.yaml: invalid YAML",
    },
    linear: {
      attempted: false,
      reachable: false,
      viewerId: null,
      viewerMatches: false,
      teamFound: false,
      error: null,
    },
    ...override,
  };
}
