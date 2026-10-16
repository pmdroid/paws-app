import { describe, expect, test } from "bun:test";
import {
  WORK_ITEM_EDGES,
  WORK_ITEM_EVENTS,
  WORK_ITEM_STATES,
  isTerminalWorkItemState,
  transition,
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

  test("recovery fails a merge closed and restarts onto the queue", () => {
    expect(transition("verifying", "lease_expired")).toMatchObject({ ok: true, to: "recovering" });
    expect(transition("merge_queue", "lease_expired")).toMatchObject({ ok: true, to: "verifying" });
    expect(transition("running", "restart")).toMatchObject({ ok: true, to: "queued" });
    expect(transition("merge_queue", "restart")).toMatchObject({ ok: true, to: "queued" });
  });

  test("explicit reverify returns only queued merges to verification", () => {
    expect(transition("merge_queue", "reverify_requested")).toMatchObject({
      ok: true,
      to: "verifying",
    });
    for (const state of WORK_ITEM_STATES.filter(
      (candidateState) => candidateState !== "merge_queue",
    ))
      expect(transition(state, "reverify_requested").ok).toBe(false);
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
