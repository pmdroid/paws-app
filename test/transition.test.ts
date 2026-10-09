import { describe, expect, test } from "bun:test";
import {
  EPIC_EDGES,
  EPIC_STATES,
  WORK_ITEM_EDGES,
  WORK_ITEM_EVENTS,
  WORK_ITEM_STATES,
  isTerminalEpicState,
  isTerminalWorkItemState,
  transition,
  transitionEpic,
  type EpicEvent,
  type EpicState,
  type WorkItemEvent,
  type WorkItemState,
} from "../src/core";

describe("transition", () => {
  test("follows a legal edge", () => {
    expect(transition("queued", "dispatched")).toEqual({
      ok: true,
      from: "queued",
      to: "running",
      event: "dispatched",
    });
  });

  test("sends low-risk acceptance to the merge queue and high-risk to sign-off", () => {
    const low = transition("verifying", "closeout_accepted");
    expect(low.ok).toBe(true);
    if (low.ok) expect(low.to).toBe("merge_queue");
    const high = transition("verifying", "closeout_accepted_high_risk");
    expect(high).toEqual({
      ok: true,
      from: "verifying",
      to: "awaiting_signoff",
      event: "closeout_accepted_high_risk",
    });
  });

  test("rejects an edge the table does not list", () => {
    expect(transition("running", "closeout_accepted")).toEqual({
      ok: false,
      from: "running",
      event: "closeout_accepted",
      reason: "illegal_transition",
    });
  });

  test("cancel leaves every non-terminal state and stops on a terminal one", () => {
    for (const state of WORK_ITEM_STATES) {
      const result = transition(state, "cancel");
      if (isTerminalWorkItemState(state)) {
        expect(result).toEqual({ ok: false, from: state, event: "cancel", reason: "terminal" });
      } else {
        expect(result).toEqual({ ok: true, from: state, to: "cancelled", event: "cancel" });
      }
    }
  });

  test("edges only use known states and events, and cancel is not a listed edge", () => {
    const states = new Set<string>(WORK_ITEM_STATES);
    const events = new Set<string>(WORK_ITEM_EVENTS);
    const seen = new Set<string>();
    for (const edge of WORK_ITEM_EDGES) {
      expect(states.has(edge.from)).toBe(true);
      expect(states.has(edge.to)).toBe(true);
      expect(events.has(edge.event)).toBe(true);
      expect(edge.event).not.toBe("cancel");
      const key = `${edge.from}|${edge.event}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("transitionEpic", () => {
  test("cancel and completion", () => {
    expect(transitionEpic("running", "completed")).toEqual({
      ok: true,
      from: "running",
      to: "done",
      event: "completed",
    });
    for (const state of EPIC_STATES) {
      const result = transitionEpic(state, "cancel");
      if (isTerminalEpicState(state)) {
        expect(result.ok).toBe(false);
      } else {
        expect(result).toEqual({ ok: true, from: state, to: "cancelled", event: "cancel" });
      }
    }
  });

  test("edges only use known states and events", () => {
    const states = new Set<string>(EPIC_STATES);
    for (const edge of EPIC_EDGES) {
      expect(states.has(edge.from)).toBe(true);
      expect(states.has(edge.to)).toBe(true);
    }
    const sample: [EpicState, EpicEvent] = ["planning", "proposal_persisted"];
    expect(transitionEpic(sample[0], sample[1]).ok).toBe(true);
    const illegal: [WorkItemState, WorkItemEvent] = ["merged", "dispatched"];
    expect(transition(illegal[0], illegal[1]).ok).toBe(false);
  });
});
