import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeExecutions,
  confirmRunnerAccountHold,
  holdRunnerAccountHome,
  markRunnerAccountSignedIn,
  openRunnerAccountHome,
  publishRunnerAccountHome,
  releaseRunnerAccountHome,
  runnerAccountBindings,
  runnerAccountHome,
  shareRunnerAgentState,
} from "./accounts";
import { executionScope, executionTag, startTime } from "./processes";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentHome() {
  const root = mkdtempSync(join(tmpdir(), "paws-account-homes-"));
  roots.push(root);
  return root;
}

const a = { accountId: "01JACCOUNTA000000000000000", bindingId: "01JBINDINGA000000000000000" };
const b = { accountId: "01JACCOUNTB000000000000000", bindingId: "01JBINDINGB000000000000000" };
const execution = "01J00000000000000000000001";
const other = "01J00000000000000000000002";

const live = () => ({ pid: process.pid, born: startTime(process.pid)! });
const dead = { pid: 2147483646, born: "1" };

function hold(home: string, id: string, root: string, worker: { pid: number; born: string }) {
  const scope = executionScope(root);
  holdRunnerAccountHome(home, id, { scope });
  confirmRunnerAccountHold(home, id, { scope, ...worker });
}

test("a command without an account keeps the default home", () => {
  const root = agentHome();
  expect(openRunnerAccountHome(root, undefined, "claude")).toBe(root);
  expect(runnerAccountHome(root)).toBe(root);
  expect(runnerAccountBindings(root)).toEqual([]);
});

test("two bindings get separate group-shared homes, held only after a published sign-in", () => {
  const root = agentHome();
  expect(() => openRunnerAccountHome(root, a, "codex")).toThrow(/not signed in/);
  const homeA = openRunnerAccountHome(root, a, "codex", { signIn: true });
  const homeB = openRunnerAccountHome(root, b, "codex", { signIn: true });
  expect(homeA).toBe(join(root, ".paws-accounts", a.bindingId));
  expect(homeB).not.toBe(homeA);
  for (const folder of [".", ".claude", ".codex/sessions", ".grok", ".local/share", ".config"])
    expect(statSync(join(homeA, folder)).mode & 0o777).toBe(0o770);
  expect(runnerAccountBindings(root)).toEqual([]);
  expect(() => openRunnerAccountHome(root, a, "codex")).toThrow(/not signed in/);

  markRunnerAccountSignedIn(homeA, a, "codex");
  expect(runnerAccountBindings(root)).toEqual([{ bindingId: a.bindingId, agent: "codex" }]);
  expect(openRunnerAccountHome(root, a, "codex")).toBe(homeA);
  markRunnerAccountSignedIn(homeB, b, "codex");
  expect(runnerAccountBindings(root).map((binding) => binding.bindingId)).toEqual([
    a.bindingId,
    b.bindingId,
  ]);
});

test("a binding never runs as another account or agent", () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  markRunnerAccountSignedIn(home, a, "claude");
  expect(() =>
    openRunnerAccountHome(root, { ...a, accountId: b.accountId }, "claude", { signIn: true }),
  ).toThrow(/another account/);
  expect(() => openRunnerAccountHome(root, a, "codex")).toThrow(/another account/);
  expect(() => markRunnerAccountSignedIn(home, { ...a, accountId: b.accountId }, "claude")).toThrow(
    /another account/,
  );
});

