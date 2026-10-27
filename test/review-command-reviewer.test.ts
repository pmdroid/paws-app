import { expect, test } from "bun:test";
import type { RunAgentOptions, RunAgentResult } from "../src/acp";
import { createReviewCommandReviewer } from "../src/loop";

const base = "a".repeat(40);
const head = "b".repeat(40);
const request = {
  worktree: "/tmp/unused",
  taskId: "PAS-777-task",
  itemId: "independent-review",
  base,
  head,
  candidate: { session: "implementer", model: "implementer-model", provider: "anthropic" },
};
const finding = {
  severity: "P2" as const,
  location: "src/app.ts:4",
  explanation: "dropped caller: the rename left one call site.",
  evidence: "src/app.ts still calls the old name.",
};
const finished: RunAgentResult = {
  role: "reviewer",
  stopReason: "end_turn",
  timedOut: false,
  cancelled: false,
  authRequired: false,
  agentExited: true,
  identity: { session: "thread-1", model: "gpt-review", provider: "openai" },
};

function reviewer(outcome: RunAgentResult, text: string) {
  const calls: RunAgentOptions[] = [];
  const review = createReviewCommandReviewer({
    pawsRoot: "/tmp/unused",
    launch: () => ({}),
    brief: "Required output: `secret-brief`",
    profiles: {
      implementer: { agent: "claude", model: "opus" },
      reviewer: { agent: "codex", model: "gpt-review" },
    },
    async agentRunner(options) {
      calls.push(options);
      await options.onEvent?.({
        type: "session_update",
        sessionId: "thread-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
      return outcome;
    },
  });
  return { review, calls };
}

test("the live gate's reviewer asks the item's runner for the review command of base..head", async () => {
  const { review, calls } = reviewer(finished, JSON.stringify([finding]));
  const result = await review.review(request);
  expect(result).toEqual({
    session: "thread-1",
    model: "gpt-review",
    provider: "openai",
    findings: [finding],
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    role: "reviewer",
    profile: { agent: "codex", model: "gpt-review" },
    readOnly: true,
    checkpoint: false,
    mainSha: base,
    reviewCommand: { base },
  });
  // No brief, task line or finding format goes around the command.
  expect(calls[0]!.prompt).toBe(`Review ${base}..${head} with the agent's review command.`);
});

test("a review command that fails or returns no findings array blocks the review", async () => {
  await expect(
    reviewer(
      { ...finished, stopReason: "error", errorMessage: "codex exec review exited 1" },
      "",
    ).review.review(request),
  ).rejects.toThrow("codex exec review exited 1");
  await expect(reviewer(finished, "Looks good.").review.review(request)).rejects.toThrow(
    "Invalid review findings",
  );
  const { identity: _identity, ...anonymous } = finished;
  await expect(reviewer(anonymous, "[]").review.review(request)).rejects.toThrow(
    "concrete session model",
  );
});
