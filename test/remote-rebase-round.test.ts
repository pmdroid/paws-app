import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type RunAgentOptions } from "../src/acp";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getWorkItem,
  listJobs,
  listWorkItems,
  migrate,
  openDatabase,
} from "../src/db";
import { fakeMergeReadiness } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, legacyTaskBranch, taskBranch } from "../src/loop";
import { fetchRunnerCandidate } from "../src/runner-backend";

const fakeAgent = join(import.meta.dir, "../src/acp/testing/fake-agent.ts");

type Round = { base: string; candidate: string; pushedTo: string | null; fetched: string };

/**
 * Orchestrator with the remote runner stood in by a fake that runs the agent, publishes a new
 * commit to the task's branch the way the runner runtime does, and lets Paws import it with
 * the real candidate fetch. `losePublication` drops the push, so the fetch fails.
 */
async function remoteFixture(losePublication = false) {
  const root = mkdtempSync(join(tmpdir(), "paws-remote-rebase-"));
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const home = join(root, "paws");
  mkdirSync(home, { mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  async function git(args: string[]) {
    const child = Bun.spawn(["/usr/bin/git", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  }
  // The rebase before a merge commits with the process identity, as on a host.
  const identity = {
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
  await git(["init", "-b", "main", source]);
  mkdirSync(join(source, ".agents"));
  writeFileSync(join(source, "README.md"), "Fixture\n");
  writeFileSync(
    join(source, ".agents/closeout.yaml"),
    JSON.stringify({
      specVersion: "0.1",
      items: [
        {
          id: "check",
          kind: "command",
          gate: "beforePR",
          exec: ["/forbidden-local-check", "check"],
          timeoutSeconds: 5,
        },
      ],
    }),
  );
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Fixture policy"]);
  await git(["clone", "--bare", source, origin]);

  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-42",
      title: "Write output",
      description: null,
      subIssues: [],
    },
  ]);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const pullHeads: string[] = [];
  const deleted: string[] = [];
  const rounds: Round[] = [];
  let round = 0;

  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: home,
    home,
    tracker,
    repository: { owner: "acme", repo: "fixture", remoteUrl: origin },
    github: {
      appId: "",
      installationId: "",
      privateKeyPem: "",
      tokenProvider: { mode: "oauth" as const, tokenFor: async () => "fixture-github-token" },
      client: {
        async request(request: { method: string; path: string; body?: unknown }) {
          if (request.path === "/graphql") {
            const { head } = (request.body as { variables: { head: string } }).variables;
            return { status: 200, body: fakeMergeReadiness(head) };
          }
          if (request.method === "POST" && request.path.endsWith("/pulls")) {
            pullHeads.push((request.body as { head: string }).head);
            return {
              status: 201,
              body: {
                number: 1,
                html_url: "https://github.com/acme/fixture/pull/1",
                body: (request.body as { body: string }).body,
              },
            };
          }
          if (request.method === "PUT" && request.path.endsWith("/merge")) {
            const { sha } = request.body as { sha: string };
            await git(["-C", source, "fetch", origin, "main", sha]);
            await git(["-C", source, "reset", "--hard", "FETCH_HEAD"]);
            await git(["-C", source, "merge", "--squash", sha]);
            await git(["-C", source, "commit", "-m", "Fixture merge"]);
            await git(["-C", source, "push", origin, "HEAD:main"]);
            return {
              status: 200,
              body: { merged: true, sha: await git(["-C", source, "rev-parse", "HEAD"]) },
            };
          }
          if (request.method === "DELETE" && request.path.includes("/git/refs/heads/")) {
            deleted.push(request.path.split("/git/refs/heads/")[1]!);
            return { status: 204, body: null };
          }
          throw new Error(`Unexpected fixture GitHub request ${request.method} ${request.path}`);
        },
      },
    },
    launch() {
      return { command: "/forbidden-local-agent", args: [] };
    },
    remoteExecution: {
      agentForSession() {
        throw new Error("This fixture does not request a routing helper");
      },
      agentForItem(itemId) {
        return async (options: RunAgentOptions) => {
          if (options.prepareOnly || options.role !== "implementer")
            throw new Error(`Unexpected ${options.role} dispatch`);
          round++;
          const base = await git(["-C", options.worktreePath, "rev-parse", "HEAD"]);
          const script = join(home, `agent-${round}.json`);
          writeFileSync(
            script,
            JSON.stringify({
              sessionId: `session-${round}`,
              model: "fixture-implement-model",
              steps: [
                ...(round === 1
                  ? [
                      {
                        type: "fs_write",
                        path: join(options.worktreePath, "result.txt"),
                        content: "done\n",
                      },
                    ]
                  : []),
                {
                  type: "update",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: `Round ${round}` },
                  },
                },
                { type: "end" },
              ],
            }),
          );
          const result = await runAgent({
            ...options,
            command: process.execPath,
            args: [fakeAgent, "", script],
            env: { PATH: process.env.PATH!, HOME: home },
          });
          const candidate = await git(["-C", options.worktreePath, "rev-parse", "HEAD"]);
          const branch = getWorkItem(db, itemId)!.branchName;
          let pushedTo: string | null = null;
          if (candidate !== base && !losePublication) {
            await git([
              "-C",
              options.worktreePath,
              "push",
              origin,
              `${candidate}:refs/heads/${branch}`,
            ]);
            pushedTo = branch;
          }
          await git(["-C", options.worktreePath, "reset", "--hard", base]);
          let fetched = "";
          await fetchRunnerCandidate({
            worktree: options.worktreePath,
            baseSha: base,
            candidateSha: candidate,
            branch: getWorkItem(db, itemId)!.branchName,
            remoteUrl: origin,
            networkGit: (args) => {
              fetched = args.at(-1)!.split(":")[0]!.slice("refs/heads/".length);
              return git(args);
            },
            signal: options.signal ?? new AbortController().signal,
          });
          rounds.push({ base, candidate, pushedTo, fetched });
          return {
            ...result,
            closeoutReport: JSON.stringify({
              required: [
                {
                  id: "check",
                  status: "passed",
                  result: {
                    argv: ["/forbidden-local-check", "check"],
                    head: candidate,
                    exitCode: 0,
                    timedOut: false,
                    durationMs: 1,
                    stdout: "ok\n",
                    stderr: "",
                    truncated: false,
                  },
                },
              ],
              pending: [],
              blocked: null,
              bypassed: false,
            }),
          };
        };
      },
    },
  });

  const drain = async () => {
    for (let i = 0; i < 20 && (await jobs.tick()); i++);
    while (outbox.tick().length > 0) await outbox.idle();
  };
  const close = async () => {
    await orchestrator.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return {
    db,
    git,
    source,
    origin,
    tracker,
    jobs,
    orchestrator,
    rounds,
    pullHeads,
    deleted,
    drain,
    close,
  };
}

