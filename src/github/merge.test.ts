import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { branchForIssue, fixesLine } from "./branch";
import { fakeMergeReadiness, fakeRequiredChecks } from "./fake";
import { defaultGitExec } from "./git";
import { serialMerge } from "./merge";
import { openPullRequest, publishAccepted, pushBranch } from "./pulls";
import {
  GitCommandError,
  INSTALLATION_PERMISSIONS,
  type GitExec,
  type GitHubClient,
  type GitHubResponse,
  type SerialMergeResult,
} from "./types";

const exec = promisify(execFile);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey as string;

describe("pull requests and serial merge", () => {
  for (const scenario of [
    "failed CI",
    "CI failing on the read just before the merge",
    "unreadable gates",
    "closed PR",
    "moved PR head",
  ]) {
    test(`does not merge with ${scenario} after Closeout accepts`, async () => {
      const repo = await oneClone();
      try {
        await commitFile(repo.work, "file.txt", "candidate\n");
        const client = mergingClient(repo.bare, []);
        let merges = 0;
        let reads = 0;
        const guarded: GitHubClient = {
          async request(req) {
            if (req.path === "/graphql") {
              reads += 1;
              if (scenario === "unreadable gates") return { status: 403, body: {} };
              const { head } = (req.body as { variables: { head: string } }).variables;
              const body = fakeMergeReadiness(head);
              const repository = body.data.repository;
              if (
                scenario === "failed CI" ||
                (scenario === "CI failing on the read just before the merge" && reads > 1)
              )
                repository.object.statusCheckRollup.contexts.nodes = [
                  { name: "ci", conclusion: "FAILURE" },
                ];
              if (scenario === "closed PR") repository.pullRequest.state = "CLOSED";
              if (scenario === "moved PR head") repository.pullRequest.headRefOid = "b".repeat(40);
              return { status: 200, body };
            }
            if (req.path.endsWith("/merge")) merges += 1;
            return client.request(req);
          },
        };
        const result = await serialMerge({
          ...creds(guarded),
          worktree: repo.work,
          issue: "ENG-8",
          prNumber: 8,
          remoteUrl: repo.bare,
          sleep: async () => {},
          reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
        });
        expect(result.merged).toBe(false);
        expect(merges).toBe(0);
        expect(result.outcome).toBe(
          scenario === "moved PR head"
            ? "sha_moved"
            : scenario.includes("CI")
              ? "ci_failed"
              : "blocked",
        );
      } finally {
        await repo.cleanup();
      }
    });
  }

  test("does not merge when stopped while the checks are read just before the merge", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "candidate\n");
      const client = mergingClient(repo.bare, []);
      let merges = 0;
      let reads = 0;
      let cancelled = false;
      const result = await serialMerge({
        ...creds({
          async request(req) {
            if (req.path === "/graphql") {
              reads += 1;
              // The final read comes back green, but the item is stopped meanwhile.
              if (reads > 1) cancelled = true;
            }
            if (req.path.endsWith("/merge")) merges += 1;
            return client.request(req);
          },
        }),
        worktree: repo.work,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: repo.bare,
        sleep: async () => {},
        isCancelled: () => cancelled,
        reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
      });
      expect(reads).toBe(2);
      expect(merges).toBe(0);
      expect(result).toMatchObject({
        merged: false,
        outcome: "blocked",
        message: "merge cancelled",
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("Paws-controlled squash preserves both human trailers without claiming GitHub committer control", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "candidate.txt", "candidate\n");
      const client = mergingClient(repo.bare, []);
      let message = "";
      const result = await serialMerge({
        ...creds({
          async request(request) {
            if (request.path.endsWith("/merge"))
              message = (request.body as { commit_message: string }).commit_message;
            return client.request(request);
          },
        }),
        worktree: repo.work,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: repo.bare,
        commitMessage:
          "accepted\n\nCo-authored-by: Lead <7+lead@users.noreply.github.com>\nCo-authored-by: Steerer <8+steerer@users.noreply.github.com>\n",
        reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
      });
      expect(result.merged).toBe(true);
      expect(message).toContain("Co-authored-by: Lead <7+lead@users.noreply.github.com>");
      expect(message).toContain("Co-authored-by: Steerer <8+steerer@users.noreply.github.com>");
      const actual = await exec("git", [
        "--git-dir",
        repo.bare,
        "show",
        "-s",
        "--format=%B",
        "main",
      ]);
      expect(actual.stdout).toContain("Co-authored-by: Lead");
      expect(actual.stdout).toContain("Co-authored-by: Steerer");
    } finally {
      await repo.cleanup();
    }
  });

  test("branch names and the Fixes line keep the issue key", () => {
    expect(branchForIssue("ENG-123")).toBe("paws/ENG-123");
    expect(fixesLine("ENG-123")).toBe("Fixes ENG-123");
    expect(() => branchForIssue("ENG-123/../main")).toThrow();
  });

  test("push uses a one-shot helper and does not put the token on the command line", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const gitExec: GitExec = async (args, options) => {
      calls.push({ args, env: options.env });
      if (args.includes("rev-parse")) return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    let minted = 0;
    const client = tokenClient(() => {
      minted += 1;
      return `ghs_push_${minted}`;
    });
    const result = await pushBranch({
      worktree: "/tmp/does-not-matter",
      issue: "ENG-123",
      owner: "pmdroid",
      repo: "paws-demo",
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client,
      remoteUrl: "https://github.com/pmdroid/paws-demo.git",
      gitExec,
    });
    expect(result.branch).toBe("paws/ENG-123");
    const push = calls.find((call) => call.args.includes("push"));
    expect(push).toBeDefined();
    const rendered = push?.args.join(" ") ?? "";
    expect(rendered).toContain("credential.helper=");
    expect(rendered).toContain("HEAD:refs/heads/paws/ENG-123");
    expect(rendered).not.toContain("ghs_push_1");
    expect(push?.env.PAWS_GITHUB_TOKEN).toBe("ghs_push_1");
    expect(push?.env.GITHUB_TOKEN).toBeUndefined();
    expect(push?.env.GH_TOKEN).toBeUndefined();
  });

  test("opens a pull request whose body starts with Fixes ENG-123", async () => {
    const bodies: unknown[] = [];
    const client: GitHubClient = {
      async request(req) {
        if (req.path.endsWith("/access_tokens")) {
          return { status: 201, body: tokenBody(`ghs_${bodies.length + 1}`) };
        }
        bodies.push(req.body);
        return {
          status: 201,
          body: {
            number: 4,
            html_url: "https://github.com/pmdroid/paws-demo/pull/4",
            body: (req.body as { body: string }).body,
          },
        };
      },
    };
    const pull = await openPullRequest({
      issue: "ENG-123",
      owner: "pmdroid",
      repo: "paws-demo",
      title: "Add CSV export",
      evidence: "Closeout: accepted\n- typecheck (command): passed — exited 0",
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client,
    });
    expect(pull.number).toBe(4);
    const body = (bodies[0] as { body: string; head: string }).body;
    expect(body.split("\n")[0]).toBe("Fixes ENG-123");
    expect(body).toContain("typecheck");
    expect((bodies[0] as { head: string }).head).toBe("paws/ENG-123");
  });

  test("puts the agent's description before the evidence and updates an existing pull request", async () => {
    const requests: { method: string; body: unknown }[] = [];
    const client: GitHubClient = {
      async request(req) {
        if (req.path.endsWith("/access_tokens")) return { status: 201, body: tokenBody("ghs_1") };
        requests.push({ method: req.method, body: req.body });
        if (req.method === "POST") return { status: 422, body: {} };
        if (req.method === "GET") return { status: 200, body: [{ number: 9 }] };
        return { status: 200, body: { number: 9, body: (req.body as { body: string }).body } };
      },
    };
    await openPullRequest({
      issue: "ENG-123",
      owner: "pmdroid",
      repo: "paws-demo",
      title: "Export rows as CSV",
      description: "Adds exportRows.\n\nbun test: 3 pass",
      evidence: "Closeout: accepted",
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client,
    });
    expect(requests.at(-1)).toEqual({
      method: "PATCH",
      body: {
        title: "Export rows as CSV",
        body: "Fixes ENG-123\n\nAdds exportRows.\n\nbun test: 3 pass\n\nCloseout: accepted\n",
      },
    });
  });

  test("does not open a pull request when Closeout did not accept", async () => {
    let calls = 0;
    const client: GitHubClient = {
      async request() {
        calls += 1;
        return { status: 500, body: {} };
      },
    };
    const result = await publishAccepted({
      accepted: false,
      evidence: "Closeout: exhausted",
      worktree: "/tmp/none",
      issue: "ENG-123",
      owner: "pmdroid",
      repo: "paws-demo",
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client,
    });
    expect(result.published).toBe(false);
    expect(calls).toBe(0);
  });

  test("merges two items in order, rebasing the second onto the new main", async () => {
    const repo = await twoClones();
    const tokens: string[] = [];
    const bases: string[] = [];
    const client = mergingClient(repo.bare, tokens);
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    await commitFile(
      repo.wtA,
      "file.txt",
      [...lines.slice(0, 0), "line-1-from-a", ...lines.slice(1)].join("\n") + "\n",
    );
    await pushBranch({
      ...creds(client),
      worktree: repo.wtA,
      issue: "ENG-1",
      remoteUrl: repo.bare,
    });
    const first = await serialMerge({
      ...creds(client),
      worktree: repo.wtA,
      issue: "ENG-1",
      prNumber: 1,
      remoteUrl: repo.bare,
      onCredential: (purpose, token) => tokens.push(`${purpose}:${token}`),
      reverify: async ({ base, head }) => {
        bases.push(base);
        const current = (await exec("git", ["-C", repo.wtA, "rev-parse", "HEAD"])).stdout.trim();
        expect(head).toBe(current);
        return { accepted: true, outcome: "merged" as const, summary: "Closeout: accepted" };
      },
    });
    expect(first.merged).toBe(true);
    expect(first.outcome).toBe("merged");

    const changedTail = [...lines];
    changedTail[19] = "line-20-from-b";
    await commitFile(repo.wtB, "file.txt", `${changedTail.join("\n")}\n`);
    await pushBranch({
      ...creds(client),
      worktree: repo.wtB,
      issue: "ENG-2",
      remoteUrl: repo.bare,
    });
    const seen: string[] = [];
    const second = await serialMerge({
      ...creds(client),
      worktree: repo.wtB,
      issue: "ENG-2",
      prNumber: 2,
      remoteUrl: repo.bare,
      reverify: async ({ base, head }) => {
        seen.push(base);
        const current = (await exec("git", ["-C", repo.wtB, "rev-parse", "HEAD"])).stdout.trim();
        expect(head).toBe(current);
        expect(base).not.toBe(bases[0]);
        return { accepted: true, outcome: "merged", summary: "Closeout: accepted" };
      },
    });
    expect(second.merged).toBe(true);
    const main = await showMain(repo.bare, "file.txt");
    expect(main.startsWith("line-1-from-a\n")).toBe(true);
    expect(main.endsWith("line-20-from-b\n")).toBe(true);
    const pushTokens = tokens.filter((entry) => entry.startsWith("push:"));
    const mergeTokens = tokens.filter((entry) => entry.startsWith("merge:"));
    expect(pushTokens.length).toBeGreaterThan(0);
    expect(mergeTokens.length).toBeGreaterThan(0);
    expect(new Set([...pushTokens, ...mergeTokens]).size).toBe(
      pushTokens.length + mergeTokens.length,
    );
    await repo.cleanup();
  });

  test("fails closed and re-verifies when HEAD changes after Closeout", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "file.txt", "one\n");
    const client = mergingClient(repo.bare, []);
    let checks = 0;
    let merges = 0;
    const wrapped: GitHubClient = {
      async request(req) {
        if (req.path.endsWith("/merge")) merges += 1;
        return client.request(req);
      },
    };
    const result = await serialMerge({
      ...creds(wrapped),
      worktree: repo.work,
      issue: "ENG-9",
      prNumber: 9,
      remoteUrl: repo.bare,
      reverify: async () => {
        checks += 1;
        if (checks === 1) {
          await exec("git", ["-C", repo.work, "commit", "--allow-empty", "-m", "moved"]);
        }
        return { accepted: true, outcome: "merged", summary: "ok" };
      },
    });
    expect(result.merged).toBe(true);
    expect(checks).toBe(2);
    expect(merges).toBe(1);
    await repo.cleanup();
  });

  test("pending CI returns without sleeping when the lane should be released", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "candidate\n");
      const client = mergingClient(repo.bare, []);
      let merges = 0;
      let sleeps = 0;
      const result = await serialMerge({
        ...creds({
          async request(req) {
            if (req.path === "/graphql") {
              const { head } = (req.body as { variables: { head: string } }).variables;
              const body = fakeMergeReadiness(head);
              body.data.repository.object.statusCheckRollup.contexts.nodes = [
                { name: "ci", conclusion: null },
              ];
              return { status: 200, body };
            }
            if (req.path.endsWith("/merge")) merges += 1;
            return client.request(req);
          },
        }),
        worktree: repo.work,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: repo.bare,
        releaseWhilePending: true,
        sleep: async () => {
          sleeps += 1;
        },
        reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
      });
      expect(result.merged).toBe(false);
      expect(result.outcome).toBe("waiting");
      expect(result.message).toBe("Waiting for checks: ci.");
      expect(result.summary).toBe("accepted");
      expect(sleeps).toBe(0);
      expect(merges).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("a merge parked on pending CI skips reverify when claimed again with main unchanged and reverifies when main moves", async () => {
    const unchanged = await oneClone();
    try {
      await commitFile(unchanged.work, "file.txt", "candidate\n");
      let pending = true;
      let checks = 0;
      const first = await serialMerge({
        ...creds(ciClient(unchanged.bare, () => pending)),
        worktree: unchanged.work,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: unchanged.bare,
        releaseWhilePending: true,
        reverify: async () => {
          checks += 1;
          return { accepted: true, outcome: "merged", summary: "accepted once" };
        },
      });
      expect(first.outcome).toBe("waiting");
      expect(checks).toBe(1);
      const recorded = recordedVerification(first);
      pending = false;
      const second = await serialMerge({
        ...creds(ciClient(unchanged.bare, () => pending)),
        worktree: unchanged.work,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: unchanged.bare,
        releaseWhilePending: true,
        priorVerification: recorded,
        reverify: async () => {
          checks += 1;
          return { accepted: true, outcome: "merged", summary: "should not run" };
        },
      });
      expect(checks).toBe(1);
      expect(second.merged).toBe(true);
      expect(second.summary).toBe("accepted once");
    } finally {
      await unchanged.cleanup();
    }

    const moved = await twoClones();
    try {
      await commitFile(moved.wtA, "file.txt", "candidate\n");
      let pending = true;
      let checks = 0;
      const heads: string[] = [];
      const first = await serialMerge({
        ...creds(ciClient(moved.bare, () => pending)),
        worktree: moved.wtA,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: moved.bare,
        releaseWhilePending: true,
        reverify: async ({ head }) => {
          checks += 1;
          heads.push(head);
          return { accepted: true, outcome: "merged", summary: "accepted once" };
        },
      });
      expect(first.outcome).toBe("waiting");
      const recorded = recordedVerification(first);
      await commitFile(moved.wtB, "other.txt", "new main\n");
      await exec("git", ["-C", moved.wtB, "push", "origin", "HEAD:main"]);
      pending = false;
      const second = await serialMerge({
        ...creds(ciClient(moved.bare, () => pending)),
        worktree: moved.wtA,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: moved.bare,
        releaseWhilePending: true,
        priorVerification: recorded,
        reverify: async ({ head }) => {
          checks += 1;
          heads.push(head);
          return { accepted: true, outcome: "merged", summary: "accepted again" };
        },
      });
      expect(checks).toBe(2);
      expect(heads[1]).not.toBe(heads[0]);
      expect(second.merged).toBe(true);
      expect(second.summary).toBe("accepted again");
    } finally {
      await moved.cleanup();
    }
  });

  test("re-verifies a moved main after waiting for CI before merging", async () => {
    const repo = await twoClones();
    try {
      await commitFile(repo.wtA, "file.txt", "candidate\n");
      const client = mergingClient(repo.bare, []);
      let pending = true;
      const heads: string[] = [];
      const result = await serialMerge({
        ...creds({
          async request(req) {
            if (req.path === "/graphql" && pending) {
              const { head } = (req.body as { variables: { head: string } }).variables;
              const body = fakeMergeReadiness(head);
              body.data.repository.object.statusCheckRollup.contexts.nodes = [
                { name: "ci", conclusion: null },
              ];
              return { status: 200, body };
            }
            return client.request(req);
          },
        }),
        worktree: repo.wtA,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: repo.bare,
        sleep: async () => {
          await commitFile(repo.wtB, "other.txt", "new main\n");
          await exec("git", ["-C", repo.wtB, "push", "origin", "HEAD:main"]);
          pending = false;
        },
        reverify: async ({ head }) => {
          heads.push(head);
          return { accepted: true, outcome: "merged", summary: "accepted" };
        },
      });
      expect(result.merged).toBe(true);
      expect(result.cycle).toBe(2);
      expect(heads.length).toBe(2);
      expect(heads[1]).not.toBe(heads[0]);
      expect(await showMain(repo.bare, "other.txt")).toBe("new main\n");
    } finally {
      await repo.cleanup();
    }
  });

  test("a merge 409 re-verifies and is not treated as success", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "file.txt", "one\n");
    let merges = 0;
    const client = mergingClient(repo.bare, [], () => {
      merges += 1;
      if (merges === 1) return { status: 409, body: { message: "sha mismatch" } };
      return null;
    });
    let checks = 0;
    const result = await serialMerge({
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-8",
      prNumber: 8,
      remoteUrl: repo.bare,
      reverify: async () => {
        checks += 1;
        return { accepted: true, outcome: "merged", summary: "ok" };
      },
    });
    expect(result.merged).toBe(true);
    expect(merges).toBe(2);
    expect(checks).toBe(2);
    await repo.cleanup();
  });

  test("aborts a rebase conflict and does not merge", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "file.txt", "from-item\n");
    const other = await cloneOf(repo.bare);
    await commitFile(other, "file.txt", "from-main\n");
    await exec("git", ["-C", other, "push", "origin", "HEAD:main"]);
    let merges = 0;
    const client = mergingClient(repo.bare, [], () => {
      merges += 1;
      return { status: 200, body: { merged: true, sha: "c".repeat(40) } };
    });
    const result = await serialMerge({
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-7",
      prNumber: 7,
      remoteUrl: repo.bare,
      reverify: async () => ({ accepted: true, outcome: "merged", summary: "should not run" }),
    });
    expect(result.merged).toBe(false);
    expect(result.outcome).toBe("conflict");
    expect(merges).toBe(0);
    const status = (await exec("git", ["-C", repo.work, "status"])).stdout;
    expect(status).not.toContain("rebase in progress");
    await repo.cleanup();
    await rm(other, { recursive: true, force: true });
  });

  test("refuses a dirty worktree before minting a token", async () => {
    const repo = await oneClone();
    await writeFile(path.join(repo.work, "dirty.txt"), "wip\n");
    let calls = 0;
    const client: GitHubClient = {
      async request() {
        calls += 1;
        return { status: 500, body: {} };
      },
    };
    const result = await serialMerge({
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-6",
      prNumber: 6,
      remoteUrl: repo.bare,
      reverify: async () => ({ accepted: true, outcome: "merged", summary: "no" }),
    });
    expect(result.outcome).toBe("dirty");
    expect(calls).toBe(0);
    await repo.cleanup();
  });

  test("does not merge when Closeout rejects the rebased head", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "notes.txt", "change\n");
    let merges = 0;
    const client = mergingClient(repo.bare, [], () => {
      merges += 1;
      return { status: 200, body: { merged: true, sha: "c".repeat(40) } };
    });
    const result = await serialMerge({
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-4",
      prNumber: 4,
      remoteUrl: repo.bare,
      reverify: async () => ({ accepted: false, outcome: "rejected", summary: "typecheck failed" }),
    });
    expect(result.merged).toBe(false);
    expect(result.outcome).toBe("rejected");
    expect(merges).toBe(0);
    await repo.cleanup();
  });
});

