import { randomUUID } from "node:crypto";
import {
  enqueueOutboxOnceSteps,
  getWorkItemSteps,
  pendingChangeRequestsSteps,
  pendingPullCommentsSteps,
  type Q,
  type Steps,
} from "../db";
import { who } from "./pending-feedback";

export function* feedbackSeenSteps(q: Q, itemId: string, now: number): Steps<void> {
  const item = yield* getWorkItemSteps(q, itemId);
  const sessionId = item?.sessionKey ?? null;
  if (item === null || sessionId === null || sessionId === "") return;
  const feedback = [
    ...(yield* pendingPullCommentsSteps(q, itemId)).map((c) => ({
      at: c.receivedAt,
      by: c.author,
    })),
    ...(yield* pendingChangeRequestsSteps(q, itemId)).map((r) => ({
      at: r.receivedAt,
      by: r.reviewer,
    })),
  ];
  if (feedback.length === 0) return;
  const start = Math.min(...feedback.map((entry) => entry.at));
  const names = [...new Set(feedback.map((entry) => who(entry.by)))];
  const from =
    names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and others`;
  const n = feedback.length;
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "activity",
    orderingKey: sessionId,
    idempotencyKey: `linear-feedback-seen:${itemId}:${start}`,
    delivery: "critical",
    payload: {
      id: randomUUID(),
      sessionId,
      itemId,
      issueId: item.linearIssueId,
      kind: "thought",
      body: `Received review feedback on the pull request (${n} comment${n === 1 ? "" : "s"} from ${from}); Paws will address it when the current step finishes.`,
    },
    now,
  });
}
