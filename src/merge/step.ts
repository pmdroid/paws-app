import type { TaskMergeSettings } from "../db";
import type { PullFacts, PullFactsRead, RebaseResult, SerialMergeResult } from "../github";
import type { RebaseBudget } from "./budget";
import { closeoutAccepted, mergeable, type MergeBlock, type MergeFacts } from "./mergeable";
import type { MergeWait } from "./wait";

/** What one lane turn may do. Facts are refreshed if GitHub returns new readiness. */
export type LaneActions = {
  read(): Promise<PullFactsRead>;
  facts(pull: PullFacts): MergeFacts | Promise<MergeFacts>;
  rebase(): Promise<RebaseResult>;
  squash(expectedHead: string, pull: PullFacts): Promise<SerialMergeResult>;
};

/** Why a turn released: a failed `mergeable(S)`, or main moving between the read and the squash. */
export type LaneBlock = Exclude<MergeBlock, "behind_main"> | "main_moved";

export type LaneTurn =
  | { kind: "merged"; result: SerialMergeResult }
  | { kind: "blocked"; block: LaneBlock; pull: PullFacts }
  | {
      kind: "rebased";
      base: string;
      head: string;
      /** Closeout had accepted the head the lane rebased, under the current policy digest. */
      accepted: boolean;
      pull: PullFacts;
    }
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
  const facts = await actions.facts(pull);
  const verdict = mergeable(facts);
  if (verdict.ok) {
    const result = await actions.squash(pull.head, pull);
    if (result.merged) return { kind: "merged", result };
    // CI failed or went pending, or a thread opened, while main was fetched: judge S again on the
    // fresh read and release like any other turn that finds S not mergeable.
    const recheck = result.readiness;
    if (recheck && (recheck.outcome === "ci_failed" || recheck.outcome === "pending")) {
      const fresh: PullFacts = { ...pull, readiness: recheck };
      const again = mergeable(await actions.facts(fresh));
      if (!again.ok && again.block !== "behind_main")
        return { kind: "blocked", block: again.block, pull: fresh };
    }
    if (result.outcome === "sha_moved")
      return {
        kind: "blocked",
        block: result.base !== undefined && result.base !== pull.base ? "main_moved" : "head_moved",
        pull,
      };
    return { kind: "stopped", result };
  }
  if (verdict.block !== "behind_main") return { kind: "blocked", block: verdict.block, pull };
  const rebased = await actions.rebase();
  if (!rebased.rebased) return { kind: "stopped", result: rebased.result };
  return {
    kind: "rebased",
    base: rebased.base,
    head: rebased.head,
    accepted: closeoutAccepted(facts),
    pull,
  };
}

export type SerialMergeFacts = {
  turn: LaneTurn;
  queued: boolean;
  /** `[merge] main_moved` for the task. */
  mainMoved: TaskMergeSettings["mainMoved"];
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
  /**
   * `ci` or `overlap`: the lane rebased an accepted head into `head`. Closeout's acceptance carries
   * to it, and it merges once its CI is green.
   */
  | { kind: "carry"; head: string; base: string; message: string }
  | { kind: "return"; reason: "rebase-conflict" | "ci-failed" }
  | { kind: "ask_ci" }
  /** S is high-risk and no person approved it in Paws. */
  | { kind: "ask_risk" }
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
    next.kind === "carry" ||
    (next.kind === "wait" && next.reason === "ci");
  return { step: next, leaveQueue: facts.queued && !keepsPlace };
}

function step(facts: SerialMergeFacts): SerialMergeStep {
  const { turn } = facts;
  switch (turn.kind) {
    case "merged":
      return { kind: "merged" };
    case "rebased":
      return turn.accepted && facts.mainMoved !== "closeout"
        ? {
            kind: "carry",
            head: turn.head,
            base: turn.base,
            message: carriedMessage(facts.mainMoved, turn.base, turn.pull),
          }
        : { kind: "reverify", head: turn.head, base: turn.base, rebased: true };
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

function carriedMessage(
  mainMoved: TaskMergeSettings["mainMoved"],
  base: string,
  pull: PullFacts,
): string {
  const updated = `Branch updated onto main ${base.slice(0, 7)}, waiting for CI.`;
  if (mainMoved !== "overlap")
    return `${updated} Closeout does not run again, because "When main moved before the merge" for this task is set to wait for CI in Settings → Merging.`;
  if (pull.upToDateRule)
    return `${updated} GitHub requires branches to be up to date before merging, so Paws updates the branch and waits for CI even when main changed other files. Turn off "Require branches to be up to date before merging" for the base branch to merge without an update.`;
  const shared = pull.shared ?? [];
  if (shared.length === 0) return updated;
  const listed = shared.slice(0, 5).join(", ") + (shared.length > 5 ? ", …" : "");
  return `Main changed ${listed}, which this pull request changes too. ${updated}`;
}

function blocked(facts: SerialMergeFacts, block: LaneBlock, pull: PullFacts): SerialMergeStep {
  const candidate = { base: pull.base, head: pull.head };
  switch (block) {
    case "main_moved":
      // The next turn reads main again, finds S behind it and rebases.
      return {
        kind: "wait",
        reason: "ci",
        message: "Main moved before the merge. Reading it again.",
        ...candidate,
      };
    case "head_moved":
      return {
        kind: "wait",
        reason: "ci",
        message: "The pull request head changed before the merge. Reading it again.",
        ...candidate,
      };
    case "not_accepted":
      return { kind: "reverify", head: pull.head, base: pull.base, rebased: false };
    case "risk_approval":
      return { kind: "ask_risk" };
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
