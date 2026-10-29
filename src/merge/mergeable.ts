/**
 * Closeout's record that it accepted head S, with the policy digest of its run (null if none) and
 * the digest of that policy's checks marked `recheck: true` (null if the run did not record it).
 * Under `[merge] main_moved` `ci` or `overlap`, the record for the head the lane rebased into S.
 */
export type AcceptRow = {
  head: string;
  policyDigest: string | null;
  recheckDigest?: string | null;
};

/** What the merge lane read about head S while it held the repository lock. */
export type MergeFacts = {
  /** S: the branch head the lane would merge. */
  head: string;
  /** The pull request on GitHub no longer carries S. */
  headMoved: boolean;
  accept: AcceptRow | null;
  /** The Closeout policy digest for S now: `""` without a policy, null when it cannot be read. */
  policyDigest: string | null;
  /** The digest of the current policy's checks marked `recheck: true`: `""` when none is. */
  recheckDigest?: string | null;
  /** S has the current main as an ancestor. */
  containsMain: boolean;
  /**
   * `overlap` only: S is behind main, but main's new commits touch none of S's files and GitHub
   * does not require branches to be up to date, so S may merge without a rebase.
   */
  apart?: boolean;
  ci: "green" | "pending" | "failed";
  unresolvedThreads: number;
  /** Branch protection: a required or changes-requested review blocks the merge. */
  protection: "satisfied" | "review_required" | "changes_requested";
  /**
   * The risk approval of S: `not_required` for a normal-tier head or a Paws whose risk gate is
   * off, `approved` when a person approved S (or the same patch on an older main) in Paws.
   */
  riskApproval: RiskApproval;
};

export type RiskApproval = "not_required" | "approved" | "missing";

/** Why S may not merge now, in the order the lane acts on them. */
export type MergeBlock =
  | "head_moved"
  | "behind_main"
  | "not_accepted"
  | "risk_approval"
  | "ci_failed"
  | "ci_pending"
  | "review_threads"
  | "protection";

export type Mergeable = { ok: true } | { ok: false; block: MergeBlock };

/**
 * `mergeable(S)`: Closeout accepted S and no check marked `recheck: true` changed since, a person
 * approved S when its risk tier is high, CI is green for S, S contains the current main (or is
 * apart from it under `overlap`), no review thread is unresolved and branch protection is
 * satisfied. The only thing that lets the lane squash S.
 */
export function mergeable(facts: MergeFacts): Mergeable {
  if (facts.headMoved) return { ok: false, block: "head_moved" };
  // A head behind main gets a new head; nothing else about S matters.
  if (!facts.containsMain && facts.apart !== true) return { ok: false, block: "behind_main" };
  if (!closeoutAccepted(facts)) return { ok: false, block: "not_accepted" };
  if (facts.riskApproval === "missing") return { ok: false, block: "risk_approval" };
  if (facts.ci === "failed") return { ok: false, block: "ci_failed" };
  if (facts.ci === "pending") return { ok: false, block: "ci_pending" };
  if (facts.unresolvedThreads > 0) return { ok: false, block: "review_threads" };
  if (facts.protection !== "satisfied") return { ok: false, block: "protection" };
  return { ok: true };
}

/**
 * The accept row binds S and the policy it ran under. An acceptance with no recorded Closeout
 * run, or a policy that cannot be read now, sends S back through Closeout. A policy change alone
 * leaves S accepted; a change to a check marked `recheck: true` (or a run that did not record
 * those checks) sends it back.
 */
export function closeoutAccepted({
  accept,
  head,
  policyDigest,
  recheckDigest,
}: MergeFacts): boolean {
  if (accept === null || accept.head !== head) return false;
  if (accept.policyDigest === null || policyDigest === null) return false;
  if (accept.policyDigest === policyDigest) return true;
  return (
    accept.recheckDigest !== undefined &&
    accept.recheckDigest !== null &&
    accept.recheckDigest === recheckDigest
  );
}