test("generated paths reject traversal, symlinks and foreign permissions", () => {
  const root = agentHome();
  expect(() =>
    openRunnerAccountHome(root, { ...a, bindingId: "../escape" }, "claude", { signIn: true }),
  ).toThrow();
  expect(() =>
    openRunnerAccountHome(root, { ...a, bindingId: "legacy_claude_runner" }, "claude", {
      signIn: true,
    }),
  ).toThrow();

  const elsewhere = agentHome();
  symlinkSync(elsewhere, join(root, ".paws-accounts"));
  expect(() => openRunnerAccountHome(root, a, "claude", { signIn: true })).toThrow(
    /not a private directory/,
  );
  expect(readdirSync(elsewhere)).toEqual([]);
  rmSync(join(root, ".paws-accounts"));

  mkdirSync(join(root, ".paws-accounts"), { mode: 0o755 });
  chmodSync(join(root, ".paws-accounts"), 0o755);
  expect(() => openRunnerAccountHome(root, b, "claude", { signIn: true })).toThrow(
    /open to other users/,
  );
  chmodSync(join(root, ".paws-accounts"), 0o700);
  const victim = openRunnerAccountHome(root, b, "claude", { signIn: true });
  symlinkSync(victim, join(root, ".paws-accounts", a.bindingId));
  expect(() => openRunnerAccountHome(root, a, "claude", { signIn: true })).toThrow(
    /not a private directory/,
  );
  expect(statSync(join(root, ".paws-accounts")).mode & 0o777).toBe(0o770);

  const loose = openRunnerAccountHome(
    root,
    { ...b, bindingId: "01JLOOSE000000000000000000" },
    "grok",
    {
      signIn: true,
    },
  );
  chmodSync(join(loose, ".grok"), 0o755);
  const reopen = () =>
    openRunnerAccountHome(root, { ...b, bindingId: "01JLOOSE000000000000000000" }, "grok", {
      signIn: true,
    });
  expect(reopen).toThrow(/open to other users/);
  chmodSync(join(loose, ".grok"), 0o700);
  reopen();
  expect(statSync(join(loose, ".grok")).mode & 0o777).toBe(0o770);
});

test("a sign-in waits for live work on its binding and keeps new work out while it publishes", () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  hold(home, other, root, live());
  expect(activeExecutions(home)).toEqual([other]);
  let published = 0;
  expect(() => publishRunnerAccountHome(home, execution, () => published++)).toThrow(
    /still running/,
  );
  expect(published).toBe(0);

  releaseRunnerAccountHome(home, other);
  publishRunnerAccountHome(home, execution, () => {
    published++;
    expect(() => hold(home, other, root, live())).toThrow(/signing in/);
  });
  expect(published).toBe(1);
  expect(activeExecutions(home)).toEqual([]);
  hold(home, other, root, live());
  expect(activeExecutions(home)).toEqual([other]);
});

test("holds and publish locks left by a crashed process are stale", () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  hold(home, other, root, dead);
  writeFileSync(join(home, ".paws-publishing"), JSON.stringify({ pid: 2147483646, born: "1" }));
  expect(activeExecutions(home)).toEqual([]);
  let published = 0;
  publishRunnerAccountHome(home, execution, () => published++);
  expect(published).toBe(1);
  expect(readdirSync(join(home, ".paws-active"))).toEqual([]);
});

test("an admission whose worker has not started keeps its hold for the admission window", () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  holdRunnerAccountHome(home, other, { scope: executionScope(root) });
  expect(activeExecutions(home)).toEqual([other]);
  expect(() => publishRunnerAccountHome(home, execution, () => {})).toThrow(/still running/);
  const old = new Date(Date.now() - 120_000);
  utimesSync(join(home, ".paws-active", other), old, old);
  expect(activeExecutions(home)).toEqual([]);
});

test("a hold stays while the execution's processes outlive its worker", async () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  const scope = executionScope(root);
  const survivor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    env: { ...process.env, ...executionTag(scope, other) },
    stdio: "ignore",
  });
  try {
    while (startTime(survivor.pid!) === undefined) await Bun.sleep(10);
    holdRunnerAccountHome(home, other, { scope });
    confirmRunnerAccountHold(home, other, { scope, ...dead });
    expect(activeExecutions(home)).toEqual([other]);
    expect(() => publishRunnerAccountHome(home, execution, () => {})).toThrow(/still running/);
  } finally {
    survivor.kill("SIGKILL");
    await new Promise((resolve) => survivor.once("exit", resolve));
  }
  expect(activeExecutions(home)).toEqual([]);
});

test("a binding's manifest, holds and sign-in lock are readable by the agent group", () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  markRunnerAccountSignedIn(home, a, "claude");
  const manifest = statSync(join(home, "account.json"));
  expect([manifest.mode & 0o777, manifest.gid]).toEqual([0o640, process.getgid!()]);
  hold(home, execution, root, live());
  expect(statSync(join(home, ".paws-active", execution)).mode & 0o777).toBe(0o640);
  releaseRunnerAccountHome(home, execution);
  let lock = 0;
  publishRunnerAccountHome(home, execution, () => {
    lock = statSync(join(home, ".paws-publishing")).mode & 0o777;
  });
  expect(lock).toBe(0o640);
});

