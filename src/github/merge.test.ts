import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { branchForIssue, fixesLine } from "./branch";
import { fakeMergeReadiness, fakeRequiredChecks } from "./fake";
import { defaultGitExec } from "./git";
import { readPullFacts, rebaseOntoMain, squashPull, type SerialMergeInput } from "./merge";
import { openPullRequest, publishAccepted, pushBranch } from "./pulls";
import {
  GitCommandError,
  INSTALLATION_PERMISSIONS,
  type GitExec,
  type GitHubClient,
  type GitHubResponse,
} from "./types";

const exec = promisify(execFile);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey as string;

describe("pull requests", () => {
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
});

describe("merge lane: read facts, rebase, squash with the expected head", () => {
  for (const scenario of ["failed CI", "unreadable gates", "closed PR", "moved PR head"]) {
    test(`reading the facts with ${scenario} reports it and merges nothing`, async () => {
      const repo = await oneClone();
      try {
        await commitFile(repo.work, "file.txt", "candidate\n");
        const client = mergingClient(repo.bare, []);
        let merges = 0;
        const guarded: GitHubClient = {
          async request(req) {
            if (req.path === "/graphql" && readinessHead(req) !== undefined) {
              if (scenario === "unreadable gates") return { status: 403, body: {} };
              const body = fakeMergeReadiness(readinessHead(req)!);
              const repository = body.data.repository;
              if (scenario === "failed CI")
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
        const read = await readPullFacts({ ...lane(repo, guarded, 8), sleep: async () => {} });
        expect(read.kind).toBe("facts");
        if (read.kind !== "facts") return;
        expect(read.containsMain).toBe(true);
        expect(read.readiness.outcome).toBe(
          scenario === "moved PR head"
            ? "sha_moved"
            : scenario === "failed CI"
              ? "ci_failed"
              : "blocked",
        );
        expect(merges).toBe(0);
      } finally {
        await repo.cleanup();
      }
    });
  }

  test("reading the facts neither rebases nor pushes, and sees when main moved", async () => {
    const repo = await twoClones();
    try {
      const client = mergingClient(repo.bare, []);
      await commitFile(repo.wtA, "file.txt", "candidate\n");
      await pushBranch({
        ...creds(client),
        worktree: repo.wtA,
        issue: "ENG-8",
        remoteUrl: repo.bare,
      });
      const head = await revParse(repo.wtA, "HEAD");
      const first = await readPullFacts(lane({ ...repo, work: repo.wtA }, client, 8));
      expect(first).toMatchObject({ kind: "facts", head, containsMain: true });

      await commitFile(repo.wtB, "other.txt", "new main\n");
      await exec("git", ["-C", repo.wtB, "push", "origin", "HEAD:main"]);
      const second = await readPullFacts(lane({ ...repo, work: repo.wtA }, client, 8));
      expect(second).toMatchObject({ kind: "facts", head, containsMain: false });
      expect(await revParse(repo.wtA, "HEAD")).toBe(head);
      expect(await remoteBranch(repo.bare, "paws/ENG-8")).toBe(head);
    } finally {
      await repo.cleanup();
    }
  });

  test("pending CI and unresolved threads are read once, without sleeping", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "candidate\n");
      let sleeps = 0;
      let threads = false;
      const client = mergingClient(repo.bare, []);
      const reading: GitHubClient = {
        async request(req) {
          const head = req.path === "/graphql" ? readinessHead(req) : undefined;
          if (head === undefined) return client.request(req);
          const body = fakeMergeReadiness(head);
          if (threads)
            body.data.repository.pullRequest.reviewThreads = {
              nodes: [{ isResolved: false }, { isResolved: true }],
              pageInfo: { hasNextPage: false, endCursor: null },
            };
          else
            body.data.repository.object.statusCheckRollup.contexts.nodes = [
              { name: "ci", conclusion: null },
            ];
          return { status: 200, body };
        },
      };
      const input = { ...lane(repo, reading, 8), sleep: async () => void (sleeps += 1) };
      const pending = await readPullFacts(input);
      expect(pending).toMatchObject({
        kind: "facts",
        readiness: { outcome: "pending", message: "Waiting for checks: ci." },
      });
      threads = true;
      const open = await readPullFacts(input);
      expect(open).toMatchObject({
        kind: "facts",
        readiness: { outcome: "pending", unresolvedThreads: 1 },
      });
      expect(sleeps).toBe(0);
    } finally {
      await repo.cleanup();
    }
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
    const read = await readPullFacts(lane(repo, client, 6));
    expect(read).toMatchObject({ kind: "stopped", result: { outcome: "dirty" } });
    expect(calls).toBe(0);
    await repo.cleanup();
  });

  test("squash carries the expected head, and GitHub's 409 is a moved head, not a retry", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "one\n");
      let merges = 0;
      const shas: string[] = [];
      const client = mergingClient(repo.bare, [], (req) => {
        merges += 1;
        shas.push((req.body as { sha: string }).sha);
        return { status: 409, body: { message: "Head branch was modified" } };
      });
      const head = await revParse(repo.work, "HEAD");
      const result = await squashPull(lane(repo, client, 8), head, "accepted");
      expect(result).toMatchObject({ merged: false, outcome: "sha_moved", head });
      expect(merges).toBe(1);
      expect(shas).toEqual([head]);
    } finally {
      await repo.cleanup();
    }
  });

  test("a stop before the squash merges nothing", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "one\n");
      let merges = 0;
      const client = mergingClient(repo.bare, [], () => {
        merges += 1;
        return null;
      });
      const result = await squashPull(
        { ...lane(repo, client, 8), isCancelled: () => true },
        await revParse(repo.work, "HEAD"),
        "accepted",
      );
      expect(result).toMatchObject({
        merged: false,
        outcome: "blocked",
        message: "merge cancelled",
      });
      expect(merges).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  test("Paws-controlled squash preserves both human trailers without claiming GitHub committer control", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "candidate.txt", "candidate\n");
      const client = mergingClient(repo.bare, []);
      await pushBranch({
        ...creds(client),
        worktree: repo.work,
        issue: "ENG-8",
        remoteUrl: repo.bare,
      });
      let message = "";
      const result = await squashPull(
        {
          ...lane(
            repo,
            {
              async request(request) {
                if (request.path.endsWith("/merge"))
                  message = (request.body as { commit_message: string }).commit_message;
                return client.request(request);
              },
            },
            8,
          ),
          commitMessage:
            "accepted\n\nCo-authored-by: Lead <7+lead@users.noreply.github.com>\nCo-authored-by: Steerer <8+steerer@users.noreply.github.com>\n",
        },
        await revParse(repo.work, "HEAD"),
        "accepted",
      );
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

  test("merges two items in order: the second is rebased onto the new main before it can merge", async () => {
    const repo = await twoClones();
    try {
      const tokens: string[] = [];
      const client = mergingClient(repo.bare, tokens);
      const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
      await commitFile(
        repo.wtA,
        "file.txt",
        ["line-1-from-a", ...lines.slice(1)].join("\n") + "\n",
      );
      await pushBranch({
        ...creds(client),
        worktree: repo.wtA,
        issue: "ENG-1",
        remoteUrl: repo.bare,
      });
      const a = { ...lane({ ...repo, work: repo.wtA }, client, 1), issue: "ENG-1" };
      const factsA = await readPullFacts(a);
      expect(factsA).toMatchObject({ kind: "facts", containsMain: true });
      const headA = await revParse(repo.wtA, "HEAD");
      expect((await squashPull(a, headA, "Closeout: accepted")).merged).toBe(true);

      const changedTail = [...lines];
      changedTail[19] = "line-20-from-b";
      await commitFile(repo.wtB, "file.txt", `${changedTail.join("\n")}\n`);
      await pushBranch({
        ...creds(client),
        worktree: repo.wtB,
        issue: "ENG-2",
        remoteUrl: repo.bare,
      });
      const b = {
        ...lane({ ...repo, work: repo.wtB }, client, 2),
        issue: "ENG-2",
        onCredential: (purpose: "push" | "merge", token: string) =>
          tokens.push(`${purpose}:${token}`),
      };
      const stale = await readPullFacts(b);
      expect(stale).toMatchObject({ kind: "facts", containsMain: false });
      const rebased = await rebaseOntoMain(b);
      expect(rebased.rebased).toBe(true);
      if (!rebased.rebased) return;
      expect(rebased.head).toBe(await revParse(repo.wtB, "HEAD"));
      expect(await remoteBranch(repo.bare, "paws/ENG-2")).toBe(rebased.head);
      const fresh = await readPullFacts(b);
      expect(fresh).toMatchObject({ kind: "facts", head: rebased.head, containsMain: true });
      expect((await squashPull(b, rebased.head, "Closeout: accepted")).merged).toBe(true);
      const main = await showMain(repo.bare, "file.txt");
      expect(main.startsWith("line-1-from-a\n")).toBe(true);
      expect(main.endsWith("line-20-from-b\n")).toBe(true);
      expect(tokens.some((entry) => entry.startsWith("push:"))).toBe(true);
      expect(tokens.some((entry) => entry.startsWith("merge:"))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test("aborts a rebase conflict and reports its files", async () => {
    const repo = await oneClone();
    const other = await cloneOf(repo.bare);
    try {
      await commitFile(repo.work, "file.txt", "from-item\n");
      await commitFile(other, "file.txt", "from-main\n");
      await exec("git", ["-C", other, "push", "origin", "HEAD:main"]);
      const result = await rebaseOntoMain(lane(repo, mergingClient(repo.bare, []), 7));
      expect(result).toMatchObject({
        rebased: false,
        result: { outcome: "conflict", conflictFiles: ["file.txt"] },
      });
      const status = (await exec("git", ["-C", repo.work, "status"])).stdout;
      expect(status).not.toContain("rebase in progress");
    } finally {
      await repo.cleanup();
      await rm(other, { recursive: true, force: true });
    }
  });
});

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

  test("a fetch that times out twice and then succeeds still reads the facts", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "candidate\n");
      let fetches = 0;
      const sleeps: number[] = [];
      const result = await readPullFacts({
        ...lane(repo, mergingClient(repo.bare, []), 8),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        gitExec: networkExec(repo.bare, async (command, args) => {
          if (command !== "fetch") return;
          fetches += 1;
          if (fetches <= 2) throw new GitCommandError(args, timedOut);
        }),
      });
      expect(result).toMatchObject({ kind: "facts", containsMain: true });
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
      const merging = readPullFacts({
        ...lane(repo, mergingClient(repo.bare, []), 8),
        sleep: async () => {},
        gitExec: networkExec(repo.bare, async (command, args) => {
          if (command !== "fetch") return;
          fetches += 1;
          throw new GitCommandError(args, timedOut);
        }),
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
      const result = await rebaseOntoMain({
        ...lane(repo, mergingClient(repo.bare, []), 8),
        sleep: async () => {},
        gitExec: networkExec(repo.bare, async (command, args) => {
          if (command !== "push") return;
          throw new GitCommandError(
            args,
            "remote: error: GH006: Protected branch update failed for refs/heads/paws/ENG-8.\nerror: failed to push some refs to 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz@github.com/pmdroid/paws-demo.git'\n",
          );
        }),
      });
      expect(result.rebased).toBe(false);
      if (result.rebased) return;
      expect(result.result.outcome).toBe("push_rejected");
      expect(result.result.message).toContain(
        "push rejected: remote: error: GH006: Protected branch",
      );
      expect(result.result.message).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz");
    } finally {
      await repo.cleanup();
    }
  });

  test("a push refused before Git ran reports that reason", async () => {
    const repo = await oneClone();
    try {
      await commitFile(repo.work, "file.txt", "candidate\n");
      const result = await rebaseOntoMain({
        ...lane(repo, mergingClient(repo.bare, []), 8),
        sleep: async () => {},
        gitExec: networkExec(repo.bare, async (command) => {
          if (command === "push") throw new Error("The Linear publication was superseded.");
        }),
      });
      expect(result).toMatchObject({
        rebased: false,
        result: {
          outcome: "push_rejected",
          message: "push rejected: The Linear publication was superseded.",
        },
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
        const result = await rebaseOntoMain({
          ...lane(repo, mergingClient(repo.bare, []), 8),
          sleep: async () => {},
          gitExec: networkExec(repo.bare, async (command) => {
            if (command !== "push") return;
            pushes += 1;
            if (pushes > moves) return;
            await commitFile(other, `moved-${pushes}.txt`, "moved\n");
            await exec("git", ["-C", other, "push", "-f", "origin", "HEAD:refs/heads/paws/ENG-8"]);
          }),
        });
        expect(pushes).toBe(2);
        if (moves === 1) expect(result.rebased).toBe(true);
        else {
          expect(result).toMatchObject({ rebased: false, result: { outcome: "push_rejected" } });
          if (!result.rebased) expect(result.result.message).toContain("stale info");
        }
      } finally {
        await rm(other, { recursive: true, force: true });
        await repo.cleanup();
      }
    });
  }
});