describe("update only when main changed the same files or package", () => {
  async function movedApart(changed: string) {
    const repo = await twoClones();
    await mkdir(path.join(repo.wtA, "apps/web"), { recursive: true });
    await commitFile(repo.wtA, "apps/web/a.ts", "export const a = 1;\n");
    const client = mergingClient(repo.bare, []);
    await pushBranch({
      ...creds(client),
      worktree: repo.wtA,
      issue: "ENG-5",
      remoteUrl: repo.bare,
    });
    const head = (await exec("git", ["-C", repo.wtA, "rev-parse", "HEAD"])).stdout.trim();
    await mkdir(path.dirname(path.join(repo.wtB, changed)), { recursive: true });
    await commitFile(repo.wtB, changed, "from main\n");
    await exec("git", ["-C", repo.wtB, "push", "origin", "HEAD:main"]);
    return { repo, head, client };
  }

  async function merge(
    repo: { bare: string; wtA: string },
    client: GitHubClient,
    packages: string[] = [],
  ) {
    const reverified: { head: string; kept?: true; overlap?: string[] }[] = [];
    let rules = 0;
    const merges: string[] = [];
    const result = await serialMerge({
      ...creds({
        async request(req) {
          if (req.path.endsWith("/merge")) merges.push((req.body as { sha: string }).sha);
          return client.request(req);
        },
      }),
      worktree: repo.wtA,
      issue: "ENG-5",
      prNumber: 5,
      remoteUrl: repo.bare,
      updateOnOverlap: {
        packages,
        onUpToDateRule: async () => {
          rules += 1;
        },
      },
      reverify: async ({ head, kept, overlap }) => {
        reverified.push({ head, ...(kept ? { kept } : {}), ...(overlap ? { overlap } : {}) });
        return { accepted: true, outcome: "merged", summary: "accepted" };
      },
    });
    return { result, reverified, rules, merges };
  }

  test("main moved on unrelated files: merges the pull request's head without an update", async () => {
    const { repo, head, client } = await movedApart("docs/guide.md");
    try {
      const run = await merge(repo, client, ["apps/*"]);
      expect(run.result.merged).toBe(true);
      expect(run.reverified).toEqual([{ head, kept: true }]);
      expect(run.merges).toEqual([head]);
      expect(run.rules).toBe(0);
      expect((await exec("git", ["-C", repo.wtA, "rev-parse", "HEAD"])).stdout.trim()).toBe(head);
      expect(await showMain(repo.bare, "docs/guide.md")).toBe("from main\n");
      expect(await showMain(repo.bare, "apps/web/a.ts")).toBe("export const a = 1;\n");
    } finally {
      await repo.cleanup();
    }
  });

  test("main changed a file the pull request changes: updates the branch and waits for CI", async () => {
    const repo = await twoClones();
    try {
      const client = mergingClient(repo.bare, []);
      const edited = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
      edited[0] = "line-1-from-a";
      await commitFile(repo.wtA, "file.txt", `${edited.join("\n")}\n`);
      await pushBranch({
        ...creds(client),
        worktree: repo.wtA,
        issue: "ENG-5",
        remoteUrl: repo.bare,
      });
      const pushed = (await exec("git", ["-C", repo.wtA, "rev-parse", "HEAD"])).stdout.trim();
      const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
      lines[19] = "line-20-from-main";
      await commitFile(repo.wtB, "file.txt", `${lines.join("\n")}\n`);
      await commitFile(repo.wtB, "other.txt", "from main\n");
      await exec("git", ["-C", repo.wtB, "push", "origin", "HEAD:main"]);
      const run = await merge(repo, client);
      expect(run.result.merged).toBe(true);
      expect(run.reverified).toHaveLength(1);
      expect(run.reverified[0]!.kept).toBeUndefined();
      expect(run.reverified[0]!.overlap).toEqual(["file.txt"]);
      expect(run.reverified[0]!.head).not.toBe(pushed);
      expect(run.merges).toEqual([run.reverified[0]!.head]);
      expect(run.rules).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("main changed another file in the same package: updates the branch and waits for CI", async () => {
    const { repo, head, client } = await movedApart("apps/web/b.ts");
    try {
      const run = await merge(repo, client, ["apps/*", "packages/*"]);
      expect(run.result.merged).toBe(true);
      expect(run.reverified).toHaveLength(1);
      expect(run.reverified[0]!.overlap).toEqual(["apps/web"]);
      expect(run.reverified[0]!.head).not.toBe(head);
      expect(run.merges).toEqual([run.reverified[0]!.head]);
    } finally {
      await repo.cleanup();
    }
    const apart = await movedApart("apps/web/b.ts");
    try {
      const run = await merge(apart.repo, apart.client);
      expect(run.reverified).toEqual([{ head: apart.head, kept: true }]);
    } finally {
      await apart.repo.cleanup();
    }
  });

  test("GitHub's up-to-date rule on: falls back to updating the branch and says so", async () => {
    const { repo, head, client } = await movedApart("docs/guide.md");
    try {
      const strict: GitHubClient = {
        async request(req) {
          if (req.method === "GET" && req.path.includes("/rules/branches/"))
            return {
              status: 200,
              body: [
                {
                  type: "required_status_checks",
                  parameters: {
                    strict_required_status_checks_policy: true,
                    required_status_checks: [],
                  },
                },
              ],
            };
          return client.request(req);
        },
      };
      const run = await merge(repo, strict);
      expect(run.result.merged).toBe(true);
      expect(run.rules).toBe(1);
      expect(run.reverified).toHaveLength(1);
      expect(run.reverified[0]!.kept).toBeUndefined();
      expect(run.reverified[0]!.head).not.toBe(head);
      expect(run.merges).toEqual([run.reverified[0]!.head]);
    } finally {
      await repo.cleanup();
    }
  });

  test("a head GitHub refuses to merge without an update is updated instead", async () => {
    const { repo, head, client } = await movedApart("docs/guide.md");
    try {
      let refused = 0;
      const refusing: GitHubClient = {
        async request(req) {
          if (req.path.endsWith("/merge") && (req.body as { sha: string }).sha === head) {
            refused += 1;
            return { status: 405, body: { message: "Head branch is out of date" } };
          }
          return client.request(req);
        },
      };
      const run = await merge(repo, refusing);
      expect(refused).toBe(1);
      expect(run.result.merged).toBe(true);
      expect(run.reverified.map((entry) => entry.kept)).toEqual([true, undefined]);
      expect(run.reverified[1]!.head).not.toBe(head);
    } finally {
      await repo.cleanup();
    }
  });
});

function recordedVerification(result: SerialMergeResult): {
  base: string;
  head: string;
  summary: string;
} {
  if (result.base === undefined || result.head === undefined || result.summary === undefined) {
    throw new Error("parked merge did not record a verification");
  }
  return { base: result.base, head: result.head, summary: result.summary };
}

function ciClient(bare: string, pending: () => boolean): GitHubClient {
  const client = mergingClient(bare, []);
  return {
    async request(req) {
      if (req.path === "/graphql" && pending()) {
        const { head } = (req.body as { variables: { head: string } }).variables;
        const body = fakeMergeReadiness(head);
        body.data.repository.object.statusCheckRollup.contexts.nodes = [
          { name: "ci", conclusion: null },
        ];
        return { status: 200, body };
      }
      return client.request(req);
    },
  };
}

describe("Git transport failures and rejected pushes", () => {
  const timedOut =
    "fatal: unable to access 'https://github.com/pmdroid/paws-app.git/': Connection timed out after 300047 milliseconds\n";

  function networkExec(
    bare: string,
    onCall: (command: "fetch" | "push", args: string[]) => Promise<void>,
  ): GitExec {
    const real = defaultGitExec();
    return async (args, options) => {
      const command = args.includes("push") ? "push" : args.includes("fetch") ? "fetch" : null;
      if (command && args.includes(bare)) await onCall(command, args);
      return real(args, options);
    };
  }

  test("a fetch that times out twice and then succeeds still merges", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "candidate\n");
      let fetches = 0;
      const sleeps: number[] = [];
      const result = await serialMerge({
        ...creds(mergingClient(repo.bare, [])),
        worktree: repo.work,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: repo.bare,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        gitExec: networkExec(repo.bare, async (command, args) => {
          if (command !== "fetch") return;
          fetches += 1;
          if (fetches <= 2) throw new GitCommandError(args, timedOut);
        }),
        reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
      });
      expect(result).toMatchObject({ merged: true, outcome: "merged" });
      expect(sleeps.slice(0, 2)).toEqual([5_000, 20_000]);
    } finally {
      await repo.cleanup();
    }
  });

  test("a fetch that keeps timing out throws a transient error for the job to retry", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "candidate\n");
      let fetches = 0;
      const merging = serialMerge({
        ...creds(mergingClient(repo.bare, [])),
        worktree: repo.work,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: repo.bare,
        sleep: async () => {},
        gitExec: networkExec(repo.bare, async (command, args) => {
          if (command !== "fetch") return;
          fetches += 1;
          throw new GitCommandError(args, timedOut);
        }),
        reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
      });
      const error = await merging.then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(fetches).toBe(3);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("fetch failed: fatal: unable to access");
      expect(((error as Error).cause as Error).name).toBe("GitTransportError");
    } finally {
      await repo.cleanup();
    }
  });

  test("a rejected push reports Git's reason without the token", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "candidate\n");
      const result = await serialMerge({
        ...creds(mergingClient(repo.bare, [])),
        worktree: repo.work,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: repo.bare,
        sleep: async () => {},
        gitExec: networkExec(repo.bare, async (command, args) => {
          if (command !== "push") return;
          throw new GitCommandError(
            args,
            "remote: error: GH006: Protected branch update failed for refs/heads/paws/ENG-8.\nerror: failed to push some refs to 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz@github.com/pmdroid/paws-demo.git'\n",
          );
        }),
        reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
      });
      expect(result.outcome).toBe("push_rejected");
      expect(result.message).toContain("push rejected: remote: error: GH006: Protected branch");
      expect(result.message).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz");
    } finally {
      await repo.cleanup();
    }
  });

  test("a push refused before Git ran reports that reason", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "candidate\n");
      const result = await serialMerge({
        ...creds(mergingClient(repo.bare, [])),
        worktree: repo.work,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: repo.bare,
        sleep: async () => {},
        gitExec: networkExec(repo.bare, async (command) => {
          if (command === "push") throw new Error("The Linear publication was superseded.");
        }),
        reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
      });
      expect(result).toMatchObject({
        outcome: "push_rejected",
        message: "push rejected: The Linear publication was superseded.",
      });
    } finally {
      await repo.cleanup();
    }
  });

  for (const moves of [1, 2]) {
    test(`a lease conflict re-reads the branch and pushes once more (${moves} remote move)`, async () => {
      const repo = await oneClone();
      const other = await cloneOf(repo.bare);
      try {
        await exec("git", ["-C", other, "push", "origin", "HEAD:refs/heads/paws/ENG-8"]);
        await commitFile(repo.work, "file.txt", "candidate\n");
        let pushes = 0;
        const result = await serialMerge({
          ...creds(mergingClient(repo.bare, [])),
          worktree: repo.work,
          issue: "ENG-8",
          prNumber: 8,
          remoteUrl: repo.bare,
          sleep: async () => {},
          gitExec: networkExec(repo.bare, async (command) => {
            if (command !== "push") return;
            pushes += 1;
            if (pushes > moves) return;
            await commitFile(other, `moved-${pushes}.txt`, "moved\n");
            await exec("git", ["-C", other, "push", "-f", "origin", "HEAD:refs/heads/paws/ENG-8"]);
          }),
          reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
        });
        expect(pushes).toBe(2);
        if (moves === 1) expect(result).toMatchObject({ merged: true, outcome: "merged" });
        else {
          expect(result.outcome).toBe("push_rejected");
          expect(result.message).toContain("stale info");
        }
      } finally {
        await rm(other, { recursive: true, force: true });
        await repo.cleanup();
      }
    });
  }
});

