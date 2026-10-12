import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ProgressUpdate } from "../src/linear";
import { createAcpActivityReporter } from "../src/loop";

function emit(reporter: ReturnType<typeof createAcpActivityReporter>, update: SessionUpdate) {
  reporter.onEvent({ type: "session_update", sessionId: "s", update });
}

test.each(["completed", "failed"] as const)(
  "terminal output deltas become the %s action result",
  (status) => {
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    emit(reporter, {
      sessionUpdate: "tool_call",
      toolCallId: "command",
      title: "Run checks",
      status: "in_progress",
      rawInput: { command: "bun test" },
      content: [{ type: "terminal", terminalId: "terminal" }],
    });
    for (const data of ["First check passed.\n", "Second check failed."])
      emit(reporter, {
        sessionUpdate: "tool_call_update",
        toolCallId: "command",
        _meta: { terminal_output_delta: { terminal_id: "terminal", data } },
      });
    emit(reporter, {
      sessionUpdate: "tool_call_update",
      toolCallId: "command",
      status,
      _meta: { terminal_exit: { terminal_id: "terminal", exit_code: status === "failed" ? 1 : 0 } },
    });
    expect(posted.at(-1)?.action?.result).toBe("First check passed.\nSecond check failed.");
    expect(posted.at(-1)?.action?.parameter).toContain("bun test");
    expect(posted.at(-1)?.ephemeral).not.toBe(true);
    expect(posted.slice(0, -1).every((update) => update.action?.result === undefined)).toBe(true);
  },
);

test("legacy terminal output chunks append once", () => {
  const posted: Omit<ProgressUpdate, "sessionId">[] = [];
  const reporter = createAcpActivityReporter((activity) => posted.push(activity));
  emit(reporter, { sessionUpdate: "tool_call", toolCallId: "command", title: "Read file" });
  for (const data of ["First line\n", "Second line"])
    emit(reporter, {
      sessionUpdate: "tool_call_update",
      toolCallId: "command",
      _meta: { terminal_output: { terminal_id: "terminal", data } },
    });
  emit(reporter, {
    sessionUpdate: "tool_call_update",
    toolCallId: "command",
    status: "completed",
    _meta: { terminal_output_delta: { terminal_id: "terminal", data: "\nLast line" } },
  });
  expect(posted.at(-1)?.action?.result).toBe("First line\nSecond line\nLast line");
});

test("bounded terminal output redacts an incomplete private key block", () => {
  const posted: Omit<ProgressUpdate, "sessionId">[] = [];
  const reporter = createAcpActivityReporter((activity) => posted.push(activity));
  emit(reporter, { sessionUpdate: "tool_call", toolCallId: "command", title: "Read output" });
  emit(reporter, {
    sessionUpdate: "tool_call_update",
    toolCallId: "command",
    status: "completed",
    _meta: {
      terminal_output_delta: {
        data:
          "-----BEGIN PRIVATE KEY-----\n" +
          "private-material".repeat(10_000) +
          "\n-----END PRIVATE KEY-----",
      },
    },
  });
  expect(posted.at(-1)?.action?.result).toBe("[redacted]");
});

test("terminal results redact credentials split across chunks and bound oversized output", () => {
  const previous = process.env.PAWS_ACTIVITY_TEST_TOKEN;
  process.env.PAWS_ACTIVITY_TEST_TOKEN = "synthetic-host-credential";
  try {
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    emit(reporter, { sessionUpdate: "tool_call", toolCallId: "command", title: "Read output" });
    for (const data of ["synthetic-host-", "credential\n", "x".repeat(20_000)])
      emit(reporter, {
        sessionUpdate: "tool_call_update",
        toolCallId: "command",
        _meta: { terminal_output_delta: { terminal_id: "terminal", data } },
      });
    emit(reporter, {
      sessionUpdate: "tool_call_update",
      toolCallId: "command",
      status: "completed",
    });
    expect(posted.at(-1)?.action?.result).toContain("[redacted]");
    expect(posted.at(-1)?.action?.result?.length).toBeLessThanOrEqual(3500);
    expect(JSON.stringify(posted)).not.toContain("synthetic-host-");
  } finally {
    if (previous === undefined) delete process.env.PAWS_ACTIVITY_TEST_TOKEN;
    else process.env.PAWS_ACTIVITY_TEST_TOKEN = previous;
  }
});

