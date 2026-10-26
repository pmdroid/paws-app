import { describe, expect, test } from "bun:test";
import type { SerialMergeResult } from "../github";
import { serialMergeStep, type SerialMergeFacts } from "./step";

function facts(result: Partial<SerialMergeResult>, rest: Partial<SerialMergeFacts> = {}) {
  return serialMergeStep({
    result: { merged: false, outcome: "blocked", branch: "paws/eng-1", ...result },
    queued: false,
    closeoutAfterUpdate: false,
    closeoutFailed: false,
    rebaseBudget: { allowed: true, spent: 0 },
    ciFixes: 0,
    ciFixLimit: 3,
    ...rest,
  });
}

describe("serial merge step", () => {
  test("a merged pull request is merged and leaves the queue", () => {
    expect(facts({ merged: true, outcome: "merged" }, { queued: true })).toEqual({
      step: { kind: "merged" },
      leaveQueue: true,
    });
  });

  test("waiting for CI keeps the place and carries the candidate", () => {
    expect(
      facts({ outcome: "waiting", base: "b1", head: "h1", summary: "ok" }, { queued: true }),
    ).toEqual({
      step: {
        kind: "wait",
        reason: "ci",
        message: "Waiting for CI on the candidate commit.",
        base: "b1",
        head: "h1",
        summary: "ok",
      },
      leaveQueue: false,
    });
  });

  test("unreadable gates keep the place and retry", () => {
    expect(facts({ message: "could not read checks" }, { queued: true })).toEqual({
      step: { kind: "unreadable", message: "could not read checks" },
      leaveQueue: false,
    });
  });

  test("a rejected Closeout re-verification asks for help", () => {
    expect(facts({ outcome: "rejected" }, { closeoutFailed: true, queued: true })).toEqual({
      step: { kind: "ask_closeout" },
      leaveQueue: true,
    });
  });

  test("a conflict returns to the agent until the rebase budget is spent", () => {
    expect(facts({ outcome: "conflict" }).step).toEqual({
      kind: "return",
      reason: "rebase-conflict",
    });
    expect(
      facts(
        { outcome: "conflict" },
        { rebaseBudget: { allowed: false, message: "The branch still conflicts." } },
      ).step,
    ).toEqual({ kind: "ask_conflict", message: "The branch still conflicts." });
  });

  test("failed CI returns to the agent, then asks once the fixes are spent", () => {
    expect(facts({ outcome: "ci_failed", message: "ci red" }).step).toEqual({
      kind: "return",
      reason: "ci-failed",
    });
    expect(
      facts({ outcome: "ci_failed", message: "ci red" }, { ciFixes: 2, ciFixLimit: 2 }).step,
    ).toEqual({ kind: "ask_ci" });
  });

  for (const outcome of ["sha_moved", "rejected"] as const) {
    test(`main moving (${outcome}) updates the branch and waits for CI again`, () => {
      expect(facts({ outcome, base: "b2", head: "h2" }, { queued: true })).toEqual({
        step: {
          kind: "wait",
          reason: "branch_update",
          message: "Main moved again before the merge. Updating the branch and waiting for CI.",
          base: "b2",
          head: "h2",
        },
        leaveQueue: true,
      });
    });

    test(`main moving (${outcome}) runs Closeout again in place when configured`, () => {
      expect(facts({ outcome }, { queued: true, closeoutAfterUpdate: true })).toEqual({
        step: { kind: "reverify" },
        leaveQueue: false,
      });
    });
  }

  test("any other outcome fails with its message", () => {
    expect(facts({ outcome: "push_rejected", message: "rejected push" })).toEqual({
      step: { kind: "failed", message: "rejected push" },
      leaveQueue: false,
    });
    expect(facts({ outcome: "dirty" }, { queued: true })).toEqual({
      step: { kind: "failed", message: "dirty" },
      leaveQueue: true,
    });
  });
});
