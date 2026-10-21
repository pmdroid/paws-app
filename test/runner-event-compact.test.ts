import { expect, test } from "bun:test";
import type { AcpEvent } from "../src/acp";
import { RunnerActivitySchema } from "../src/runner-protocol";
import { compactAcpEvent } from "../src/runner-worker";

const png = "iVBORw0KGgo".padEnd(400_000, "A");

function imageRead(): AcpEvent {
  return {
    type: "session_update",
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_screenshot",
      status: "completed",
      content: [{ type: "content", content: { type: "image", data: png, mimeType: "image/png" } }],
      rawOutput: [
        { type: "image", source: { type: "base64", data: png, media_type: "image/png" } },
      ],
    },
  } as AcpEvent;
}

test("a screenshot read becomes a small event that still describes the image", () => {
  const original = imageRead();
  const compacted = compactAcpEvent(original);
  expect(JSON.stringify(original)).toContain(png);
  const text = JSON.stringify(compacted);
  expect(Buffer.byteLength(text)).toBeLessThan(262_144);
  expect(text).not.toContain("iVBORw0KGgo");
  expect(text).toContain("image/png image omitted");
  if (compacted.type !== "session_update") throw new Error("event type changed");
  expect(RunnerActivitySchema.safeParse(compacted.update).success).toBe(true);
});

test("oversized text output is shortened to fit and small events are unchanged", () => {
  const huge = {
    type: "session_update",
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_log",
      rawOutput: "line\n".repeat(120_000),
    },
  } as AcpEvent;
  expect(Buffer.byteLength(JSON.stringify(compactAcpEvent(huge)))).toBeLessThan(262_144);
  expect(JSON.stringify(compactAcpEvent(huge))).toContain("characters omitted");
  const small = {
    type: "session_update",
    sessionId: "session",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
  } as AcpEvent;
  expect(compactAcpEvent(small)).toEqual(small);
});

test("text below the compaction budget is preserved", () => {
  const event: AcpEvent = { type: "progress", text: "x".repeat(190_000) };
  expect(compactAcpEvent(event)).toEqual(event);
});

test("UTF-8 and escaped text fit the serialized worker line limit", () => {
  for (const text of ["日本語".repeat(80_000), "\u0000".repeat(240_000)]) {
    const compacted = compactAcpEvent({ type: "progress", text });
    expect(
      Buffer.byteLength(`${JSON.stringify({ type: "acp", event: compacted })}\n`),
    ).toBeLessThan(262_144);
    expect(JSON.stringify(compacted)).toContain("characters omitted");
  }
});

test("events with too many fields fall back to a bounded progress note", () => {
  const event: AcpEvent = {
    type: "session_update",
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_log",
      rawOutput: Array.from({ length: 20_000 }, () => "x".repeat(20)),
    },
  };
  const compacted = compactAcpEvent(event);
  expect(compacted.type).toBe("progress");
  expect(Buffer.byteLength(JSON.stringify(compacted))).toBeLessThan(200_000);
});

test("tool output sent as an array of bytes becomes text", () => {
  const output = "src/db/queue-wait.ts:3:export function queueWaitSince\n".repeat(200);
  const bytes = [...Buffer.from(output)];
  const grep = {
    type: "session_update",
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-grep",
      status: "completed",
      rawOutput: { type: "GrepSearch", stdout: bytes, stderr: [] },
    },
  } as AcpEvent;
  const compacted = compactAcpEvent(grep);
  if (compacted.type !== "session_update") throw new Error("event type changed");
  expect(compacted.update).toMatchObject({ rawOutput: { stdout: output, stderr: [] } });
  expect(Buffer.byteLength(JSON.stringify(compacted))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(grep)) / 3,
  );
});