test("a manifest written 0600 before agents ran as paws-agent is shared on the next open", () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  writeFileSync(join(home, "account.json"), `${JSON.stringify({ ...a, agent: "claude" })}\n`);
  chmodSync(join(home, "account.json"), 0o600);
  expect(openRunnerAccountHome(root, a, "claude")).toBe(home);
  expect(statSync(join(home, "account.json")).mode & 0o777).toBe(0o640);
  chmodSync(join(home, "account.json"), 0o660);
  expect(() => openRunnerAccountHome(root, a, "claude")).toThrow(/manifest is unsafe/);
});

test("agent state written by the runner is shared with the agent group before paws-agent runs", () => {
  const root = agentHome();
  const owners = { runnerUid: process.getuid!(), agentGid: process.getgid!() };
  mkdirSync(join(root, ".codex/sessions/2026"), { recursive: true, mode: 0o700 });
  chmodSync(join(root, ".codex"), 0o700);
  chmodSync(join(root, ".codex/sessions"), 0o700);
  chmodSync(join(root, ".codex/sessions/2026"), 0o700);
  writeFileSync(join(root, ".codex/auth.json"), "{}", { mode: 0o600 });
  chmodSync(join(root, ".codex/auth.json"), 0o600);
  writeFileSync(join(root, ".codex/sessions/2026/rollout.jsonl"), "", { mode: 0o600 });
  chmodSync(join(root, ".codex/sessions/2026/rollout.jsonl"), 0o600);
  writeFileSync(join(root, "elsewhere"), "", { mode: 0o600 });
  chmodSync(join(root, "elsewhere"), 0o600);
  symlinkSync(join(root, "elsewhere"), join(root, ".codex/link"));
  shareRunnerAgentState(root, owners);
  const mode = (path: string) => statSync(join(root, path)).mode & 0o7777;
  expect(mode(".codex")).toBe(0o770);
  expect(mode(".codex/sessions/2026")).toBe(0o770);
  expect(mode(".codex/auth.json")).toBe(0o660);
  expect(mode(".codex/sessions/2026/rollout.jsonl")).toBe(0o660);
  expect(mode("elsewhere")).toBe(0o600);
  shareRunnerAgentState(root, owners);
  expect(mode(".codex/auth.json")).toBe(0o660);
});

test("a hold names its worker itself, so no reader follows a path into runner-private state", () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  const runnerPrivate = join(root, "private.pid");
  writeFileSync(runnerPrivate, `${process.pid} ${startTime(process.pid)}\n`);
  chmodSync(runnerPrivate, 0o000);
  hold(home, execution, root, live());
  const legacy = join(home, ".paws-active", other);
  writeFileSync(legacy, JSON.stringify({ receipt: runnerPrivate, scope: executionScope(root) }));
  expect(activeExecutions(home, execution)).toEqual([other]);
  const old = new Date(Date.now() - 120_000);
  utimesSync(legacy, old, old);
  let published = 0;
  publishRunnerAccountHome(home, execution, () => published++);
  expect(published).toBe(1);
  expect(readFileSync(join(home, ".paws-active", execution), "utf8")).not.toContain("receipt");
});

test("sharing agent state skips folders the runner cannot list", () => {
  const root = agentHome();
  const owners = { runnerUid: process.getuid!(), agentGid: process.getgid!() };
  mkdirSync(join(root, ".codex/sessions/private"), { recursive: true });
  writeFileSync(join(root, ".codex/auth.json"), "{}");
  chmodSync(join(root, ".codex/auth.json"), 0o600);
  chmodSync(join(root, ".codex/sessions/private"), 0o000);
  try {
    shareRunnerAgentState(root, owners);
  } finally {
    chmodSync(join(root, ".codex/sessions/private"), 0o700);
  }
  expect(statSync(join(root, ".codex/auth.json")).mode & 0o777).toBe(0o660);
});