test("a round after the rebase before a merge imports the rebased commit and merges", async () => {
  const {
    db,
    git,
    source,
    origin,
    tracker,
    jobs,
    orchestrator,
    rounds,
    pullHeads,
    deleted,
    drain,
    close,
  } = await remoteFixture();
  try {
    await orchestrator.onLinearEvent(event("created", null));
    await jobs.tick();
    let item = listWorkItems(db)[0]!;
    expect(item.state).toBe("merge_queue");
    const branch = taskBranch(item);
    expect(branch).toStartWith("paws/ENG-42-");
    expect(item.branchName).toBe(branch);

    // Main moves, so the merge rebases the accepted commit and pushes it to the task branch.
    writeFileSync(join(source, "other.txt"), "main moved\n");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "commit", "-m", "Main moved"]);
    await git(["-C", source, "push", origin, "HEAD:main"]);
    await jobs.tick();
    item = getWorkItem(db, item.id)!;
    expect(item.state).toBe("awaiting_input");
    const rebased = await git(["--git-dir", origin, "rev-parse", `refs/heads/${branch}`]);
    expect(rebased).not.toBe(rounds[0]!.candidate);

    const beforeReply = rounds.length;
    await orchestrator.onLinearEvent(event("prompted", "Carry on"));
    await drain();
    item = getWorkItem(db, item.id)!;
    expect(tracker.progress.filter((entry) => entry.kind === "error")).toEqual([]);
    expect(rounds.length).toBeGreaterThan(beforeReply);
    // Every round after the rebase commits nothing: its candidate is the rebased commit,
    // nothing is published and nothing needs fetching.
    for (const later of rounds.slice(1))
      expect(later).toEqual({ base: rebased, candidate: rebased, pushedTo: null, fetched: "" });
    expect(item.state).toBe("merged");
    expect(listJobs(db).filter((job) => job.status !== "done")).toEqual([]);

    // One branch: where the runner pushed, the pull request head and the fetched branch.
    expect(rounds[0]!.pushedTo).toBe(branch);
    expect(rounds[0]!.fetched).toBe(branch);
    expect(new Set(pullHeads)).toEqual(new Set([branch]));
    expect(deleted).toEqual([legacyTaskBranch(item)!]);
  } finally {
    await close();
  }
}, 60_000);

test("a failed candidate fetch posts its reason to the Linear session before the task fails", async () => {
  const { db, tracker, jobs, orchestrator, rounds, drain, close } = await remoteFixture(true);
  try {
    await orchestrator.onLinearEvent(event("created", null));
    await jobs.tick();
    await drain();
    const item = listWorkItems(db)[0]!;
    expect(rounds).toEqual([]);
    expect(item.state).toBe("failed");
    const errors = tracker.progress.filter((entry) => entry.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.body).toStartWith(`Paws could not import the runner's commit `);
    expect(errors[0]!.body).toContain(` from ${taskBranch(item)}: `);
  } finally {
    await close();
  }
}, 60_000);

function event(action: "created" | "prompted", body: string | null): AcceptedLinearEvent {
  return {
    dedupeKey: action === "created" ? "created:issue" : `activity:${body}`,
    deliveryId: null,
    source: "webhook",
    action,
    sessionId: "session",
    issueId: "issue",
    activityId: action === "created" ? null : `act-${body}`,
    actorId: action === "created" ? null : "human-1",
    body,
    signal: null,
    updatedAtMs: Date.now() + (action === "created" ? 0 : 1_000),
    payload: "{}",
  };
}
