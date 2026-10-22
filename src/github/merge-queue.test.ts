import { describe, expect, test } from "bun:test";
import { createFakeMergeQueue, fakeMergeReadiness, fakeRequiredChecks } from "./fake";
import { classifyRemoval, githubQueueLine, githubQueueMerge, hasMergeQueue } from "./merge-queue";
import type { GitHubClient } from "./types";

const HEAD = "a".repeat(40);

function harness(options: { branches?: string[]; failing?: boolean; pending?: boolean } = {}) {
  const queue = createFakeMergeQueue({
    ...(options.branches ? { branches: options.branches } : {}),
    headOf: () => HEAD,
    ahead: 1,
  });
  const client: GitHubClient = {
    async request(request) {
      const answered = await queue.respond(request);
      if (answered) return answered;
      if (request.path === "/graphql") {
        const body = fakeMergeReadiness(HEAD);
        if (options.failing)
          body.data.repository.object.statusCheckRollup.contexts.nodes = [
            { name: "test", conclusion: "FAILURE", detailsUrl: "https://ci.example/1" },
          ];
        if (options.pending)
          body.data.repository.object.statusCheckRollup.contexts.nodes = [
            { name: "test", conclusion: null, detailsUrl: null },
          ];
        return { status: 200, body };
      }
      return fakeRequiredChecks(request) ?? { status: 404, body: {} };
    },
  };
  const pass = (queued: boolean) =>
    githubQueueMerge({
      owner: "acme",
      repo: "platform",
      prNumber: 7,
      head: HEAD,
      client,
      tokenProvider: { tokenFor: async () => "ghs_test" } as never,
      queued,
    });
  return { queue, client, pass };
}

describe("GitHub merge queue", () => {
  test("detects whether the base branch has a merge queue", async () => {
    const { client } = harness({ branches: ["main"] });
    const read = (branch: string) =>
      hasMergeQueue({ client, token: "t", owner: "acme", repo: "platform", branch });
    expect(await read("main")).toBe(true);
    expect(await read("release")).toBe(false);
  });

  test("queues a pull request once its own checks pass, then reports the merge", async () => {
    const { queue, pass } = harness();
    expect(await pass(false)).toEqual({ outcome: "queued", position: 2, state: "QUEUED" });
    expect(queue.enqueued).toEqual([{ pullRequestId: "PR_7", head: HEAD }]);
    queue.move(7, 1, "AWAITING_CHECKS");
    expect(await pass(true)).toEqual({ outcome: "queued", position: 1, state: "AWAITING_CHECKS" });
    queue.merge(7, "m".repeat(40));
    expect(await pass(true)).toEqual({ outcome: "merged", sha: "m".repeat(40) });
    expect(queue.enqueued).toHaveLength(1);
  });

  test("waits for the pull request's own checks before queueing", async () => {
    const { queue, pass } = harness({ pending: true });
    expect((await pass(false)).outcome).toBe("checks_pending");
    expect(queue.enqueued).toEqual([]);
  });

  test("a failing check of its own is reported before queueing", async () => {
    const { queue, pass } = harness({ failing: true });
    const result = await pass(false);
    expect(result).toMatchObject({
      outcome: "ci_failed",
      failedChecks: [{ name: "test", url: "https://ci.example/1" }],
    });
    expect(queue.enqueued).toEqual([]);
  });

  test("a removal is reported once Paws saw the pull request queued", async () => {
    const { queue, pass } = harness();
    await pass(false);
    queue.remove(7, "FAILED_CHECKS");
    expect(await pass(true)).toEqual({
      outcome: "removed",
      removal: { cause: "failed", reason: "FAILED_CHECKS", actor: "github-merge-queue" },
    });
    queue.remove(7, "MANUAL", "octocat");
    expect(await pass(true)).toEqual({
      outcome: "removed",
      removal: { cause: "person", reason: "MANUAL", actor: "octocat" },
    });
  });

  test("an earlier removal does not stop a later pass from queueing again", async () => {
    const { queue, pass } = harness();
    queue.remove(7, "FAILED_CHECKS");
    expect((await pass(false)).outcome).toBe("queued");
    expect(queue.enqueued).toHaveLength(1);
  });

  test("a repository without a merge queue is reported, not queued", async () => {
    const { queue, pass } = harness({ branches: [] });
    expect((await pass(false)).outcome).toBe("no_queue");
    expect(queue.enqueued).toEqual([]);
  });

  test("classifies removal reasons", () => {
    expect(classifyRemoval("Merge conflict with main", null).cause).toBe("conflict");
    expect(classifyRemoval("MERGE_CONFLICT", null).cause).toBe("conflict");
    expect(classifyRemoval("Required status check failed", null).cause).toBe("failed");
    expect(classifyRemoval("CI_TIMEOUT", null).cause).toBe("failed");
    expect(classifyRemoval("MANUAL", { login: "octocat" }).cause).toBe("person");
    expect(classifyRemoval("", { login: "octocat" })).toEqual({
      cause: "person",
      reason: "",
      actor: "octocat",
    });
  });

  test("describes the queue position and state", () => {
    expect(githubQueueLine("acme/platform", 2, "AWAITING_CHECKS")).toBe(
      "Second in the acme/platform GitHub merge queue, waiting for checks.",
    );
    expect(githubQueueLine("acme/platform", null, "QUEUED")).toBe(
      "In the acme/platform GitHub merge queue, queued.",
    );
  });
});
