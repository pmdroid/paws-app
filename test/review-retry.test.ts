import { expect, test } from "bun:test";
import type { AcpEvent, RunAgentOptions, RunAgentResult } from "../src/acp";
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

const refusal: AcpEvent = {
  type: "permission",
  toolCallId: "find",
  decision: "deny",
  reason: "path is outside the worktree",
  title: "find / -path '*react-router/package.json'",
  kind: "execute",
  name: "run_terminal_command",
};

function reviewer(outcomes: RunAgentResult[], signal?: AbortSignal, before: AcpEvent[] = []) {
  const runs: string[] = [];
  const review = createAcpCodexReviewer({
    pawsRoot: "/tmp/unused",
    launch: () => ({}),
    ...(signal ? { signal } : {}),
    async agentRunner(options: RunAgentOptions) {
      runs.push(options.runId);
      const outcome = outcomes[runs.length - 1]!;
      for (const event of before) await options.onEvent?.(event);
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

test("a review cancelled twice after a refused tool call names the tool", async () => {
  const { review, runs } = reviewer([cancelled, cancelled], undefined, [refusal]);
  await expect(review.review(request)).rejects.toThrow(
    "The reviewer stopped after Paws refused its tool call `run_terminal_command` (path is outside the worktree), so the change was not reviewed.",
  );
  expect(runs).toHaveLength(2);
});

test("a refused tool call does not fail a review that finishes", async () => {
  const { review, runs } = reviewer([finished], undefined, [refusal]);
  expect((await review.review(request)).findings).toEqual([]);
  expect(runs).toHaveLength(1);
});

function answering(replies: string[]) {
  const runs: RunAgentOptions[] = [];
  const review = createAcpCodexReviewer({
    pawsRoot: "/tmp/unused",
    launch: () => ({}),
    async agentRunner(options: RunAgentOptions) {
      runs.push(options);
      await options.onEvent?.({
        type: "session_update",
        sessionId: "review-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: replies[runs.length - 1]! },
        },
      });
      return { ...finished, sessionId: "review-session" };
    },
  });
  return { review, runs };
}

const prose = "The change looks fine to me, nothing to report.";
const finding = {
  severity: "P2" as const,
  location: "src/loop/agents.ts",
  explanation: "The follow-up is sent once.",
  evidence: "The second reply parsed.",
};

test("a reviewer that answers with prose and then with findings passes", async () => {
  const { review, runs } = answering([prose, JSON.stringify([finding])]);
  const result = await review.review(request);
  expect(result.findings).toEqual([finding]);
  expect(result.session).toBe("review-session");
  expect(runs).toHaveLength(2);
  const followUp = runs[1]!;
  expect(followUp.prompt).toBe(
    "Your findings were not valid JSON: reply did not contain a JSON array. Send only the findings array.",
  );
  expect(followUp.resume?.sessionId).toBe("review-session");
  expect(followUp.resume?.replayPrompt).toContain(runs[0]!.prompt);
  expect(followUp.resume?.replayPrompt).toContain(prose);
  expect(followUp.resume?.replayPrompt).toEndWith(followUp.prompt);
  expect(runs[0]!.resume).toBeUndefined();
});

test("a reviewer that answers with prose twice fails with the parse error", async () => {
  const { review, runs } = answering([prose, prose]);
  await expect(review.review(request)).rejects.toThrow(
    "Invalid review findings: reply did not contain a JSON array",
  );
  expect(runs).toHaveLength(2);
});

test("a reviewer whose first findings parse is not asked again", async () => {
  const { review, runs } = answering(["[]"]);
  expect((await review.review(request)).findings).toEqual([]);
  expect(runs).toHaveLength(1);
});
