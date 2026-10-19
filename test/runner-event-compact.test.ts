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
  const compacted = compactAcpEvent(imageRead());
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
