import { describe, expect, test } from "bun:test";
import { LONG_SLEEP_MS } from "./limits";
import { decideStartup, decideWake, formatPauseNote } from "./recovery";
import type { Checkpoint } from "./types";

const checkpoint = (phase: Checkpoint["phase"]): Checkpoint => ({
  phase,
  wipCommit: "abc123",
  turn: 4,
  baseSha: "base",
});

describe("startup recovery", () => {
  test("resumes a running item once from its checkpoint", () => {
    expect(
      decideStartup({
        itemState: "running",
        recoveryAttempts: 0,
        checkpoint: checkpoint("running"),
      }),
    ).toEqual({ type: "resume", freshSession: true, checkpoint: checkpoint("running") });
  });

  test("reattaches without spending the resume attempt while a runner still holds the work", () => {
    expect(
      decideStartup({
        itemState: "recovering",
        recoveryAttempts: 1,
        checkpoint: checkpoint("running"),
        runnerHoldsWork: true,
      }),
    ).toEqual({
      type: "resume",
      freshSession: true,
      checkpoint: checkpoint("running"),
      reattach: true,
    });
  });

  test("asks whether to start again when the item was already resumed", () => {
    expect(
      decideStartup({
        itemState: "recovering",
        recoveryAttempts: 1,
        checkpoint: checkpoint("verifying"),
      }),
    ).toEqual({ type: "ask_restart" });
  });

  test("starts the item again without a checkpoint, once", () => {
    expect(decideStartup({ itemState: "running", recoveryAttempts: 0, checkpoint: null })).toEqual({
      type: "resume",
      freshSession: true,
      checkpoint: null,
    });
    expect(
      decideStartup({ itemState: "recovering", recoveryAttempts: 1, checkpoint: null }),
    ).toEqual({ type: "ask_restart" });
    expect(
      decideStartup({ itemState: "merge_queue", recoveryAttempts: 0, checkpoint: null }),
    ).toEqual({ type: "reverify" });
  });

  test("fails a merge closed instead of continuing it", () => {
    expect(
      decideStartup({
        itemState: "merge_queue",
        recoveryAttempts: 0,
        checkpoint: checkpoint("merge_queue"),
      }),
    ).toEqual({ type: "reverify" });
    expect(
      decideStartup({
        itemState: "verifying",
        recoveryAttempts: 0,
        checkpoint: checkpoint("merge_queue"),
      }),
    ).toEqual({ type: "reverify" });
  });

  test("leaves a parked question where it is", () => {
    expect(
      decideStartup({
        itemState: "awaiting_input",
        recoveryAttempts: 0,
        checkpoint: checkpoint("awaiting_input"),
      }),
    ).toEqual({ type: "none" });
  });
});

describe("wake policy", () => {
  test("a live agent keeps running after a short sleep", () => {
    expect(
      decideWake({
        sleptMs: 5 * 60_000,
        itemState: "running",
        agentAlive: true,
        checkpoint: checkpoint("running"),
      }),
    ).toEqual({ type: "continue" });
  });

  test("a dead agent restarts from the checkpoint", () => {
    expect(
      decideWake({
        sleptMs: 5 * 60_000,
        itemState: "running",
        agentAlive: false,
        checkpoint: checkpoint("running"),
      }),
    ).toEqual({ type: "restart_session", checkpoint: checkpoint("running") });
  });

  test("more than two hours asleep restarts from fresh main", () => {
    expect(
      decideWake({
        sleptMs: LONG_SLEEP_MS + 1,
        itemState: "running",
        agentAlive: true,
        checkpoint: checkpoint("running"),
      }),
    ).toEqual({ type: "restart_from_main" });
  });

  test("exactly two hours does not count as a long sleep", () => {
    expect(
      decideWake({
        sleptMs: LONG_SLEEP_MS,
        itemState: "running",
        agentAlive: true,
        checkpoint: checkpoint("running"),
      }),
    ).toEqual({ type: "continue" });
  });

  test("a merge never continues across a sleep", () => {
    expect(
      decideWake({
        sleptMs: 60_000,
        itemState: "merge_queue",
        agentAlive: true,
        checkpoint: checkpoint("merge_queue"),
      }),
    ).toEqual({ type: "reverify" });
  });

  test("a parked question stays parked across a short sleep", () => {
    expect(
      decideWake({
        sleptMs: 60_000,
        itemState: "awaiting_input",
        agentAlive: false,
        checkpoint: checkpoint("awaiting_input"),
      }),
    ).toEqual({ type: "continue" });
  });
});

describe("pause note", () => {
  test("uses the demo sentence for a resume", () => {
    expect(formatPauseNote(5 * 60_000, "resuming")).toBe(
      "Paused for 5 min (laptop asleep), resuming.",
    );
    expect(formatPauseNote(42 * 60_000, "resuming")).toBe(
      "Paused for 42 min (laptop asleep), resuming.",
    );
  });

  test("says when the run is starting over from main", () => {
    expect(formatPauseNote(LONG_SLEEP_MS + 1, "fresh_main")).toBe(
      "Paused for 120 min (laptop asleep). Restarting from fresh main.",
    );
  });
});
