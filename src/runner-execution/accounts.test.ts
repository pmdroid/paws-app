import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeExecutions,
  holdRunnerAccountHome,
  markRunnerAccountSignedIn,
  openRunnerAccountHome,
  publishRunnerAccountHome,
  releaseRunnerAccountHome,
  runnerAccountBindings,
  runnerAccountHome,
} from "./accounts";
import { startTime } from "./processes";

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

function liveReceipt(root: string) {
  const path = join(root, `${execution}.pid`);
  writeFileSync(path, `${process.pid} ${startTime(process.pid)}\n`);
  return path;
}

test("a command without an account keeps the default home", () => {
  const root = agentHome();
  expect(openRunnerAccountHome(root, undefined, "claude")).toBe(root);
  expect(runnerAccountHome(root)).toBe(root);
  expect(runnerAccountBindings(root)).toEqual([]);
});

test("two bindings get separate private homes, held only after a published sign-in", () => {
  const root = agentHome();
  expect(() => openRunnerAccountHome(root, a, "codex")).toThrow(/not signed in/);
  const homeA = openRunnerAccountHome(root, a, "codex", { signIn: true });
  const homeB = openRunnerAccountHome(root, b, "codex", { signIn: true });
  expect(homeA).toBe(join(root, ".paws-accounts", a.bindingId));
  expect(homeB).not.toBe(homeA);
  for (const folder of [".", ".claude", ".codex/sessions", ".grok", ".local/share", ".config"])
    expect(statSync(join(homeA, folder)).mode & 0o777).toBe(0o700);
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
  const victim = openRunnerAccountHome(root, b, "claude", { signIn: true });
  symlinkSync(victim, join(root, ".paws-accounts", a.bindingId));
  expect(() => openRunnerAccountHome(root, a, "claude", { signIn: true })).toThrow(
    /not a private directory/,
  );
  expect(statSync(join(root, ".paws-accounts")).mode & 0o777).toBe(0o700);

  const loose = openRunnerAccountHome(
    root,
    { ...b, bindingId: "01JLOOSE000000000000000000" },
    "grok",
    {
      signIn: true,
    },
  );
  chmodSync(join(loose, ".grok"), 0o755);
  openRunnerAccountHome(root, { ...b, bindingId: "01JLOOSE000000000000000000" }, "grok", {
    signIn: true,
  });
  expect(statSync(join(loose, ".grok")).mode & 0o777).toBe(0o700);
});

test("a sign-in waits for live work on its binding and keeps new work out while it publishes", () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  holdRunnerAccountHome(home, other, liveReceipt(root));
  expect(activeExecutions(home)).toEqual([other]);
  let published = 0;
  expect(() => publishRunnerAccountHome(home, execution, () => published++)).toThrow(
    /still running/,
  );
  expect(published).toBe(0);

  releaseRunnerAccountHome(home, other);
  publishRunnerAccountHome(home, execution, () => {
    published++;
    expect(() => holdRunnerAccountHome(home, other, liveReceipt(root))).toThrow(/signing in/);
  });
  expect(published).toBe(1);
  expect(activeExecutions(home)).toEqual([]);
  holdRunnerAccountHome(home, other, liveReceipt(root));
  expect(activeExecutions(home)).toEqual([other]);
});

test("holds and publish locks left by a crashed process are stale", () => {
  const root = agentHome();
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  const dead = join(root, "dead.pid");
  writeFileSync(dead, "2147483646 1\n");
  holdRunnerAccountHome(home, other, dead);
  writeFileSync(join(home, ".paws-publishing"), JSON.stringify({ pid: 2147483646, born: "1" }));
  expect(activeExecutions(home)).toEqual([]);
  let published = 0;
  publishRunnerAccountHome(home, execution, () => published++);
  expect(published).toBe(1);
  expect(readdirSync(join(home, ".paws-active"))).toEqual([]);
});
