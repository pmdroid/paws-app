import type { SerialMergeResult } from "../github";
import type { RebaseBudget } from "./budget";
import type { MergeWait } from "./wait";

export type SerialMergeFacts = {
  result: SerialMergeResult;
  queued: boolean;
  closeoutAfterUpdate: boolean;
  closeoutFailed: boolean;
  /** The budget for a conflict on this pass's main and files. */
  rebaseBudget: RebaseBudget;
  ciFixes: number;
  ciFixLimit: number;
};

export type SerialMergeStep =
  | { kind: "merged" }
  | {
      kind: "wait";
      reason: "ci" | "branch_update";
      message: string;
      base?: string;
      head?: string;
      summary?: string;
    }
  | { kind: "unreadable"; message: string }
  | { kind: "ask_closeout" }
  | { kind: "return"; reason: "rebase-conflict" | "ci-failed" }
  | { kind: "ask_ci" }
  | { kind: "ask_conflict"; message: string }
  | { kind: "reverify" }
  | { kind: "failed"; message: string };

export function serialMergeStep(facts: SerialMergeFacts): {
  step: SerialMergeStep;
  leaveQueue: boolean;
} {
  const { result } = facts;
  const unreadable =
    result.outcome === "blocked" && result.message?.startsWith("could not read") === true;
  const mainMoved = result.outcome === "sha_moved" || result.outcome === "rejected";
  const keepsPlace =
    unreadable ||
    result.outcome === "waiting" ||
    (facts.closeoutAfterUpdate && !facts.closeoutFailed && mainMoved);
  return { step: step(facts, unreadable, mainMoved), leaveQueue: facts.queued && !keepsPlace };
}

function step(facts: SerialMergeFacts, unreadable: boolean, mainMoved: boolean): SerialMergeStep {
  const { result } = facts;
  const candidate = {
    ...(result.base === undefined ? {} : { base: result.base }),
    ...(result.head === undefined ? {} : { head: result.head }),
  };
  if (result.outcome === "waiting")
    return {
      kind: "wait",
      reason: "ci",
      message: result.message ?? "Waiting for CI on the candidate commit.",
      ...candidate,
      ...(result.summary === undefined ? {} : { summary: result.summary }),
    };
  if (result.merged) return { kind: "merged" };
  if (unreadable) return { kind: "unreadable", message: result.message ?? result.outcome };
  if (facts.closeoutFailed) return { kind: "ask_closeout" };
  if (result.outcome === "conflict")
    return facts.rebaseBudget.allowed
      ? { kind: "return", reason: "rebase-conflict" }
      : { kind: "ask_conflict", message: facts.rebaseBudget.message };
  if (result.outcome === "ci_failed")
    return facts.ciFixes < facts.ciFixLimit
      ? { kind: "return", reason: "ci-failed" }
      : { kind: "ask_ci" };
  if (mainMoved)
    return facts.closeoutAfterUpdate
      ? { kind: "reverify" }
      : {
          kind: "wait",
          reason: "branch_update",
          message: "Main moved again before the merge. Updating the branch and waiting for CI.",
          ...candidate,
        };
  return { kind: "failed", message: result.message ?? result.outcome };
}

export type MergeStep =
  | { kind: "merged" }
  | ({ kind: "wait" } & MergeWait)
  | { kind: "returned" }
  | { kind: "asked" }
  | { kind: "failed"; reason: string; message: string }
  | { kind: "obsolete" };
