import { describe, expect, test } from "bun:test";
import { GROK_LOGIN_MESSAGE, type AcpEvent } from "../src/acp";
import { createLinearTracker, type LinearClient } from "../src/linear";
import {
  FIRST_ACTIVITY_MS,
  KEEPALIVE_MS,
  LINEAR_STALE_MS,
  activityFromAcpEvent,
  createAcpActivityReporter,
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

  test("keeps reasoning private and maps public messages to progress", () => {
    expect(
      activityFromAcpEvent({
        type: "session_update",
        sessionId: "s",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      }),
    ).toBeNull();
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
    ).toBe("thought");
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
      }),
    ).toBeNull();
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

describe("streamed activity", () => {
  function chunk(text: string, thought = false): AcpEvent {
    return {
      type: "session_update",
      sessionId: "s",
      update: {
        sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
        content: { type: "text", text },
      },
    };
  }

  test("joins public fragments and preserves final content without completing the session", () => {
    const posted: { kind: string; body: string }[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    reporter.onEvent(chunk("I"));
    reporter.onEvent(chunk(" will"));
    reporter.onEvent(chunk(" "));
    reporter.onEvent(chunk("check."));
    expect(posted).toEqual([]);
    reporter.onEvent({
      type: "session_update",
      sessionId: "s",
      update: { sessionUpdate: "tool_call", toolCallId: "check", title: "Run checks" },
    });
    expect(posted).toEqual([
      { kind: "thought", body: "I will check." },
      { kind: "action", body: "Run checks" },
    ]);
    reporter.onEvent(chunk("Verified"));
    reporter.onEvent(chunk(" locally."));
    reporter.onEvent({ type: "prompt_complete", stopReason: "end_turn" });
    reporter.flush();
    expect(posted.slice(2)).toEqual([{ kind: "thought", body: "Verified locally." }]);
    expect(reporter.resultBody()).toBe("Verified locally.");
  });

  test("retains the entire final message while clipping public progress", () => {
    const posted: { kind: string; body: string }[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    const body = "a".repeat(4000) + " Required final detail.";
    reporter.onEvent(chunk(body));
    reporter.onEvent({ type: "prompt_complete", stopReason: "end_turn" });
    expect(posted[0]?.body.length).toBe(3500);
    expect(reporter.resultBody()).toBe(body);
  });

  test("private reasoning is discarded and interruption emits an error", () => {
    const posted: { kind: string; body: string }[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    reporter.onEvent(chunk("Thinking", true));
    reporter.onEvent(chunk(" through it.", true));
    reporter.onEvent(chunk("Partially "));
    reporter.onEvent(chunk("done."));
    reporter.onEvent({ type: "cancelled", reason: "timeout" });
    reporter.flush();
    expect(posted).toEqual([
      { kind: "thought", body: "Partially done." },
      { kind: "error", body: "Run timed out." },
    ]);
  });

  test("a title-free tool update does not publish its opaque identifier", () => {
    expect(
      activityFromAcpEvent({
        type: "session_update",
        sessionId: "s",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "exec-123",
          status: "in_progress",
        },
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
        return { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } };
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
  test.each([undefined, "unknown", "prompt"])("rejects invalid activity kind %s", async (kind) => {
    const tracker = createLinearTracker({
      async query() {
        return { agentActivityCreate: { success: true, agentActivity: { id: "activity" } } };
      },
    });
    await expect(
      deliverLinearOutbox(row("activity", { body: "Legacy text", kind }), tracker, async () => {}),
    ).rejects.toThrow("valid kind");
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
