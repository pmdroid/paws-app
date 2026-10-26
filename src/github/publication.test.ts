import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runGitHubGit } from "./auth/git-transport";
import { rebaseOntoMain, squashPull } from "./merge";
import { publishAccepted, pushBranch } from "./pulls";
import { defaultGitExec } from "./git";
import { fakeMergeReadiness, fakeRequiredChecks } from "./fake";
import type { GitExec, GitHubClient } from "./types";

const exec = promisify(execFile);
const roots: string[] = [];
const token = "synthetic-publication-canary";
const tokenProvider = { mode: "token" as const, tokenFor: async () => token };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paws-publication-test-"));
  roots.push(root);
  const worktree = path.join(root, "candidate");
  const remote = path.join(root, "remote.git");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);
  await exec("git", ["init", "--initial-branch=main", worktree]);
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: worktree })).stdout.trim();
  await git("config", "user.name", "Synthetic User");
  await git("config", "user.email", "synthetic@example.invalid");
  await writeFile(path.join(worktree, "file"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  await git("push", remote, "main");
  await writeFile(path.join(worktree, "file"), "candidate\n");
  await git("commit", "-am", "candidate");
  const canary = path.join(root, "canary");
  const hook = path.join(root, "capture");
  await writeFile(hook, `#!/bin/sh\nprintf '%s\\n' "$PAWS_GITHUB_TOKEN" >> '${canary}'\n`);
  await chmod(hook, 0o700);
  return { root, worktree, remote, git, canary, hook };
}

async function captured(file: string) {
  return readFile(file, "utf8").catch(() => "");
}

for (const hookMode of ["default", "include"]) {
  test(`publication excludes ${hookMode} pre-push hooks and candidate configuration`, async () => {
    const f = await fixture();
    const hooks = path.join(f.root, "hooks");
    await mkdir(hooks);
    await writeFile(path.join(hooks, "pre-push"), await readFile(f.hook));
    await chmod(path.join(hooks, "pre-push"), 0o700);
    if (hookMode === "default") {
      await writeFile(path.join(f.worktree, ".git/hooks/pre-push"), await readFile(f.hook));
      await chmod(path.join(f.worktree, ".git/hooks/pre-push"), 0o700);
    } else {
      const include = path.join(f.root, "candidate.config");
      await writeFile(
        include,
        `[core]\n hooksPath = ${hooks}\n[credential]\n helper = !${f.hook}\n`,
      );
      await f.git("config", "include.path", include);
    }
    const realExec = defaultGitExec();
    const checkedExec: GitExec = async (args, options) => {
      if (args.includes("push")) {
        expect(options.cwd).not.toBe(f.worktree);
        const gitDir = args[args.indexOf("--git-dir") + 1];
        expect(gitDir).toContain("paws-publication-");
        expect(await readFile(path.join(gitDir!, "config"), "utf8")).not.toContain("include");
      }
      if (options.cwd === f.worktree) expect(JSON.stringify(options.env)).not.toContain(token);
      return realExec(args, options);
    };
    const result = await pushBranch({
      worktree: f.worktree,
      issue: "ENG-38",
      owner: "synthetic",
      repo: "repo",
      remoteUrl: f.remote,
      tokenProvider,
      gitExec: checkedExec,
    });
    expect(await captured(f.canary)).not.toContain(token);
    expect(await f.git("--git-dir", f.remote, "rev-parse", "refs/heads/paws/ENG-38")).toBe(
      result.head,
    );
  });
}

test("candidate URL rewriting and external transports never receive a publication token", async () => {
  const f = await fixture();
  await f.git("config", "protocol.ext.allow", "always");
  await f.git("config", `url.ext::${f.hook}.insteadOf`, f.remote);
  await pushBranch({
    worktree: f.worktree,
    issue: "ENG-38",
    owner: "synthetic",
    repo: "repo",
    remoteUrl: f.remote,
    tokenProvider,
  });
  expect(await captured(f.canary)).not.toContain(token);
});

test("clone, refresh, push, PR and serial rebase merge retain ordinary behavior", async () => {
  const f = await fixture();
  await f.git("checkout", "--detach");
  const dest = path.join(f.root, "mirror.git");
  await runGitHubGit({ operation: "clone", cwd: f.root, dest, remoteUrl: f.remote, token });
  await exec("git", ["--git-dir", dest, "config", "url.ext::false.insteadOf", f.remote]);
  await exec("git", ["--git-dir", dest, "update-ref", "refs/heads/stale", "main"]);
  await runGitHubGit({ operation: "fetch", cwd: f.root, dest, remoteUrl: f.remote, token });
  expect(
    await exec("git", ["--git-dir", dest, "for-each-ref", "refs/heads/stale"]).then(
      (result) => result.stdout,
    ),
  ).toBe("");
  expect(
    await exec("git", ["--git-dir", dest, "rev-parse", "refs/heads/main"]).then((result) =>
      result.stdout.trim(),
    ),
  ).toBe((await exec("git", ["--git-dir", f.remote, "rev-parse", "main"])).stdout.trim());
  await runGitHubGit({
    operation: "push",
    cwd: f.worktree,
    remoteUrl: f.remote,
    refspec: "HEAD:refs/heads/oauth",
    token,
  });
  const client: GitHubClient = {
    async request(input) {
      expect(input.token).toBe(token);
      if (input.path === "/graphql") {
        const { head } = (input.body as { variables: { head: string } }).variables;
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      const required = fakeRequiredChecks(input);
      if (required) return required;
      if (input.method === "POST") return { status: 201, body: { number: 38 } };
      if (input.method === "PUT") return { status: 200, body: { merged: true, sha: "merged" } };
      throw new Error("unexpected request");
    },
  };
  const published = await publishAccepted({
    accepted: true,
    evidence: "synthetic accepted",
    worktree: f.worktree,
    issue: "ENG-38",
    owner: "synthetic",
    repo: "repo",
    remoteUrl: f.remote,
    tokenProvider,
    client,
  });
  expect(published.published).toBe(true);
  await exec("git", ["clone", f.remote, path.join(f.root, "upstream")]);
  const upstream = path.join(f.root, "upstream");
  await exec("git", ["config", "user.name", "Synthetic User"], { cwd: upstream });
  await exec("git", ["config", "user.email", "synthetic@example.invalid"], { cwd: upstream });
  await writeFile(path.join(upstream, "other"), "upstream change\n");
  await exec("git", ["add", "."], { cwd: upstream });
  await exec("git", ["commit", "-m", "advance main"], { cwd: upstream });
  await exec("git", ["push", "origin", "main"], { cwd: upstream });
  await f.git("config", "core.hooksPath", f.root);
  await writeFile(path.join(f.root, "pre-rebase"), await readFile(f.hook));
  await chmod(path.join(f.root, "pre-rebase"), 0o700);
  const lane = {
    worktree: f.worktree,
    issue: "ENG-38",
    owner: "synthetic",
    repo: "repo",
    prNumber: 38,
    appId: "",
    installationId: "",
    privateKeyPem: "",
    remoteUrl: f.remote,
    tokenProvider,
    client,
  };
  const rebased = await rebaseOntoMain(lane);
  if (!rebased.rebased) throw new Error(`rebase failed: ${rebased.result.message}`);
  const merged = await squashPull(lane, rebased, "synthetic verified");
  expect(merged.merged).toBe(true);
  expect(await captured(f.canary)).not.toContain(token);
});
