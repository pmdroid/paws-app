import { expect, test } from "bun:test";
import type { RunAgentOptions, RunAgentResult } from "../src/acp";
import { createAcpCodexReviewer } from "../src/loop";

const finished: RunAgentResult = {
  role: "reviewer",
  stopReason: "end_turn",
  timedOut: false,
  cancelled: false,
  authRequired: false,
  agentExited: true,
  identity: { session: "review-session", model: "reviewer-model", provider: "fixture" },
};
const cancelled: RunAgentResult = {
  role: "reviewer",
  stopReason: "cancelled",
  timedOut: false,
  cancelled: true,
  authRequired: false,
  agentExited: true,
};
const request = {
  worktree: "/tmp/unused",
  taskId: "PAS-383-task",
  itemId: "independent-review",
  base: "a".repeat(40),
  head: "b".repeat(40),
  candidate: { session: "implementer", model: "implementer-model", provider: "fixture" },
};

function reviewer(outcomes: RunAgentResult[], signal?: AbortSignal) {
  const runs: string[] = [];
  const review = createAcpCodexReviewer({
    pawsRoot: "/tmp/unused",
    launch: () => ({}),
    ...(signal ? { signal } : {}),
    async agentRunner(options: RunAgentOptions) {
      runs.push(options.runId);
      const outcome = outcomes[runs.length - 1]!;
      if (!outcome.cancelled)
        await options.onEvent?.({
          type: "session_update",
          sessionId: "review-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[]" } },
        });
      return outcome;
    },
  });
  return { review, runs };
}

test("a review cut short without a Paws cancellation runs once more", async () => {
  const { review, runs } = reviewer([cancelled, finished]);
  const result = await review.review(request);
  expect(result.findings).toEqual([]);
  expect(runs).toHaveLength(2);
  expect(new Set(runs).size).toBe(2);
});

test("a review Paws cancelled is not retried", async () => {
  const controller = new AbortController();
  controller.abort();
  const { review, runs } = reviewer([cancelled, finished], controller.signal);
  await expect(review.review(request)).rejects.toThrow("Review did not complete: cancelled");
  expect(runs).toHaveLength(1);
});

test("a review cancelled twice still fails", async () => {
  const { review, runs } = reviewer([cancelled, cancelled]);
  await expect(review.review(request)).rejects.toThrow("Review did not complete: cancelled");
  expect(runs).toHaveLength(2);
});
