import { expect, test } from "bun:test";
import type { AcpEvent } from "../acp";
import { agentWaitTracker, type AgentWaitEvent, type AgentWaitTimers } from "./agent-wait";

const MINUTE = 60_000;

function harness() {
  let at = 0;
  const clock = { now: () => at, advance: (ms: number) => void (at += ms) };
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 0;
  const timers: AgentWaitTimers = {
    set(callback, ms) {
      pending.set(++next, { at: clock.now() + ms, callback });
      return next;
    },
    clear: (handle) => pending.delete(handle as number),
  };
  const events: (AgentWaitEvent & { at: number })[] = [];
  const tracker = agentWaitTracker((event) => events.push({ ...event, at: clock.now() }), timers);
  const advance = (ms: number) => {
    const until = clock.now() + ms;
    for (;;) {
      const due = [...pending]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      clock.advance(due[1].at - clock.now());
      due[1].callback();
    }
    clock.advance(until - clock.now());
  };
  const update = (fields: Record<string, unknown>) =>
    tracker.observe({ type: "session_update", sessionId: "s", update: fields } as AcpEvent);
  return { clock, events, advance, update, tracker };
}

const start = {
  sessionUpdate: "tool_call",
  toolCallId: "t1",
  kind: "execute",
  title: "run.sh --build --mcp",
  status: "in_progress",
};

test("a 30-minute tool call with no other output waits 28 minutes after 2 minutes of agent time", () => {
  const { events, advance, update } = harness();
  update(start);
  advance(10 * MINUTE);
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    content: [{ type: "content", content: { type: "text", text: "secret output" } }],
  });
  advance(20 * MINUTE);
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "t1",
    status: "completed",
    rawOutput: "secret output",
  });
  expect(events).toEqual([
    { type: "agent_wait_started", kind: "execute", title: "run.sh --build --mcp", at: 2 * MINUTE },
    { type: "agent_wait_ended", kind: "execute", title: "run.sh --build --mcp", at: 30 * MINUTE },
  ]);
  const waited = events[1]!.at - events[0]!.at;
  expect(waited).toBe(28 * MINUTE);
  expect(30 * MINUTE - waited).toBe(2 * MINUTE);
});

test("agent output ends the wait at that output", () => {
  const { events, advance, update } = harness();
  update(start);
  advance(5 * MINUTE);
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "still building" },
  });
  advance(MINUTE);
  expect(events.map(({ type, at }) => ({ type, at }))).toEqual([
    { type: "agent_wait_started", at: 2 * MINUTE },
    { type: "agent_wait_ended", at: 5 * MINUTE },
  ]);
  advance(MINUTE);
  expect(events.at(-1)).toMatchObject({ type: "agent_wait_started", at: 7 * MINUTE });
});

test("short tool calls produce no wait events", () => {
  const { events, advance, update, tracker } = harness();
  for (const id of ["a", "b", "c"]) {
    update({ ...start, toolCallId: id });
    advance(MINUTE + 59_000);
    update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
    advance(10 * MINUTE);
  }
  update({ ...start, toolCallId: "d" });
  advance(MINUTE);
  tracker.observe({ type: "prompt_complete", stopReason: "end_turn" });
  advance(10 * MINUTE);
  expect(events).toEqual([]);
});
