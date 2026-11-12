import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitReader, mainFixBudget } from "./facade";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function slowGit(): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), "paws-slow-git-"));
  temps.push(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 10\n");
  chmodSync(join(bin, "git"), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

test.each(["fetchOriginMain", "lsRemoteOriginMain"] as const)(
  "%s keeps the event loop running while git is slow and fails at the timeout",
  async (method) => {
    const repo = mkdtempSync(join(tmpdir(), "paws-slow-git-repo-"));
    temps.push(repo);
    const git = createGitReader({ env: slowGit(), fetchTimeoutMs: 500, remoteTimeoutMs: 500 });
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    const started = Date.now();
    try {
      const result = await git[method](repo);
      expect(result).toEqual({ ok: false, stderr: "spawn git ETIMEDOUT" });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThanOrEqual(10);
    expect(Date.now() - started).toBeLessThan(5_000);
  },
);

test("mainFixBudget reads the policy at the local origin/main without a fetch", () => {
  const repo = mkdtempSync(join(tmpdir(), "paws-fix-budget-"));
  temps.push(repo);
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
      .toString()
      .trim();
  run("init", "-q");
  run("remote", "add", "origin", join(repo, "unreachable.git"));
  mkdirSync(join(repo, ".agents"));
  writeFileSync(
    join(repo, ".agents", "closeout.yaml"),
    'specVersion: "0.1"\nretry:\n  scope: task\n  fix_rounds_per_item: 7\nitems: []\n',
  );
  run("add", ".");
  run("-c", "user.name=Acme", "-c", "user.email=acme@example.com", "commit", "-qm", "policy");
  expect(mainFixBudget(repo)).toBeNull();
  run("update-ref", "refs/remotes/origin/main", run("rev-parse", "HEAD"));
  expect(mainFixBudget(repo)).toBe(7);
});