test("tool results retain the input from their start and terminal details are durable", () => {
  const posted: Omit<ProgressUpdate, "sessionId">[] = [];
  const reporter = createAcpActivityReporter((activity) => posted.push(activity));
  emit(reporter, {
    sessionUpdate: "tool_call",
    toolCallId: "opaque-123",
    title: "Run checks",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "bun test", cwd: "packages/app" },
  });
  emit(reporter, {
    sessionUpdate: "tool_call_update",
    toolCallId: "opaque-123",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "14 tests passed" } }],
  });
  expect(posted[0]?.action?.parameter).toContain("bun test");
  expect(posted[0]?.ephemeral).toBe(true);
  expect(posted[1]?.action?.parameter).toBe(posted[0]?.action?.parameter);
  expect(posted[1]?.action?.result).toContain("14 tests passed");
  expect(posted[1]?.ephemeral).not.toBe(true);
  expect(JSON.stringify(posted)).not.toContain("opaque-123");
});

test("structured tool details redact credentials and omit reasoning before clipping", () => {
  const posted: Omit<ProgressUpdate, "sessionId">[] = [];
  const reporter = createAcpActivityReporter((activity) => posted.push(activity));
  emit(reporter, {
    sessionUpdate: "tool_call",
    toolCallId: "search",
    title: "Search files",
    kind: "search",
    rawInput: {
      query: "matching component",
      authorization: "sensitive-header",
      nested: { apiKey: "sensitive-key", password: "sensitive-password" },
      reasoning: "private reasoning must not be public",
      url: "https://example.com/path?token=sensitive-query#sensitive-fragment",
    },
  });
  emit(reporter, {
    sessionUpdate: "tool_call_update",
    toolCallId: "search",
    status: "failed",
    rawOutput: { message: "Authorization: Bearer sensitive-bearer", detail: "x".repeat(5000) },
  });
  const serialized = JSON.stringify(posted);
  expect(serialized).toContain("matching component");
  expect(serialized).toContain("[redacted]");
  expect(serialized).not.toContain("sensitive-");
  expect(serialized).not.toContain("private reasoning");
  expect(posted[1]?.action?.result?.length).toBeLessThanOrEqual(3500);
  expect(posted[1]?.ephemeral).not.toBe(true);
});

test("reasoning tools and reasoning chunks never become public actions", () => {
  const posted: Omit<ProgressUpdate, "sessionId">[] = [];
  const reporter = createAcpActivityReporter((activity) => posted.push(activity));
  emit(reporter, {
    sessionUpdate: "tool_call",
    toolCallId: "thinking",
    title: "Private chain of thought",
    kind: "think",
    rawInput: { thought: "private input" },
  });
  emit(reporter, {
    sessionUpdate: "tool_call_update",
    toolCallId: "thinking",
    status: "completed",
    rawOutput: "private output",
  });
  emit(reporter, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "private reasoning" },
  });
  expect(posted).toEqual([]);
});

test("stringified arguments and quoted environment assignments cannot publish credentials", () => {
  const posted: Omit<ProgressUpdate, "sessionId">[] = [];
  const reporter = createAcpActivityReporter((activity) => posted.push(activity));
  emit(reporter, {
    sessionUpdate: "tool_call",
    toolCallId: "read",
    title: "Read the requested result",
    rawInput: JSON.stringify({ path: "output.json", token: "private-json-token" }),
  });
  emit(reporter, {
    sessionUpdate: "tool_call_update",
    toolCallId: "read",
    status: "completed",
    rawOutput: "GITHUB_TOKEN='private quoted token' bun test. API_KEY=private-key",
  });
  expect(posted[0]?.action?.parameter).toContain("output.json");
  expect(posted[1]?.action?.result).toContain("bun test");
  expect(JSON.stringify(posted)).not.toContain("private");
});

test("host credential values are removed from otherwise unlabelled tool output", () => {
  const previous = process.env.PAWS_ACTIVITY_TEST_TOKEN;
  process.env.PAWS_ACTIVITY_TEST_TOKEN = "synthetic-host-credential";
  try {
    const posted: Omit<ProgressUpdate, "sessionId">[] = [];
    const reporter = createAcpActivityReporter((activity) => posted.push(activity));
    emit(reporter, {
      sessionUpdate: "tool_call",
      toolCallId: "run",
      title: "Run the check",
      status: "completed",
      rawOutput: "Check succeeded with synthetic-host-credential",
    });
    expect(posted[0]?.action?.result).toBe("Check succeeded with [redacted]");
  } finally {
    if (previous === undefined) delete process.env.PAWS_ACTIVITY_TEST_TOKEN;
    else process.env.PAWS_ACTIVITY_TEST_TOKEN = previous;
  }
});
