import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  bindWorkItemRepository,
  enterMergeQueue,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listRebaseReturns,
  migrate,
  openDatabase,
  recordItemPullRequest,
  recordRebaseReturn,
} from "../db";
import { GitHubHttpError, type GitHubClient } from "../github";
import { REBASE_CONFLICT_INSTRUCTION } from "../merge";
import { findOpenQuestion } from "../questions";
import { Orchestrator } from "./orchestrator";

const HEAD = "6496aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MAIN = "c0ffee0000000000000000000000000000000000";

async function fixture(mergeable: boolean | null) {
  const root = await mkdtemp(join(tmpdir(), "paws-merge-server-error-"));
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  const reads: string[] = [];
  const lines: string[] = [];
  const orchestrator = new Orchestrator({
    db,
    clock,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    journal: (line) => lines.push(line),
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: "unused",
      tokenProvider: { mode: "token", tokenFor: async () => "fake-token" },
      client: {
        request: async (req: Parameters<GitHubClient["request"]>[0]) => {
          reads.push(`${req.method} ${req.path}`);
          return {
            status: 200,
            body: {
              state: "open",
              mergeable,
              mergeable_state: mergeable === false ? "dirty" : mergeable ? "clean" : "unknown",
              head: { sha: HEAD },
            },
          };
        },
      },
    }),
  });
  orchestrator["fetchUpstreamMain"] = async () => MAIN;
  insertQueuedItem(db, { id: "DEP-661", sessionKey: "ses-1", now: clock.now() });
  bindWorkItemRepository(db, "DEP-661", {
    owner: "acme",
    repo: "monorepo",
    remoteUrl: "https://github.com/acme/monorepo.git",
  });
  beginImplementRun(db, "DEP-661", clock.now());
  enterMergeQueue(db, "DEP-661", { phase: "merge_queue", baseSha: MAIN, wipCommit: HEAD });
  recordItemPullRequest(db, {
    itemId: "DEP-661",
    pullNumber: 6496,
    pullUrl: "https://github.com/acme/monorepo/pull/6496",
    openedAt: clock.now(),
  });
  const context = {
    signal: new AbortController().signal,
    isCurrent: () => true,
    extendLease: () => true,
  };
  return {
    db,
    reads,
    lines,
    failed: (status: number) =>
      orchestrator["sendBackAfterServerError"](
        { itemId: "DEP-661" },
        new GitHubHttpError({ status, body: {} }),
        context,
      ),
    resumes: () => listJobs(db).filter((job) => job.queue === JOB_KIND.resume),
    cleanup: async () => {
      await orchestrator.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a merge attempt that gets HTTP 500 on a conflicting pull request goes back to rebase", async () => {
  const f = await fixture(false);
  try {
    expect(await f.failed(500)).toBe(true);
    expect(f.reads).toEqual(["GET /repos/acme/monorepo/pulls/6496"]);
    expect(getWorkItem(f.db, "DEP-661")?.state).not.toBe("merge_queue");
    const [resume] = f.resumes();
    const payload = resume?.payload as { reason: string; handoff: string };
    expect(payload.reason).toBe("conflict");
    expect(payload.handoff.startsWith(REBASE_CONFLICT_INSTRUCTION)).toBe(true);
    expect(payload.handoff).toContain("git reset --soft $(git merge-base HEAD origin/main)");
    expect(listRebaseReturns(f.db, "DEP-661", 0)).toMatchObject([{ base: MAIN, reason: "merge" }]);
    expect(f.lines.filter((line) => line.includes("conflicts with main"))).toEqual([
      `item DEP-661 merge attempt got GitHub HTTP 500; pull request #6496 at ${HEAD.slice(0, 7)}: the pull request conflicts with main. Sent back to the agent to rebase.`,
    ]);
  } finally {
    await f.cleanup();
  }
});

test("an HTTP 500 on a conflicting pull request with the rebase budget spent asks", async () => {
  const f = await fixture(false);
  try {
    for (let spent = 0; spent < 3; spent++)
      recordRebaseReturn(f.db, {
        itemId: "DEP-661",
        jobId: 900 + spent,
        candidate: `earlier-${spent}`,
        reason: "merge",
        base: MAIN,
        files: null,
        recordedAt: 1_000,
      });
    expect(await f.failed(500)).toBe(true);
    expect(f.resumes()).toEqual([]);
    expect(getWorkItem(f.db, "DEP-661")?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses-1")).toMatchObject({ reason: "rebase_budget_spent" });
  } finally {
    await f.cleanup();
  }
});

test.each([true, null])(
  "a 502 on a pull request whose mergeable is %p keeps the retry",
  async (merges) => {
    const f = await fixture(merges);
    try {
      expect(await f.failed(502)).toBe(false);
      expect(f.reads).toHaveLength(1);
      expect(f.resumes()).toEqual([]);
      expect(getWorkItem(f.db, "DEP-661")?.state).toBe("merge_queue");
    } finally {
      await f.cleanup();
    }
  },
);

test("a 4xx does not read the pull request", async () => {
  const f = await fixture(false);
  try {
    expect(await f.failed(422)).toBe(false);
    expect(f.reads).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
