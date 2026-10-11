import { describe, expect, test } from "bun:test";
import {
  createFakeTracker,
  createLinearTracker,
  type LinearClient,
  type ProgressUpdate,
  type SessionUpdate,
} from "../src/linear";

const ACTIVITY_ID = "c782d852-b988-4a04-9db6-cf4c61e65101";

function recordingClient() {
  const calls: { query: string; variables: Record<string, unknown> | undefined }[] = [];
  const client: LinearClient = {
    async query(query, variables) {
      calls.push({ query, variables });
      const operation = query.includes("agentActivityCreate")
        ? "agentActivityCreate"
        : query.includes("agentSessionCreateOnIssue")
          ? "agentSessionCreateOnIssue"
          : query.includes("agentSessionCreateOnComment")
            ? "agentSessionCreateOnComment"
            : "agentSessionUpdate";
      const entity = operation === "agentActivityCreate" ? "agentActivity" : "agentSession";
      return {
        [operation]: {
          success: true,
          [entity]: { id: entity === "agentActivity" ? ACTIVITY_ID : "session" },
        },
      };
    },
  };
  return { tracker: createLinearTracker(client), calls };
}

describe("Linear rich activities", () => {
  test("sends structured action start and result with caller ID and ephemeral flag", async () => {
    const { tracker, calls } = recordingClient();
    const update: ProgressUpdate = {
      sessionId: "session",
      kind: "action",
      body: "compatibility text",
      id: ACTIVITY_ID,
      action: { action: "Run tests", parameter: "bun test", result: "12 tests passed" },
      ephemeral: true,
    };
    expect(await tracker.createActivity(update)).toEqual({ id: ACTIVITY_ID });
    expect(calls[0]?.variables).toEqual({
      input: {
        agentSessionId: "session",
        id: ACTIVITY_ID,
        ephemeral: true,
        content: {
          type: "action",
          action: "Run tests",
          parameter: "bun test",
          result: "12 tests passed",
        },
      },
    });
    expect(calls[0]?.query).toContain("agentActivity { id }");
    await tracker.createActivity({
      sessionId: "session",
      kind: "action",
      body: "ignored",
      action: { action: "Run tests", parameter: "bun test" },
    });
    expect(calls[1]?.variables?.["input"]).toEqual({
      agentSessionId: "session",
      content: { type: "action", action: "Run tests", parameter: "bun test" },
    });
  });

  test("preserves legacy action and text payloads", async () => {
    const { tracker, calls } = recordingClient();
    await tracker.postProgress({ sessionId: "session", kind: "action", body: "git status" });
    await tracker.postProgress({ sessionId: "session", kind: "thought", body: "Working" });
    expect(calls.map((call) => call.variables?.["input"])).toEqual([
      {
        agentSessionId: "session",
        content: { type: "action", action: "update", parameter: "git status" },
      },
      { agentSessionId: "session", content: { type: "thought", body: "Working" } },
    ]);
  });

  test("supports select values distinct from labels and unlabeled URL options", async () => {
    const { tracker, calls } = recordingClient();
    await tracker.createElicitation({
      sessionId: "session",
      body: "Which repository?",
      id: ACTIVITY_ID,
      options: [
        { label: "Paws", value: "pmdroid/paws-app" },
        { value: "https://github.com/pmdroid/barkvisor" },
        "Other",
      ],
    });
    expect(calls[0]?.variables?.["input"]).toEqual({
      agentSessionId: "session",
      id: ACTIVITY_ID,
      content: { type: "elicitation", body: "Which repository?" },
      signal: "select",
      signalMetadata: {
        options: [
          { label: "Paws", value: "pmdroid/paws-app" },
          { value: "https://github.com/pmdroid/barkvisor" },
          { label: "Other", value: "Other" },
        ],
      },
    });
  });

  test("supports targeted authentication metadata", async () => {
    const { tracker, calls } = recordingClient();
    await tracker.createElicitation({
      sessionId: "session",
      body: "Link your account",
      auth: { url: "https://auth.example.com/link", userId: "human", providerName: "GitHub" },
    });
    expect(calls[0]?.variables?.["input"]).toEqual({
      agentSessionId: "session",
      content: { type: "elicitation", body: "Link your account" },
      signal: "auth",
      signalMetadata: {
        url: "https://auth.example.com/link",
        userId: "human",
        providerName: "GitHub",
      },
    });
  });

  test("rejects invalid activity and signal combinations before calling Linear", async () => {
    const { tracker, calls } = recordingClient();
    for (const kind of ["elicitation", "response", "error"] as const) {
      await expect(
        tracker.createActivity({ sessionId: "session", kind, body: "text", ephemeral: true }),
      ).rejects.toThrow("Only Linear thought and action");
    }
    await expect(
      tracker.createActivity({
        sessionId: "session",
        kind: "thought",
        body: "text",
        action: { action: "run", parameter: "tests" },
      }),
    ).rejects.toThrow("require an action");
    await expect(
      tracker.createActivity({
        sessionId: "session",
        kind: "thought",
        body: "text",
        id: "local-outbox-1",
      }),
    ).rejects.toThrow("UUID v4");
    await expect(
      tracker.createElicitation({
        sessionId: "session",
        body: "Link",
        options: ["yes"],
        auth: { url: "https://auth.example.com" },
      }),
    ).rejects.toThrow("cannot be combined");
    await expect(
      tracker.createElicitation({
        sessionId: "session",
        body: "Link",
        auth: { url: "javascript:alert(1)" },
      }),
    ).rejects.toThrow("HTTP or HTTPS");
    expect(calls).toEqual([]);
  });

  test("rejects unsuccessful and incomplete receipts without treating IDs as deduplication", async () => {
    for (const payload of [
      undefined,
      { success: false },
      { success: true },
      { success: true, agentActivity: {} },
    ]) {
      const tracker = createLinearTracker({
        async query() {
          return { agentActivityCreate: payload };
        },
      });
      await expect(
        tracker.postProgress({ sessionId: "session", kind: "thought", body: "text" }),
      ).rejects.toThrow("Linear agentActivityCreate");
    }
    const tracker = createLinearTracker({
      async query() {
        return { agentActivityCreate: { success: true, agentActivity: { id: "different" } } };
      },
    });
    await expect(
      tracker.createActivity({
        sessionId: "session",
        kind: "thought",
        body: "text",
        id: ACTIVITY_ID,
      }),
    ).rejects.toThrow("different activity ID");
  });
});

