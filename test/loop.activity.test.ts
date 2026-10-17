import { describe, expect, test } from "bun:test";
import { GROK_LOGIN_MESSAGE, type AcpEvent } from "../src/acp";
import { createLinearTracker, type LinearClient, type ProgressUpdate } from "../src/linear";
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
      }),
    ).toBeNull();
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
  test("publishes remote progress immediately without mixing it into the final answer", () => {
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    reporter.onEvent({ type: "progress", text: "Reading the selected repository." });
    reporter.onEvent(chunk("Private reasoning", true));
    expect(posted).toEqual([{ kind: "thought", body: "Reading the selected repository." }]);
    expect(reporter.resultBody()).toBe("");
    reporter.onEvent(chunk("The screenshot is ready."));
    reporter.onEvent({ type: "prompt_complete", stopReason: "end_turn" });
    expect(reporter.resultBody()).toBe("The screenshot is ready.");
    expect(posted).toEqual([
      { kind: "thought", body: "Reading the selected repository." },
      { kind: "thought", body: "The screenshot is ready." },
    ]);
  });

  test("remote public fragments join at tool boundaries without entering the final answer", () => {
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    for (const text of ["Set", "ting", " ", "up."])
      reporter.onEvent({ type: "progress", text, messageChunk: true });
    expect(posted).toEqual([]);
    reporter.onEvent({
      type: "session_update",
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Run browser",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "chromium" },
      },
    });
    expect(posted).toEqual([{ kind: "thought", body: "Setting up." }]);
    expect(reporter.resultBody()).toBe("");
    reporter.onEvent(chunk("The screenshot is ready."));
    reporter.onEvent({ type: "prompt_complete", stopReason: "end_turn" });
    expect(reporter.resultBody()).toBe("The screenshot is ready.");
    expect(posted.filter((activity) => activity.body === "Setting up.")).toHaveLength(1);
  });

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
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
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
    expect(posted).toEqual([{ kind: "thought", body: "I will check." }]);
    reporter.onEvent(chunk("Verified"));
    reporter.onEvent(chunk(" locally."));
    reporter.onEvent({ type: "prompt_complete", stopReason: "end_turn" });
    reporter.flush();
    expect(posted.slice(1)).toEqual([{ kind: "thought", body: "Verified locally." }]);
    expect(reporter.resultBody()).toBe("Verified locally.");
  });

  test("retains the entire public message across ordered Linear activities", () => {
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    const body = "a".repeat(4000) + " Required final detail.";
    reporter.onEvent(chunk(body));
    reporter.onEvent({ type: "prompt_complete", stopReason: "end_turn" });
    expect(posted.map((activity) => activity.body).join("")).toBe(body);
    expect(posted.every((activity) => activity.body.length <= 3500)).toBe(true);
    expect(reporter.resultBody()).toBe(body);
  });

  test("private reasoning is discarded and interruption emits an error", () => {
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
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

  test("quoted credentials in tool output remain private", () => {
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    reporter.onEvent({
      type: "session_update",
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "secret-output",
        title: "Run browser",
        status: "completed",
        rawInput: { token: "private-input-value" },
        rawOutput: '{"access_token":"private-output-value"}',
      },
    });
    expect(JSON.stringify(posted)).not.toContain("private-input-value");
    expect(JSON.stringify(posted)).not.toContain("private-output-value");
  });

  test("tool calls and their output post nothing to Linear", () => {
    const posted: unknown[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    reporter.onEvent({
      type: "session_update",
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "check",
        title: "Run checks",
      },
    });
    reporter.onEvent({
      type: "session_update",
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "check",
        status: "completed",
        rawOutput: { secret: "private-tool-output" },
      },
    });
    expect(posted).toEqual([]);
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

  test("a follow-up interruption does not report cancellation or completion", () => {
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    reporter.onEvent({ type: "cancelled", reason: "follow_up" });
    reporter.flush();
    expect(posted).toEqual([]);
    expect(activityFromAcpEvent({ type: "cancelled", reason: "cancel" })?.kind).toBe("error");
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
  test("delivers rich progress, selection and auth through the actual GraphQL adapter", async () => {
    const inputs: unknown[] = [];
    const tracker = createLinearTracker({
      async query(_query, variables) {
        inputs.push(variables?.["input"]);
        return {
          agentActivityCreate: {
            success: true,
            agentActivity: { id: (variables?.["input"] as { id: string } | undefined)?.id },
          },
        };
      },
    });
    const id = "22222222-2222-4222-8222-222222222222";
    await deliverLinearOutbox(
      row("activity", {
        sessionId: "ses",
        kind: "action",
        body: "Run checks",
        id,
        ephemeral: true,
        action: { action: "Run checks", parameter: "bun test", result: "passed" },
      }),
      tracker,
      async () => {},
    );
    await deliverLinearOutbox(
      row("elicitation", {
        sessionId: "ses",
        body: "Which repository?",
        id,
        options: ["Other", { label: "Paws", value: "https://github.com/pmdroid/paws-app" }],
      }),
      tracker,
      async () => {},
    );
    await deliverLinearOutbox(
      row("elicitation", {
        sessionId: "ses",
        body: "Link your account",
        id,
        auth: { url: "https://example.com/link", userId: "human", providerName: "GitHub" },
      }),
      tracker,
      async () => {},
    );
    expect(inputs).toEqual([
      {
        agentSessionId: "ses",
        id,
        ephemeral: true,
        content: { type: "action", action: "Run checks", parameter: "bun test", result: "passed" },
      },
      {
        agentSessionId: "ses",
        id,
        content: { type: "elicitation", body: "Which repository?" },
        signal: "select",
        signalMetadata: {
          options: [
            { label: "Other", value: "Other" },
            { label: "Paws", value: "https://github.com/pmdroid/paws-app" },
          ],
        },
      },
      {
        agentSessionId: "ses",
        id,
        content: { type: "elicitation", body: "Link your account" },
        signal: "auth",
        signalMetadata: {
          url: "https://example.com/link",
          userId: "human",
          providerName: "GitHub",
        },
      },
    ]);
  });

  test.each([
    { op: "activity", payload: { kind: "action", body: "bad", action: "lost" } },
    { op: "activity", payload: { kind: "thought", body: "bad", ephemeral: "true" } },
    { op: "activity", payload: { kind: "error", body: "bad", ephemeral: true } },
    {
      op: "elicitation",
      payload: { sessionId: "ses", body: "bad", options: [{ label: "Missing value" }] },
    },
    { op: "elicitation", payload: { sessionId: "ses", body: "bad", auth: {} } },
  ])(
    "rejects malformed rich activity rather than silently losing fields",
    async ({ op, payload }) => {
      let calls = 0;
      const tracker = createLinearTracker({
        async query() {
          calls += 1;
          return {};
        },
      });
      await expect(
        deliverLinearOutbox(row(op, payload), tracker, async () => {}),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    },
  );

  test("a superseded claimed row cannot call the tracker", async () => {
    let calls = 0;
    const tracker = createLinearTracker({
      async query() {
        calls += 1;
        return {};
      },
    });
    await expect(
      deliverLinearOutbox(
        row("activity", { kind: "thought", body: "stale" }),
        tracker,
        async () => {},
        {
          signal: new AbortController().signal,
          isCurrent: () => false,
        },
      ),
    ).rejects.toThrow("superseded");
    expect(calls).toBe(0);
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
