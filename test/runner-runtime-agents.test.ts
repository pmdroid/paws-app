import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunnerAgents } from "../src/runner-runtime";
import type { RunnerAgentTarget } from "../src/runner-protocol";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function host() {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-agents-"));
  roots.push(root);
  const base = join(root, "opt");
  const state = join(root, "state");
  mkdirSync(state);
  const install = (agent: string, ...versions: string[]) => {
    for (const version of versions)
      mkdirSync(join(base, "agents", agent, version), { recursive: true });
  };
  const point = (agent: string, version: string) => {
    rmSync(join(base, "agents", agent, "current"), { force: true });
    symlinkSync(version, join(base, "agents", agent, "current"));
  };
  const status = (agents: unknown) =>
    writeFileSync(join(root, "status.json"), JSON.stringify({ format: 1, agents }));
  const open = () =>
    openRunnerAgents({
      base,
      requests: join(state, "agent-requests.json"),
      status: join(root, "status.json"),
    });
  const requests = () =>
    JSON.parse(readFileSync(join(state, "agent-requests.json"), "utf8")) as {
      format: number;
      requests: RunnerAgentTarget[];
    };
  return { root, base, state, install, point, status, open, requests };
}

const update: RunnerAgentTarget = {
  id: "01KUPDATE",
  agent: "claude",
  version: "2.1.0",
  integrity: `sha512-${"B".repeat(86)}==`,
  nativeVersion: "2.1.0",
  packages: [
    {
      name: "@anthropic-ai/claude-agent-sdk",
      version: "2.1.0",
      integrity: `sha512-${"C".repeat(86)}==`,
    },
  ],
};

test("a host without installed agents reports none", () => {
  const runner = host();
  expect(runner.open().installed()).toBeUndefined();
});

test("the heartbeat reports each agent's current version", () => {
  const runner = host();
  runner.install("claude", "2.0.0", "1.8.0");
  runner.point("claude", "2.0.0");
  runner.install("codex", "0.9.0");
  runner.point("codex", "0.9.0");
  runner.install("grok", "1.0.0");
  runner.status({ claude: { previous: "1.8.0", request: null }, codex: { previous: "0.1.0" } });
  // An older installer's status file still names the version before the last switch; it is not reported.
  expect(runner.open().installed()).toEqual([
    { agent: "claude", version: "2.0.0", status: "current" },
    { agent: "codex", version: "0.9.0", status: "current" },
  ]);
});

test("only the versions Paws sent are forwarded to the installer, and its progress is reported", () => {
  const runner = host();
  runner.install("claude", "2.0.0");
  runner.point("claude", "2.0.0");
  const agents = runner.open();
  agents.apply([update]);
  expect(runner.requests()).toEqual({ format: 1, requests: [update] });
  expect(statSync(join(runner.state, "agent-requests.json")).mode & 0o777).toBe(0o600);
  expect(agents.installed()).toContainEqual({
    agent: "claude",
    version: "2.1.0",
    status: "installing",
    target: update.id,
  });

  runner.status({
    claude: { request: { id: update.id, version: "2.1.0", status: "waiting", sessions: 2 } },
  });
  expect(agents.installed()).toContainEqual({
    agent: "claude",
    version: "2.1.0",
    status: "waiting",
    target: update.id,
    sessions: 2,
  });

  const error =
    "Coding agent claude 2.1.0 was not installed: npm's integrity is not the one Paws sent";
  runner.status({
    claude: { request: { id: update.id, version: "2.1.0", status: "failed", error } },
  });
  expect(agents.installed()).toContainEqual({
    agent: "claude",
    version: "2.1.0",
    status: "failed",
    target: update.id,
    error,
  });

  // An answer to an older request is not this request's answer.
  runner.status({
    claude: { request: { id: "01KOLDER", version: "2.1.0", status: "failed", error } },
  });
  expect(agents.installed()).toContainEqual(expect.objectContaining({ status: "installing" }));

  // Once current moves, only the new current remains.
  runner.install("claude", "2.1.0");
  runner.point("claude", "2.1.0");
  runner.status({
    claude: { request: { id: update.id, version: "2.1.0", status: "installed" } },
  });
  expect(agents.installed()).toEqual([{ agent: "claude", version: "2.1.0", status: "current" }]);
});

test("a target that is not a valid catalog version or integrity is refused", () => {
  const runner = host();
  runner.install("claude", "2.0.0");
  runner.point("claude", "2.0.0");
  const agents = runner.open();
  for (const target of [
    { ...update, integrity: "sha1-abc" },
    { ...update, version: "latest" },
    { ...update, agent: "left-pad" },
    { ...update, integrity: null },
    { ...update, packages: [] },
  ])
    expect(() => agents.apply([target as RunnerAgentTarget])).toThrow();
  expect(() => readFileSync(join(runner.state, "agent-requests.json"))).toThrow();
});

test("the request file is written once per change, and again after a restart", () => {
  const runner = host();
  runner.install("claude", "2.0.0");
  runner.point("claude", "2.0.0");
  const path = join(runner.state, "agent-requests.json");
  const agents = runner.open();
  agents.apply([update]);
  writeFileSync(path, "marker");
  agents.apply([update]);
  expect(readFileSync(path, "utf8")).toBe("marker");
  // A restarted daemon writes it again, so a switch that was waiting resumes.
  runner.open().apply([update]);
  expect(runner.requests().requests).toEqual([update]);
  agents.apply([]);
  expect(runner.requests().requests).toEqual([]);
});
