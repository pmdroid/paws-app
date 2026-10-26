import type { PullFacts, PullFactsRead, RebaseResult, SerialMergeResult } from "../github";
import type { RebaseBudget } from "./budget";
import { mergeable, type MergeBlock, type MergeFacts } from "./mergeable";
import type { MergeWait } from "./wait";

/** What one lane turn may do. Each is called at most once per turn. */
export type LaneActions = {
  read(): Promise<PullFactsRead>;
  facts(pull: PullFacts): MergeFacts;
  rebase(): Promise<RebaseResult>;
  squash(expectedHead: string, pull: PullFacts): Promise<SerialMergeResult>;
};

export type LaneTurn =
  | { kind: "merged"; result: SerialMergeResult }
  | { kind: "blocked"; block: Exclude<MergeBlock, "behind_main">; pull: PullFacts }
  | { kind: "rebased"; base: string; head: string }
  | { kind: "stopped"; result: SerialMergeResult };

/**
 * One merge lane turn for head S: read the facts, then squash S with GitHub's expected-head guard
 * if `mergeable(S)`, rebase if S is behind main, or release. A turn never rebases and merges, and
 * never squashes a head other than the S it judged.
 */
export async function laneTurn(actions: LaneActions): Promise<LaneTurn> {
  const read = await actions.read();
  if (read.kind === "stopped") return read;
  const pull: PullFacts = read;
  if (pull.readiness.outcome === "blocked")
    return {
      kind: "stopped",
      result: {
        merged: false,
        outcome: "blocked",
        branch: pull.branch,
        head: pull.head,
        message: pull.readiness.message,
      },
    };
  const verdict = mergeable(actions.facts(pull));
  if (verdict.ok) {
    const result = await actions.squash(pull.head, pull);
    if (result.merged) return { kind: "merged", result };
    if (result.outcome === "sha_moved") return { kind: "blocked", block: "head_moved", pull };
    return { kind: "stopped", result };
  }
  if (verdict.block !== "behind_main") return { kind: "blocked", block: verdict.block, pull };
  const rebased = await actions.rebase();
  if (!rebased.rebased) return { kind: "stopped", result: rebased.result };
  return { kind: "rebased", base: rebased.base, head: rebased.head };
}

export type SerialMergeFacts = {
  turn: LaneTurn;
  queued: boolean;
  /** The budget for a conflict on this pass's main and files. */
  rebaseBudget: RebaseBudget;
  ciFixes: number;
  ciFixLimit: number;
};

export type SerialMergeStep =
  | { kind: "merged" }
  | ({ kind: "wait" } & MergeWait)
  | { kind: "unreadable"; message: string }
  /** Closeout runs on `head` before the lane may merge it. `rebased` when the lane just made it. */
  | { kind: "reverify"; head: string; base: string; rebased: boolean }
  | { kind: "return"; reason: "rebase-conflict" | "ci-failed" }
  | { kind: "ask_ci" }
  | { kind: "ask_conflict"; message: string }
  | { kind: "failed"; message: string };

export function serialMergeStep(facts: SerialMergeFacts): {
  step: SerialMergeStep;
  leaveQueue: boolean;
} {
  const next = step(facts);
  const keepsPlace =
    next.kind === "unreadable" ||
    next.kind === "reverify" ||
    (next.kind === "wait" && next.reason === "ci");
  return { step: next, leaveQueue: facts.queued && !keepsPlace };
}

function step(facts: SerialMergeFacts): SerialMergeStep {
  const { turn } = facts;
  switch (turn.kind) {
    case "merged":
      return { kind: "merged" };
    case "rebased":
      return { kind: "reverify", head: turn.head, base: turn.base, rebased: true };
    case "blocked":
      return blocked(facts, turn.block, turn.pull);
    case "stopped": {
      const { result } = turn;
      if (result.outcome === "blocked" && result.message?.startsWith("could not read") === true)
        return { kind: "unreadable", message: result.message };
      if (result.outcome === "conflict")
        return facts.rebaseBudget.allowed
          ? { kind: "return", reason: "rebase-conflict" }
          : { kind: "ask_conflict", message: facts.rebaseBudget.message };
      return { kind: "failed", message: result.message ?? result.outcome };
    }
  }
}

function blocked(
  facts: SerialMergeFacts,
  block: Exclude<MergeBlock, "behind_main">,
  pull: PullFacts,
): SerialMergeStep {
  const candidate = { base: pull.base, head: pull.head };
  switch (block) {
    case "head_moved":
      return {
        kind: "wait",
        reason: "ci",
        message: "The pull request head changed before the merge. Reading it again.",
        ...candidate,
      };
    case "not_accepted":
      return { kind: "reverify", head: pull.head, base: pull.base, rebased: false };
    case "ci_failed":
      return facts.ciFixes < facts.ciFixLimit
        ? { kind: "return", reason: "ci-failed" }
        : { kind: "ask_ci" };
    case "ci_pending":
      return {
        kind: "wait",
        reason: "ci",
        message: pull.readiness.message || "Waiting for CI on the candidate commit.",
        ...candidate,
      };
    case "review_threads":
      return {
        kind: "wait",
        reason: "review",
        queued: true,
        message: pull.readiness.message,
        ...candidate,
      };
    case "protection":
      return {
        kind: "wait",
        reason: "review",
        queued: true,
        message:
          pull.review === "changes_requested"
            ? "Changes were requested on the pull request. It merges once approved."
            : "Waiting for an approving review on the pull request.",
        ...candidate,
      };
  }
}

export type MergeStep =
  | { kind: "merged" }
  | ({ kind: "wait" } & MergeWait)
  | { kind: "returned" }
  | { kind: "asked" }
  | { kind: "failed"; reason: string; message: string }
  | { kind: "obsolete" };