function lane(
  repo: { bare: string; work: string },
  client: GitHubClient,
  pr: number,
): SerialMergeInput {
  return {
    ...creds(client),
    worktree: repo.work,
    issue: "ENG-8",
    prNumber: pr,
    remoteUrl: repo.bare,
  };
}

/** The head a merge readiness read asks about; undefined for the review read. */
function readinessHead(req: { body?: unknown }): string | undefined {
  return (req.body as { variables?: { head?: string } }).variables?.head;
}

async function revParse(dir: string, ref: string): Promise<string> {
  return (await exec("git", ["-C", dir, "rev-parse", ref])).stdout.trim();
}

async function remoteBranch(bare: string, branch: string): Promise<string> {
  return (
    await exec("git", ["--git-dir", bare, "rev-parse", `refs/heads/${branch}`])
  ).stdout.trim();
}

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
  onMerge?: (req: { body?: unknown }) => GitHubResponse | null,
): GitHubClient {
  let n = 0;
  return {
    async request(req) {
      if (req.path === "/graphql") {
        const head = readinessHead(req);
        if (head === undefined)
          return {
            status: 200,
            body: { data: { repository: { pullRequest: { reviewDecision: null } } } },
          };
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      if (req.path.endsWith("/access_tokens")) {
        n += 1;
        const token = `ghs_merge_${n}`;
        sink.push(token);
        return { status: 201, body: tokenBody(token) };
      }
      if (req.path.endsWith("/merge")) {
        const custom = onMerge?.(req);
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
