/** Closeout's record that it accepted head S, with the policy digest it ran under when known. */
export type AcceptRow = { head: string; policyDigest: string | null };

/** What the merge lane read about head S while it held the repository lock. */
export type MergeFacts = {
  /** S: the branch head the lane would merge. */
  head: string;
  /** The pull request on GitHub no longer carries S. */
  headMoved: boolean;
  accept: AcceptRow | null;
  /** The Closeout policy digest for S now: `""` without a policy, null when it cannot be read. */
  policyDigest: string | null;
  /** S has the current main as an ancestor. */
  containsMain: boolean;
  ci: "green" | "pending" | "failed";
  unresolvedThreads: number;
  /** Branch protection: a required or changes-requested review blocks the merge. */
  protection: "satisfied" | "review_required" | "changes_requested";
};

/** Why S may not merge now, in the order the lane acts on them. */
export type MergeBlock =
  | "head_moved"
  | "behind_main"
  | "not_accepted"
  | "ci_failed"
  | "ci_pending"
  | "review_threads"
  | "protection";

export type Mergeable = { ok: true } | { ok: false; block: MergeBlock };

/**
 * `mergeable(S)`: Closeout accepted S under the current policy digest, CI is green for S, S
 * contains the current main, no review thread is unresolved and branch protection is satisfied.
 * The only thing that lets the lane squash S.
 */
export function mergeable(facts: MergeFacts): Mergeable {
  if (facts.headMoved) return { ok: false, block: "head_moved" };
  // A head behind main gets a new head and a new Closeout; nothing else about S matters.
  if (!facts.containsMain) return { ok: false, block: "behind_main" };
  if (!accepted(facts)) return { ok: false, block: "not_accepted" };
  if (facts.ci === "failed") return { ok: false, block: "ci_failed" };
  if (facts.ci === "pending") return { ok: false, block: "ci_pending" };
  if (facts.unresolvedThreads > 0) return { ok: false, block: "review_threads" };
  if (facts.protection !== "satisfied") return { ok: false, block: "protection" };
  return { ok: true };
}

/**
 * The accept row binds S and the policy digest. An acceptance with no recorded Closeout run (from
 * before Paws kept one) matches on S alone.
 */
function accepted({ accept, head, policyDigest }: MergeFacts): boolean {
  if (accept === null || accept.head !== head) return false;
  return accept.policyDigest === null || accept.policyDigest === policyDigest;
}
