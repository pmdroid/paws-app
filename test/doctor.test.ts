import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROK_AGENT_ARGS, GROK_LOGIN_MESSAGE } from "../src/acp";
import type { FakeResult } from "../src/acp/testing/script";
import type { AgentsConfig } from "../src/config";
import { doctorChecks, formatDoctor, type DoctorProbe, type ProbeFacts } from "../src/doctor";
import { grokLoginStatus } from "../src/install";

const NAMES = [
  "git",
  "bun",
  "home",
  "linear",
  "linear-mode",
  "linear-team",
  "linear-label",
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
  expect(text).toContain("bun run paws setup --closeout-path <binary>");
  expect(checks.filter((item) => !item.ok).every((item) => item.fix !== undefined)).toBe(true);
  expect(text).not.toContain("whsec_do_not_print");
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
    args: [fakeAgent, ...GROK_AGENT_ARGS],
    env: {
      ...process.env,
      FAKE_ACP_SCRIPT: scriptPath,
      FAKE_ACP_RESULT: resultPath,
    },
  });
  expect(status.loggedIn).toBe(true);
  expect(status.detail).toBe("cached_token");
  expect(status.args).toEqual([fakeAgent, ...GROK_AGENT_ARGS]);
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
  expect(text).toContain("note claude: not required when the implementer is grok");
  expect(text).toContain("note claude-acp: not required when the implementer is grok");
  expect(text).toContain("ok codex:");
  expect(text).not.toContain("missing");
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
    args: [fakeAgent, ...GROK_AGENT_ARGS],
    env: {
      ...process.env,
      FAKE_ACP_SCRIPT: scriptPath,
      FAKE_ACP_RESULT: resultPath,
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

function greenFacts(): ProbeFacts {
  return {
    configError: null,
    configured: true,
    linearMode: "comments",
    githubAuth: "gh",
    webhooks: false,
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
    closeout: {
      path: "/tmp/paws-home/bin/closeout",
      present: true,
      executable: true,
      checksum: "skipped",
    },
    linear: {
      attempted: true,
      reachable: true,
      viewerId: "viewer_1",
      viewerMatches: true,
      teamFound: true,
      labelFound: true,
      error: null,
    },
  };
}

function redFacts(override: Partial<ProbeFacts>): ProbeFacts {
  return {
    configError: null,
    configured: false,
    linearMode: "comments",
    githubAuth: "gh",
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
      path: "/tmp/paws-home/bin/closeout",
      present: false,
      executable: false,
      checksum: "missing",
    },
    linear: {
      attempted: false,
      reachable: false,
      viewerId: null,
      viewerMatches: false,
      teamFound: false,
      labelFound: false,
      error: null,
    },
    ...override,
  };
}
