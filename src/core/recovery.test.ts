import { describe, expect, test } from "bun:test";
import { decideStartup } from "./recovery";
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

  test("re-verifies the recorded candidate of a verifying item nothing holds", () => {
    expect(
      decideStartup({
        itemState: "verifying",
        recoveryAttempts: 0,
        checkpoint: checkpoint("verifying"),
      }),
    ).toEqual({ type: "reverify", resumed: true });
    expect(
      decideStartup({
        itemState: "verifying",
        recoveryAttempts: 1,
        checkpoint: checkpoint("verifying"),
        sinceResumeMs: 1_000,
      }),
    ).toEqual({ type: "ask_restart" });
  });

  test("a verifying item without a recorded candidate resumes as before", () => {
    for (const saved of [null, { phase: "verifying" as const }, checkpoint("running")])
      expect(
        decideStartup({ itemState: "verifying", recoveryAttempts: 0, checkpoint: saved }),
      ).toEqual({ type: "resume", freshSession: true, checkpoint: saved });
    expect(
      decideStartup({
        itemState: "recovering",
        recoveryAttempts: 0,
        checkpoint: checkpoint("verifying"),
      }),
    ).toEqual({ type: "resume", freshSession: true, checkpoint: checkpoint("verifying") });
  });

  test("re-verifies a verifying item whose runner still holds its Closeout work", () => {
    expect(
      decideStartup({
        itemState: "verifying",
        recoveryAttempts: 1,
        checkpoint: checkpoint("verifying"),
        runnerHoldsWork: true,
      }),
    ).toEqual({ type: "reverify" });
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

  test("resumes again when the earlier resume was long enough ago to rule out a crash loop", () => {
    expect(
      decideStartup({
        itemState: "recovering",
        recoveryAttempts: 1,
        checkpoint: checkpoint("running"),
        sinceResumeMs: 45 * 60_000,
      }),
    ).toEqual({ type: "resume", freshSession: true, checkpoint: checkpoint("running") });
    expect(
      decideStartup({
        itemState: "recovering",
        recoveryAttempts: 1,
        checkpoint: checkpoint("running"),
        sinceResumeMs: 5 * 60_000,
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
  });

  test("an item waiting in the merge queue keeps its place; one with an active run re-verifies", () => {
    expect(
      decideStartup({ itemState: "merge_queue", recoveryAttempts: 0, checkpoint: null }),
    ).toEqual({ type: "keep_place", mergeCallInFlight: false });
    expect(
      decideStartup({
        itemState: "merge_queue",
        recoveryAttempts: 0,
        checkpoint: checkpoint("merge_queue"),
        mergeCallInFlight: true,
      }),
    ).toEqual({ type: "keep_place", mergeCallInFlight: true });
    expect(
      decideStartup({
        itemState: "merge_queue",
        recoveryAttempts: 0,
        checkpoint: checkpoint("merge_queue"),
        runActive: true,
      }),
    ).toEqual({ type: "reverify" });
  });

  test("a re-verify of a queued item cut short by the restart starts again", () => {
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