describe("Linear session mutations", () => {
  test("updates a full plan, summary and incremental links", async () => {
    const { tracker, calls } = recordingClient();
    const input: SessionUpdate = {
      sessionId: "session",
      plan: [
        { content: "Read context", status: "completed" },
        { content: "Run tests", status: "inProgress" },
        { content: "Open PR", status: "pending" },
        { content: "Old approach", status: "canceled" },
      ],
      summary: "Implement export",
      addedExternalUrls: [
        { label: "Pull request", url: "https://github.com/pmdroid/paws-app/pull/1" },
      ],
      removedExternalUrls: ["https://example.com/old"],
    };
    expect(await tracker.updateSession(input)).toEqual({ id: "session" });
    const { sessionId: _sessionId, ...expected } = input;
    expect(calls[0]?.variables).toEqual({ id: "session", input: expected });
    expect(calls[0]?.query).toContain("$input: AgentSessionUpdateInput!");
    await tracker.updateSession({
      sessionId: "session",
      plan: [],
      externalUrls: [],
      summary: null,
    });
    expect(calls[1]?.variables).toEqual({
      id: "session",
      input: { plan: [], externalUrls: [], summary: null },
    });
  });

  test("creates issue and comment sessions with public mutations", async () => {
    const { tracker, calls } = recordingClient();
    expect(
      await tracker.createSessionOnIssue({
        issueId: "ENG-1",
        externalUrls: [{ label: "Paws", url: "http://localhost:8787/status" }],
      }),
    ).toEqual({ id: "session" });
    expect(await tracker.createSessionOnComment({ commentId: "comment" })).toEqual({
      id: "session",
    });
    expect(calls[0]?.query).toContain("$input: AgentSessionCreateOnIssue!");
    expect(calls[0]?.variables).toEqual({
      input: {
        issueId: "ENG-1",
        externalUrls: [{ label: "Paws", url: "http://localhost:8787/status" }],
      },
    });
    expect(calls[1]?.query).toContain("$input: AgentSessionCreateOnComment!");
    expect(calls[1]?.variables).toEqual({ input: { commentId: "comment" } });
  });

  test("validates summaries and links before network calls", async () => {
    const { tracker, calls } = recordingClient();
    for (const summary of ["", "  ", "a\nb", "a\rb", "a\0b", "x".repeat(256)]) {
      await expect(tracker.updateSession({ sessionId: "session", summary })).rejects.toThrow(
        "summary requires",
      );
    }
    await expect(
      tracker.updateSession({ sessionId: "session", externalUrls: [], addedExternalUrls: [] }),
    ).rejects.toThrow("cannot be combined");
    await expect(
      tracker.updateSession({
        sessionId: "session",
        addedExternalUrls: [
          { label: "A", url: "https://example.com" },
          { label: "B", url: "https://example.com" },
        ],
      }),
    ).rejects.toThrow("unique");
    await expect(
      tracker.createSessionOnComment({
        commentId: "comment",
        externalUrls: [{ label: "Bad", url: "file:///tmp/private" }],
      }),
    ).rejects.toThrow("HTTP or HTTPS");
    expect(calls).toEqual([]);
  });

  test("checks each session mutation result", async () => {
    const tracker = createLinearTracker({
      async query() {
        return {};
      },
    });
    await expect(tracker.updateSession({ sessionId: "session", summary: "Title" })).rejects.toThrow(
      "agentSessionUpdate was unsuccessful",
    );
    await expect(tracker.createSessionOnIssue({ issueId: "ENG-1" })).rejects.toThrow(
      "agentSessionCreateOnIssue was unsuccessful",
    );
    await expect(tracker.createSessionOnComment({ commentId: "comment" })).rejects.toThrow(
      "agentSessionCreateOnComment was unsuccessful",
    );
    const wrong = createLinearTracker({
      async query() {
        return { agentSessionUpdate: { success: true, agentSession: { id: "other" } } };
      },
    });
    await expect(wrong.updateSession({ sessionId: "session", summary: "Title" })).rejects.toThrow(
      "different session ID",
    );
  });

  test("the fake records rich operations and applies the same validation", async () => {
    const tracker = createFakeTracker();
    const activity = {
      sessionId: "session",
      kind: "thought" as const,
      body: "Working",
      ephemeral: true,
      id: ACTIVITY_ID,
    };
    expect(await tracker.createActivity(activity)).toEqual({ id: ACTIVITY_ID });
    const question = {
      sessionId: "session",
      body: "Choose",
      options: [{ label: "First", value: "one" }],
    };
    await tracker.createElicitation(question);
    await tracker.updateSession({ sessionId: "session", summary: "Task" });
    await tracker.createSessionOnIssue({ issueId: "ENG-1" });
    await tracker.createSessionOnComment({ commentId: "comment" });
    expect(tracker.progress).toEqual([activity]);
    expect(tracker.questions).toEqual([question]);
    expect(tracker.sessionUpdates).toEqual([{ sessionId: "session", summary: "Task" }]);
    expect(tracker.issueSessions).toEqual([{ issueId: "ENG-1" }]);
    expect(tracker.commentSessions).toEqual([{ commentId: "comment" }]);
    await expect(
      tracker.createActivity({
        sessionId: "session",
        kind: "response",
        body: "Done",
        ephemeral: true,
      }),
    ).rejects.toThrow("Only Linear thought");
    expect(tracker.progress).toHaveLength(1);
  });
});
