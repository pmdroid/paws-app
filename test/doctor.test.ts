import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROK_AGENT_ARGS, GROK_LOGIN_MESSAGE } from "../src/acp";
import type { FakeResult } from "../src/acp/testing/script";
import type { AgentsConfig } from "../src/config";
import { emptyConfigFile, PAWS_GITHUB_OAUTH_CLIENT_ID } from "../src/config";
import { FILE_TOKEN_STORE_DOCTOR_WARNING, MISSING_GITHUB_CLIENT_ID_MESSAGE } from "../src/auth";
import {
  doctorChecks,
  formatDoctor,
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
  "linear-mode",
  "linear-workspace",
  "linear-team",
  "gh-login",
  "gh-push",
  "claude-acp",
  "codex-acp",
  "claude",
  "codex",
  "closeout",
  "repository",
];

test("doctor reports the local prerequisites and skips tunnel checks", () => {
  const checks = doctorChecks(probe(true));
  expect(checks.map((item) => item.name)).toEqual(NAMES);
  expect(checks.every((item) => item.ok)).toBe(true);
  const text = formatDoctor(checks);
  expect(text.startsWith("paws doctor\n")).toBe(true);
  expect(text).toContain("ok claude:");
  expect(text).toContain("ok gh-login:");
  expect(text).not.toContain("ngrok");
  expect(text).not.toContain("linear-webhook");
  expect(text).not.toContain("public-url");
  expect(text).not.toContain("github-app");
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

test("doctor fails when comment mode is configured and says how to move off it", () => {
  const configured = probe(true);
  configured.facts.linearCommentMode = true;
  const mode = doctorChecks(configured).find((item) => item.name === "linear-mode");
  expect(mode?.ok).toBe(false);
  expect(mode?.fix).toContain("comment mode");
  expect(mode?.fix).toContain("docs/workspace-access.md");
  expect(formatDoctor(doctorChecks(configured))).toContain("missing linear-mode:");
});

test("doctor names what is missing and does not print secret values", () => {
  const checks = doctorChecks(
    probe(
      false,
      {
        LINEAR_WEBHOOK_SECRET: "whsec_do_not_print",
        GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/missing.pem",
      },
      { webhooks: true, githubAuth: "app" },
    ),
  );
  expect(checks.every((item) => item.ok)).toBe(false);
  const text = formatDoctor(checks);
  expect(text).toContain("missing linear:");
  expect(text).toContain("missing github-app:");
  expect(text).toContain("ok linear-webhook:");
  expect(text).toContain("missing ngrok:");
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

test("doctor loads the closeout policy from origin/main", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-doctor-policy-"));
  const bare = join(root, "origin.git");
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(home);
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", bare, repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "paws-test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Paws Test"]);
  execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  mkdirSync(join(repo, ".agents"), { recursive: true });
  const policy = join(repo, ".agents", "closeout.yaml");
  writeFileSync(
    policy,
    'specVersion: "0.1"\nitems:\n  - id: test\n    kind: command\n    gate: beforePR\n    exec: ["true"]\n    timeoutSeconds: 30\n',
  );
  execFileSync("git", ["-C", repo, "add", ".agents/closeout.yaml"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "policy"]);
  execFileSync("git", ["-C", repo, "push", "origin", "HEAD:main"]);
  const db = migratedDatabase(join(home, "paws.db"));
  db.run("INSERT INTO sync_cursor (name, cursor_ms) VALUES ('linear:webhook', 1000)");
  db.run("INSERT INTO sync_cursor (name, cursor_ms) VALUES ('linear:webhook-missed', 2000)");
  db.close();
  const env = { HOME: home, PAWS_HOME: home, PAWS_CHECKOUT: repo, PATH: process.env.PATH ?? "" };
  const ready = await realProbe(env);
  expect(ready.facts.linearWebhook).toEqual({
    reason: "missed",
    lastVerifiedMs: 1000,
    missedMs: 2000,
  });
  expect(ready.facts.closeout).toEqual({
    ok: true,
    detail: "policy loads on origin/main",
    fix: null,
  });

  writeFileSync(policy, 'specVersion: "0.1"\nitems: [\n');
  execFileSync("git", ["-C", repo, "add", ".agents/closeout.yaml"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "malformed"]);
  execFileSync("git", ["-C", repo, "push", "origin", "HEAD:main"]);
  const broken = await realProbe(env);
  expect(broken.facts.closeout.ok).toBe(false);
  expect(broken.facts.closeout.detail).toBe("policy on origin/main is malformed");
  expect(broken.facts.closeout.fix?.includes("\n")).toBe(false);
  expect(broken.facts.closeout.fix?.length).toBeGreaterThan(0);
  const text = formatDoctor(doctorChecks(broken));
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.startsWith("missing closeout:"));
  expect(lines[index]).toBe("missing closeout: policy on origin/main is malformed");
  expect(lines[index + 1]).toBe(`  fix: ${broken.facts.closeout.fix}`);
  expect(lines.filter((line) => line.startsWith("missing closeout:"))).toHaveLength(1);
  const localRoot = join(home, "policies");
  mkdirSync(join(localRoot, ".agents"), { recursive: true });
  writeFileSync(join(localRoot, ".agents/closeout.yaml"), 'specVersion: "0.1"\nitems: []\n');
  writeFileSync(
    join(home, "config.toml"),
    '[github]\nrepo = "acme/widgets"\n[closeout.projects."acme/widgets"]\npolicy_root = "policies"\n',
  );
  const local = await realProbe(env);
  expect(local.facts.closeout).toEqual({
    ok: true,
    detail: `local policy loads from ${localRoot}`,
    fix: null,
  });
  writeFileSync(join(localRoot, ".agents/closeout.yaml"), "invalid");
  expect((await realProbe(env)).facts.closeout).toMatchObject({
    ok: false,
    detail: "configured local Closeout policy is invalid",
  });
}, 30_000);

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
  expect(stderr).toBe("");
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

test("doctor requires Linear credentials even with GitHub OAuth", () => {
  const ready = probe(true);
  ready.facts = {
    ...ready.facts,
    trackerKind: "linear",
    githubAuth: "oauth",
    oauthClientId: "Iv1.real-client",
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
    githubDoctor: githubReady(),
  };
  const checks = doctorChecks(ready);
  expect(checks.find((item) => item.name === "linear")?.ok).toBe(false);
  const names = checks.map((item) => item.name);
  expect(names).toContain("github-auth");
  expect(names).toContain("github-push");
  expect(names).not.toContain("github-label");
  expect(names).toContain("github-rate");
  expect(names).toContain("github-token-store");
  expect(names).toContain("linear");
  expect(names).toContain("linear-mode");
  expect(names).toContain("linear-team");
  expect(names).not.toContain("gh-login");
  expect(names).not.toContain("gh-push");
  const text = formatDoctor(checks);
  expect(text).toContain("ok github-auth: signed in as octocat");
  expect(text).toContain("ok github-rate: 4800 remaining");
  expect(text).toContain("ok github-token-store: keychain");
  expect(text).toContain("missing linear:");
  expect(text).not.toContain("gho_");
});

test("a placeholder GitHub client id is one actionable line", () => {
  const ready = probe(true);
  ready.facts = {
    ...ready.facts,
    trackerKind: "linear",
    githubAuth: "oauth",
    oauthClientId: PAWS_GITHUB_OAUTH_CLIENT_ID,
    githubDoctor: { ...githubReady(), placeholder: true },
  };
  const checks = doctorChecks(ready);
  const missing = formatDoctor(checks)
    .split("\n")
    .filter((line) => line.startsWith("missing"));
  expect(missing).toEqual([`missing github-auth: ${MISSING_GITHUB_CLIENT_ID_MESSAGE}`]);
  expect(formatDoctor(checks)).toContain(`fix: ${MISSING_GITHUB_CLIENT_ID_MESSAGE}`);
  expect(formatDoctor(checks)).not.toContain("login github");
  expect(formatDoctor(checks)).not.toContain(PAWS_GITHUB_OAUTH_CLIENT_ID);

  const empty = probe(true);
  empty.facts = {
    ...ready.facts,
    trackerKind: "linear",
    githubAuth: "oauth",
    oauthClientId: "",
    githubDoctor: { ...githubReady(), placeholder: false },
  };
  expect(formatDoctor(doctorChecks(empty))).toContain(MISSING_GITHUB_CLIENT_ID_MESSAGE);
});

test("a file token store is a note and does not fail doctor", () => {
  const ready = probe(true);
  ready.facts = {
    ...ready.facts,
    trackerKind: "linear",
    githubAuth: "oauth",
    oauthClientId: "Iv1.real-client",
    githubDoctor: {
      ...githubReady(),
      storeKind: "file",
      storeWarning: FILE_TOKEN_STORE_DOCTOR_WARNING,
    },
  };
  const checks = doctorChecks(ready);
  expect(checks.every((item) => item.ok)).toBe(true);
  const text = formatDoctor(checks);
  expect(text).toContain("note github-token-store:");
  expect(text).toContain("github-oauth.json");
  expect(text).not.toContain("missing");
});

test("Linear tracking keeps independent GitHub OAuth checks", () => {
  const ready = probe(true);
  ready.facts = {
    ...ready.facts,
    trackerKind: "linear",
    githubAuth: "oauth",
    oauthClientId: "Iv1.real-client",
    githubDoctor: githubReady(),
  };
  const names = doctorChecks(ready).map((item) => item.name);
  expect(names).toContain("linear");
  expect(names).toContain("github-auth");
  expect(names).not.toContain("github-label");
  expect(names).not.toContain("gh-login");
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
        PAWS_GITHUB_REPOSITORY: "pmdroid/paws-demo",
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
    placeholder: false,
    storeKind: "keychain",
    storeWarning: null,
    signedIn: { ok: true, detail: "signed in as octocat" },
    push: { ok: true, detail: "push access to pmdroid/paws-demo" },
    label: { ok: true, detail: "paws" },
    rate: { ok: true, detail: "4800 remaining" },
  };
}

function greenFacts(): ProbeFacts {
  return {
    configError: null,
    configured: true,
    linearCommentMode: false,
    githubAuth: "gh",
    trackerKind: "linear",
    oauthClientId: null,
    githubDoctor: {
      placeholder: false,
      storeKind: "gh",
      storeWarning: null,
      signedIn: { ok: true, detail: "not used" },
      push: { ok: true, detail: "not used" },
      label: { ok: true, detail: "not used" },
      rate: { ok: true, detail: "not used" },
    },
    webhooks: false,
    workspace: "Paws Demo",
    publicUrl: null,
    repo: "pmdroid/paws-demo",
    team: "ENG",
    teamId: "team_eng",
    ghLogin: { ok: true, detail: "logged in as paws" },
    ghPush: { ok: true, detail: "push access to pmdroid/paws-demo" },
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
    linearCommentMode: false,
    githubAuth: "gh",
    trackerKind: "linear",
    oauthClientId: null,
    githubDoctor: {
      placeholder: false,
      storeKind: "gh",
      storeWarning: null,
      signedIn: { ok: false, detail: "not signed in" },
      push: { ok: false, detail: "repository is not pushable" },
      label: { ok: false, detail: "paws label is missing" },
      rate: { ok: false, detail: "rate limit was not read" },
    },
    webhooks: false,
    publicUrl: null,
    repo: null,
    team: null,
    teamId: null,
    ghLogin: { ok: false, detail: "gh auth status failed" },
    ghPush: { ok: false, detail: "repository must be owner/name" },
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
