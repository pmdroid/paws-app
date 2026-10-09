import { describe, expect, test } from "bun:test";
import { GROK_LOGIN_MESSAGE } from "../src/acp";
import { createLinearTracker, type LinearClient } from "../src/linear";
import {
  FIRST_ACTIVITY_MS,
  KEEPALIVE_MS,
  LINEAR_STALE_MS,
  activityFromAcpEvent,
  deliverLinearOutbox,
  shouldKeepAlive,
  shouldPostFirstActivity,
} from "../src/loop";
import type { OutboxRow } from "../src/db";

describe("activity mapping", () => {
  test("posts a first activity within 10s and a keepalive inside Linear's stale window", () => {
    expect(FIRST_ACTIVITY_MS).toBeLessThanOrEqual(10_000);
    expect(KEEPALIVE_MS).toBeGreaterThan(0);
    expect(KEEPALIVE_MS).toBeLessThan(LINEAR_STALE_MS);
    expect(shouldPostFirstActivity(false, FIRST_ACTIVITY_MS)).toBe(true);
    expect(shouldPostFirstActivity(true, FIRST_ACTIVITY_MS)).toBe(false);
    expect(shouldKeepAlive(KEEPALIVE_MS - 1)).toBe(false);
    expect(shouldKeepAlive(KEEPALIVE_MS)).toBe(true);
  });

  test("maps ACP thoughts, tool calls, and messages onto Linear activity kinds", () => {
    expect(
      activityFromAcpEvent({
        type: "session_update",
        sessionId: "s",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      })?.kind,
    ).toBe("thought");
    expect(
      activityFromAcpEvent({
        type: "session_update",
        sessionId: "s",
        update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit export" },
      })?.kind,
    ).toBe("action");
    expect(
      activityFromAcpEvent({
        type: "session_update",
        sessionId: "s",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      })?.kind,
    ).toBe("response");
    expect(activityFromAcpEvent({ type: "error", message: "boom" })?.kind).toBe("error");
    expect(activityFromAcpEvent({ type: "error", message: GROK_LOGIN_MESSAGE })).toEqual({
      kind: "error",
      body: GROK_LOGIN_MESSAGE,
    });
    expect(
      activityFromAcpEvent({
        type: "ask_team",
        phase: "asked",
        question: "Include archived rows?",
      })?.kind,
    ).toBe("thought");
    expect(
      activityFromAcpEvent({
        type: "ask_team",
        phase: "answered",
        question: "Include archived rows?",
        answer: "yes",
      }),
    ).toBeNull();
  });
});

describe("linear outbox dispatch", () => {
  test("posts linear.activity through the Linear client and runs catch-up", async () => {
    const inputs: unknown[] = [];
    const client: LinearClient = {
      async query(_query, variables) {
        inputs.push(variables?.["input"]);
        return {};
      },
    };
    const tracker = createLinearTracker(client);
    let caughtUp = 0;
    await deliverLinearOutbox(
      row("linear.activity", { sessionId: "ses", kind: "thought", body: "hello" }),
      tracker,
      async () => {
        caughtUp += 1;
      },
    );
    await deliverLinearOutbox(row("linear.catchup", {}), tracker, async () => {
      caughtUp += 1;
    });
    expect(inputs[0]).toEqual({
      agentSessionId: "ses",
      content: { type: "thought", body: "hello" },
    });
    expect(caughtUp).toBe(1);
  });
});

function row(op: string, payload: unknown): OutboxRow {
  return {
    id: 1,
    target: "linear",
    op,
    orderingKey: "ses",
    idempotencyKey: op,
    payload,
    priority: 5,
    notBefore: 0,
    attempts: 0,
    maxAttempts: 5,
    status: "pending",
    createdAt: 0,
    sentAt: null,
    lockedBy: "test",
    lockedUntil: 1,
    error: null,
  };
}
