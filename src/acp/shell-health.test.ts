import { expect, test } from "bun:test";
import type { AcpEvent } from "./types";
import { classifyExecuteResult, createShellBreakDetector } from "./shell-health";

function result(toolCallId: string, rawOutput: unknown, kind = "execute"): AcpEvent[] {
  return [
    {
      type: "session_update",
      sessionId: "s",
      update: { sessionUpdate: "tool_call", toolCallId, title: "Run", kind: kind as "execute" },
    },
    {
      type: "session_update",
      sessionId: "s",
      update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput },
    },
  ];
}

const broken = { exit_code: -1, stdout: "", stderr: "" };

test("an execute result with exit -1 and no output is broken", () => {
  const update = (rawOutput: unknown, _meta?: Record<string, unknown>) =>
    classifyExecuteResult({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      rawOutput,
      ...(_meta ? { _meta } : {}),
    });
  expect(update(broken)).toBe("broken");
  expect(update({ exitCode: -1 })).toBe("broken");
  expect(update({ exitStatus: { exitCode: -1 }, output: "  \n" })).toBe("broken");
  expect(update(undefined, { terminal_exit: { exit_code: -1 } })).toBe("broken");
  expect(update({ exit_code: -1, stderr: "bash: not found" })).toBe("ran");
  expect(update({ exit_code: 1, stdout: "", stderr: "" })).toBe("ran");
  expect(update({ exit_code: 1, output: "FAIL src/a.test.ts" })).toBe("ran");
  expect(
    update(undefined, { terminal_exit: { exit_code: -1 }, terminal_output: { data: "x" } }),
  ).toBe("ran");
  expect(update(undefined)).toBeNull();
  expect(update({ changed: "a.ts" })).toBeNull();
});

test("three consecutive broken execute results trip the detector", () => {
  const detector = createShellBreakDetector();
  const seen = [
    ...result("1", broken),
    ...result("2", broken),
    ...result("read", { content: "" }, "read"),
    ...result("3", broken),
  ].map((event) => detector.observe(event));
  expect(seen.filter(Boolean)).toHaveLength(1);
  expect(seen.at(-1)).toBe(true);
});

test("a normal failing command never counts and resets the streak", () => {
  const detector = createShellBreakDetector();
  const failing = { exit_code: 1, stdout: "", stderr: "error: expected 2, got 3" };
  const events = [
    ...result("1", broken),
    ...result("2", broken),
    ...result("3", failing),
    ...result("4", broken),
    ...result("5", broken),
    ...Array.from({ length: 5 }, (_, index) => result(`f${index}`, failing)).flat(),
  ];
  expect(events.some((event) => detector.observe(event))).toBe(false);
});

test("a repeated update for one tool call counts once", () => {
  const detector = createShellBreakDetector();
  const events = [...result("1", broken), ...result("1", broken), ...result("1", broken)];
  expect(events.some((event) => detector.observe(event))).toBe(false);
});
