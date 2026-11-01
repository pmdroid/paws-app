import { describe, expect, test } from "bun:test";
import {
  RETIRED_WORK_ITEM_EVENTS,
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

  test("acceptance enters the merge queue and spent budgets await input", () => {
    expect(transition("verifying", "closeout_accepted")).toMatchObject({
      ok: true,
      to: "merge_queue",
    });
    for (const state of ["verifying", "merge_queue"] as const)
      expect(transition(state, "blocking_question")).toMatchObject({
        ok: true,
        to: "awaiting_input",
      });
  });

  test("recovery fails a merge closed and restarts onto the queue", () => {
    expect(transition("verifying", "lease_expired")).toMatchObject({ ok: true, to: "recovering" });
    expect(transition("merge_queue", "lease_expired")).toMatchObject({ ok: true, to: "verifying" });
    expect(transition("running", "restart")).toMatchObject({ ok: true, to: "queued" });
    expect(transition("merge_queue", "restart")).toMatchObject({ ok: true, to: "queued" });
  });

  test("explicit reverify returns queued merges and answered approvals to verification", () => {
    for (const state of ["merge_queue", "awaiting_input"] as const)
      expect(transition(state, "reverify_requested")).toMatchObject({ ok: true, to: "verifying" });
    for (const state of WORK_ITEM_STATES.filter(
      (candidateState) => candidateState !== "merge_queue" && candidateState !== "awaiting_input",
    ))
      expect(transition(state, "reverify_requested").ok).toBe(false);
  });

  test("operations without an agent turn take one direct edge", () => {
    for (const state of [
      "queued",
      "running",
      "paused",
      "recovering",
      "awaiting_input",
      "verifying",
    ] as const)
      expect(transition(state, "closeout_accepted")).toMatchObject({ ok: true, to: "merge_queue" });
    expect(transition("awaiting_input", "answer_completed")).toMatchObject({
      ok: true,
      to: "completed",
    });
    expect(transition("awaiting_input", "answer_stopped")).toMatchObject({
      ok: true,
      to: "failed",
    });
    expect(transition("merge_queue", "work_failed")).toMatchObject({ ok: true, to: "failed" });
    for (const state of WORK_ITEM_STATES.filter((candidate) => candidate !== "merge_queue"))
      expect(transition(state, "work_failed").ok).toBe(false);
  });

  test("rejects an edge the table does not list", () => {
    expect(transition("failed", "closeout_accepted")).toEqual({
      ok: false,
      from: "failed",
      event: "closeout_accepted",
      reason: "illegal_transition",
    });
  });

  test("planning stays a state with no live edge but cancel", () => {
    for (const edge of WORK_ITEM_EDGES) {
      expect(edge.from).not.toBe("planning");
      expect(edge.to).not.toBe("planning");
    }
    expect(transition("planning", "cancel")).toMatchObject({ ok: true, to: "cancelled" });
  });

  test("retired events stay out of the live union and no state accepts them", () => {
    const live = new Set<string>(WORK_ITEM_EVENTS);
    for (const event of RETIRED_WORK_ITEM_EVENTS) {
      expect(live.has(event)).toBe(false);
      for (const state of WORK_ITEM_STATES)
        expect(transition(state, event as never).ok).toBe(false);
    }
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
