import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("fetchOriginMain runs one fetch at a time in a repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-fetch-order-"));
  temps.push(root);
  const repo = join(root, "repo");
  const run = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
  run("init", "-q", "--bare", "-b", "main", join(root, "origin.git"));
  run("clone", "-q", join(root, "origin.git"), repo);
  run(
    "-C",
    repo,
    "-c",
    "user.name=A",
    "-c",
    "user.email=a@b.c",
    "commit",
    "--allow-empty",
    "-qm",
    "a",
  );
  run("-C", repo, "push", "-q", "origin", "HEAD:main");
  const head = run("-C", repo, "rev-parse", "HEAD");
  const bin = join(root, "bin");
  const log = join(root, "fetches.log");
  mkdirSync(bin);
  const path = process.env.PATH ?? "";
  const wrapper = `echo start >> ${log}; sleep 0.3; PATH="${path}" git "$@"; s=$?; echo end >> ${log}; exit $s`;
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${wrapper}\n`);
  chmodSync(join(bin, "git"), 0o755);
  const git = createGitReader({ env: { ...process.env, PATH: `${bin}:${path}` } });
  const fetched = await Promise.all([1, 2, 3].map(() => git.fetchOriginMain(repo)));
  expect(fetched).toEqual([1, 2, 3].map(() => ({ ok: true, commit: head })));
  expect(readFileSync(log, "utf8").split(/\s+/).join(" ").trim()).toBe(
    "start end start end start end",
  );
});

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