function creds(client: GitHubClient) {
  return {
    owner: "pmdroid",
    repo: "paws-demo",
    appId: "11",
    installationId: "22",
    privateKeyPem: PRIVATE_KEY,
    client,
  };
}

function tokenBody(token: string) {
  return {
    token,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    repository_selection: "selected",
    repositories: [{ name: "paws-demo", full_name: "pmdroid/paws-demo" }],
    permissions: { ...INSTALLATION_PERMISSIONS, metadata: "read" },
  };
}

function tokenClient(next: () => string): GitHubClient {
  return {
    async request(req) {
      if (!req.path.endsWith("/access_tokens")) return { status: 404, body: {} };
      return { status: 201, body: tokenBody(next()) };
    },
  };
}

function mergingClient(
  bare: string,
  sink: string[],
  onMerge?: () => GitHubResponse | null,
): GitHubClient {
  let n = 0;
  return {
    async request(req) {
      if (req.path === "/graphql") {
        const { head } = (req.body as { variables: { head: string } }).variables;
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      if (req.path.endsWith("/access_tokens")) {
        n += 1;
        const token = `ghs_merge_${n}`;
        sink.push(token);
        return { status: 201, body: tokenBody(token) };
      }
      if (req.path.endsWith("/merge")) {
        const custom = onMerge?.();
        if (custom) return custom;
        const sha = await squashBranch(bare, req);
        return { status: 200, body: { sha, merged: true, message: "merged" } };
      }
      return fakeRequiredChecks(req) ?? { status: 404, body: {} };
    },
  };
}

async function squashBranch(bare: string, req: { body?: unknown }): Promise<string> {
  const body = req.body as { sha?: string; commit_message?: string };
  expect(body.commit_message?.split("\n")[0]).toMatch(/^Fixes ENG-/);
  expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
  const tmp = await mkdtemp(path.join(tmpdir(), "paws-squash-"));
  try {
    await exec("git", ["clone", bare, tmp]);
    await gitIdentity(tmp);
    const listed = (
      await exec("git", [
        "-C",
        tmp,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/remotes/origin/paws",
      ])
    ).stdout.trim();
    const match = listed.split("\n").find((line) => line.startsWith(`${body.sha} `));
    if (!match) throw new Error(`no pushed branch at ${body.sha}`);
    const ref = match.slice(body.sha!.length).trim();
    await exec("git", ["-C", tmp, "merge", "--squash", ref]);
    await exec("git", ["-C", tmp, "commit", "-m", body.commit_message ?? "squash"]);
    await exec("git", ["-C", tmp, "push", "origin", "HEAD:main"]);
    return (await exec("git", ["-C", tmp, "rev-parse", "HEAD"])).stdout.trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function gitIdentity(dir: string): Promise<void> {
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

async function oneClone(): Promise<{
  root: string;
  bare: string;
  work: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-gh-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, work]);
  await gitIdentity(work);
  await writeFile(
    path.join(work, "file.txt"),
    `${Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n")}\n`,
  );
  await exec("git", ["-C", work, "add", "file.txt"]);
  await exec("git", ["-C", work, "commit", "-m", "init"]);
  await exec("git", ["-C", work, "push", "origin", "HEAD:main"]);
  return { root, bare, work, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function twoClones(): Promise<{
  bare: string;
  wtA: string;
  wtB: string;
  cleanup: () => Promise<void>;
}> {
  const repo = await oneClone();
  const wtB = path.join(repo.root, "wtB");
  await exec("git", ["clone", repo.bare, wtB]);
  await gitIdentity(wtB);
  return { bare: repo.bare, wtA: repo.work, wtB, cleanup: repo.cleanup };
}

async function cloneOf(bare: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "paws-other-"));
  await exec("git", ["clone", bare, dir]);
  await gitIdentity(dir);
  return dir;
}

async function commitFile(dir: string, file: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, file), contents);
  await exec("git", ["-C", dir, "add", file]);
  await exec("git", ["-C", dir, "commit", "-m", `edit ${file}`]);
}

async function showMain(bare: string, file: string): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "paws-show-"));
  try {
    await exec("git", ["clone", bare, tmp]);
    return await readFile(path.join(tmp, file), "utf8");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
