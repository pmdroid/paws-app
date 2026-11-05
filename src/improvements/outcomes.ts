import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  annotateImprovementCriterion,
  claimImprovementDelegation,
  closeoutStepResult,
  expiredImprovementDelegations,
  followThroughCandidates,
  immediate,
  improvementDelegation,
  improvementIssueSync,
  listImprovementActions,
  listImprovementCriteria,
  listImprovementDeliveries,
  listImprovementOutcomes,
  recordImprovementAction,
  recordImprovementIssueSync,
  recordImprovementOutcome,
  returnImprovementToReview,
  settleImprovementDelegation,
  workForLinearIssue,
  type ImprovementDelegation,
  type ImprovementImplementationState,
  type ImprovementIssueSync,
  type ImprovementVerificationState,
  type IssueWork,
} from "../db";
import { journalCaught } from "../journal";
import { listInboxItems, type ImprovementAccess, type InboxItem } from "./inbox";
import { findInboxItem, improvementDestinations, type ImprovementReviewer } from "./review";

export const IMPROVEMENT_OUTCOME_LIMITS = {
  staleSyncMs: 6 * 60 * 60_000,
  syncIntervalMs: 10 * 60_000,
  syncBatch: 50,
  delegationLeaseMs: 60_000,
  check: 300,
  result: 1_000,
  deployment: 200,
  reason: 500,
} as const;

export type IssueReader = {
  findIssue(id: string): Promise<
    | {
        ok: true;
        value: {
          id: string;
          teamId: string;
          state: "open" | "closed";
          stateType?: string;
          delegated: boolean;
        } | null;
      }
    | { ok: false; failure: "rate_limited" | "unauthorized" | "unavailable" | "unknown" }
  >;
};
export type StartIssueSession = (
  target: { kind: "issue"; id: string },
  dashboardUrl: string,
  signal?: AbortSignal,
) => Promise<{ id: string; url: string | null }>;

export type AttentionState =
  | "needs_review"
  | "rejected"
  | "accepted_unfiled"
  | "filing_failed"
  | "ready_to_delegate"
  | "working"
  | "blocked"
  | "awaiting_verification"
  | "verified"
  | "verification_stale"
  | "canceled"
  | "unavailable"
  | "stale_sync"
  | "closed";

export type RecoveryChoice = "acknowledge" | "redelegate" | "return_to_review";

export type FollowThrough = {
  id: string;
  version: number;
  repository: string;
  attention: AttentionState;
  review: { state: InboxItem["improvement"]["reviewState"]; at: number | null };
  delivery: "none" | "pending" | "failed" | "unknown" | "succeeded";
  issue: {
    id: string;
    identifier: string | null;
    url: string | null;
    confirmedAt: number;
    sync: Omit<ImprovementIssueSync, "improvementId" | "issueId"> | null;
    fresh: boolean;
  } | null;
  work: IssueWork | null;
  delegation: Omit<ImprovementDelegation, "improvementId" | "actor" | "leaseExpiresAt"> | null;
  delegate: { offered: boolean; reason: string | null };
  implementation: {
    state: ImprovementImplementationState;
    source: "paws" | "linear" | "none";
    at: number | null;
  };
  verification: {
    state: ImprovementVerificationState;
    at: number | null;
    criterion: string | null;
    stale: "recurred" | "reopened" | null;
  };
  recovery: RecoveryChoice[];
};

const BLOCKED_WORK = new Set(["failed", "awaiting_input", "paused", "manual", "exhausted"]);
const DONE: readonly ImprovementImplementationState[] = ["merged", "completed"];
const ENDED_WORK = new Set(["failed", "cancelled"]);
const TERMINAL_WORK = new Set(["failed", "cancelled", "merged", "completed"]);
const TERMINAL_ISSUE = new Set(["completed", "canceled", "duplicate"]);

function implementationOf(work: IssueWork | null, sync: ImprovementIssueSync | null) {
  if (work) {
    const state: ImprovementImplementationState =
      work.state === "merged"
        ? "merged"
        : work.state === "cancelled"
          ? "canceled"
          : work.state === "completed"
            ? "completed"
            : BLOCKED_WORK.has(work.state)
              ? "blocked"
              : "in_progress";
    return { state, source: "paws" as const, at: work.merge?.confirmedAt ?? work.updatedAt };
  }
  if (sync?.stateType) {
    const state: ImprovementImplementationState =
      sync.stateType === "completed"
        ? "completed"
        : sync.stateType === "canceled" || sync.stateType === "duplicate"
          ? "canceled"
          : "not_started";
    return { state, source: "linear" as const, at: sync.confirmedAt };
  }
  return { state: "unknown" as const, source: "none" as const, at: null };
}

function criterionOf(db: Database, item: InboxItem): string | null {
  return listImprovementCriteria(db, item.improvement.id).at(-1)?.criterion ?? item.criterion;
}

function issueOpen(sync: ImprovementIssueSync | null): boolean {
  return (
    sync?.status === "available" &&
    !["completed", "canceled", "duplicate"].includes(sync.stateType ?? "")
  );
}

export function followThrough(db: Database, item: InboxItem, now: number): FollowThrough {
  const { improvement } = item;
  const deliveries = listImprovementDeliveries(db, improvement.id).filter(
    (d) => d.operation !== "evidence_comment",
  );
  const issue = improvement.issue;
  const sync = issue ? improvementIssueSync(db, improvement.id) : null;
  const work = issue ? workForLinearIssue(db, issue.id) : null;
  const delegation = issue ? improvementDelegation(db, improvement.id) : null;
  const implementation = issue
    ? implementationOf(work, sync)
    : { state: "unknown" as const, source: "none" as const, at: null };
  const verifiedAt = improvement.verificationAt ?? 0;
  const recurred =
    improvement.verificationState === "verified" &&
    item.members.some((m) => m.status === "open" && m.lastSeenAt > verifiedAt);
  const actions = listImprovementActions(db, improvement.id);
  const verifiedIssueState = actions.findLast((a) => a.action === "verify")?.detail["issueState"];
  const issueReopened =
    typeof verifiedIssueState === "string" &&
    TERMINAL_ISSUE.has(verifiedIssueState) &&
    sync?.status === "available" &&
    sync.stateType !== null &&
    !TERMINAL_ISSUE.has(sync.stateType);
  const reopened =
    improvement.verificationState === "verified" &&
    ((implementation.source !== "none" && !DONE.includes(implementation.state)) || issueReopened);
  const stale = recurred ? "recurred" : reopened ? "reopened" : null;
  const delivery: FollowThrough["delivery"] =
    deliveries.length === 0
      ? "none"
      : deliveries.some((d) => d.state === "failed")
        ? "failed"
        : deliveries.some((d) => d.state === "unknown")
          ? "unknown"
          : deliveries.every((d) => d.state === "succeeded")
            ? "succeeded"
            : "pending";
  const fresh =
    issue !== null &&
    (sync === null
      ? now - issue.confirmedAt <= IMPROVEMENT_OUTCOME_LIMITS.staleSyncMs
      : sync.status === "available" &&
        now - sync.observedAt <= IMPROVEMENT_OUTCOME_LIMITS.staleSyncMs);
  const acknowledged = actions.at(-1)?.action === "acknowledge";
  const delegating =
    delegation !== null && delegation.state !== "failed" && delegation.issueId === issue?.id;
  const ownedElsewhere = work !== null || sync?.delegated === true || delegating;
  const delegateReason = !issue
    ? "not_linked"
    : ownedElsewhere
      ? "existing_work"
      : sync !== null && sync.status !== "available"
        ? "issue_unavailable"
        : sync !== null && !issueOpen(sync)
          ? "issue_closed"
          : null;

  let attention: AttentionState;
  if (improvement.reviewState === "needs_review") attention = "needs_review";
  else if (improvement.reviewState === "rejected") attention = "rejected";
  else if (!issue)
    attention =
      delivery === "failed" || delivery === "unknown" ? "filing_failed" : "accepted_unfiled";
  else if (acknowledged) attention = "closed";
  else if (sync && sync.status !== "available") attention = "unavailable";
  else if (improvement.verificationState === "contradicted" || stale)
    attention = "verification_stale";
  else if (improvement.verificationState === "verified") attention = "verified";
  else if (!work && !fresh) attention = "stale_sync";
  else if (implementation.state === "canceled") attention = "canceled";
  else if (DONE.includes(implementation.state)) attention = "awaiting_verification";
  else if (implementation.state === "blocked" || delegation?.state === "failed")
    attention = "blocked";
  else if (implementation.state === "in_progress" || ownedElsewhere) attention = "working";
  else attention = "ready_to_delegate";

  const settled = listImprovementDeliveries(db, improvement.id).every(
    (d) => d.state === "succeeded" || d.state === "failed",
  );
  const recovery: RecoveryChoice[] = [];
  if (issue) {
    if (["canceled", "unavailable", "blocked"].includes(attention)) recovery.push("acknowledge");
    if (work && ENDED_WORK.has(work.state) && issueOpen(sync)) recovery.push("redelegate");
    if (settled && (work === null || TERMINAL_WORK.has(work.state)))
      recovery.push("return_to_review");
  }

  return {
    id: improvement.id,
    version: improvement.version,
    repository: improvement.repository,
    attention,
    review: { state: improvement.reviewState, at: improvement.reviewedAt },
    delivery,
    issue: issue
      ? {
          id: issue.id,
          identifier: issue.identifier,
          url: issue.url,
          confirmedAt: issue.confirmedAt,
          sync: sync && {
            status: sync.status,
            stateType: sync.stateType,
            teamId: sync.teamId,
            delegated: sync.delegated,
            observedAt: sync.observedAt,
            confirmedAt: sync.confirmedAt,
          },
          fresh,
        }
      : null,
    work,
    delegation: delegation && {
      issueId: delegation.issueId,
      state: delegation.state,
      sessionId: delegation.sessionId,
      error: delegation.error,
      attempts: delegation.attempts,
      requestedAt: delegation.requestedAt,
      updatedAt: delegation.updatedAt,
    },
    delegate: { offered: delegateReason === null, reason: delegateReason },
    implementation,
    verification: {
      state: stale ? "contradicted" : improvement.verificationState,
      at: improvement.verificationAt,
      criterion: criterionOf(db, item),
      stale,
    },
    recovery,
  };
}

export function improvementFollowThrough(
  db: Database,
  access: ImprovementAccess,
  improvementId: string,
  now: number,
) {
  const item = findInboxItem(db, access, improvementId);
  if (!item) return null;
  return {
    followThrough: followThrough(db, item, now),
    outcomes: listImprovementOutcomes(db, improvementId).map(
      ({ improvementId: _id, ...outcome }) => outcome,
    ),
    actions: listImprovementActions(db, improvementId).map(
      ({ improvementId: _id, ...action }) => action,
    ),
  };
}

const ATTENTION_KIND: Partial<
  Record<AttentionState, "review" | "filing" | "work" | "verification">
> = {
  needs_review: "review",
  filing_failed: "filing",
  blocked: "work",
  canceled: "work",
  unavailable: "work",
  stale_sync: "work",
  verification_stale: "work",
  awaiting_verification: "verification",
};

function transitionOf(
  db: Database,
  view: FollowThrough,
  item: InboxItem,
): { key: string; at: number } {
  if (view.attention === "needs_review")
    return { key: `review:${view.id}:${view.version}`, at: item.improvement.createdAt };
  if (view.attention === "filing_failed") {
    const failed = listImprovementDeliveries(db, view.id).find(
      (d) => d.state === "failed" || d.state === "unknown",
    )!;
    return { key: `delivery:${failed.id}:${failed.attempts}`, at: failed.updatedAt };
  }
  const outcome = listImprovementOutcomes(db, view.id).at(-1);
  const action = listImprovementActions(db, view.id).at(-1);
  const latest = [
    outcome && { key: `outcome:${outcome.id}`, at: outcome.recordedAt },
    action && { key: `action:${action.id}`, at: action.at },
    view.work && { key: `work:${view.work.itemId}:${view.work.state}`, at: view.work.updatedAt },
  ]
    .filter((entry) => !!entry)
    .sort((a, b) => b.at - a.at)[0];
  return {
    key: `${view.attention}:${latest?.key ?? `${view.id}:${view.version}`}`,
    at: latest?.at ?? view.issue?.confirmedAt ?? item.improvement.createdAt,
  };
}

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};

export function improvementAttention(db: Database, access: ImprovementAccess, now: number) {
  const items = listInboxItems(db, access);
  const views = items.map((item) => ({ item, view: followThrough(db, item, now) }));
  const byState: Partial<Record<AttentionState, number>> = {};
  for (const { view } of views) byState[view.attention] = (byState[view.attention] ?? 0) + 1;
  const batches = new Map<
    string,
    { improvementIds: string[]; transitions: string[]; latestAt: number }
  >();
  for (const { item, view } of views) {
    const kind = ATTENTION_KIND[view.attention];
    if (!kind) continue;
    const transition = transitionOf(db, view, item);
    const batch = batches.get(kind) ?? { improvementIds: [], transitions: [], latestAt: 0 };
    batch.improvementIds.push(view.id);
    batch.transitions.push(transition.key);
    batch.latestAt = Math.max(batch.latestAt, transition.at);
    batches.set(kind, batch);
  }
  const activity = [...batches.entries()]
    .map(([kind, batch]) => ({
      key: `${kind}:${createHash("sha256").update(batch.transitions.sort().join("\n")).digest("hex").slice(0, 32)}`,
      kind,
      count: batch.improvementIds.length,
      improvementIds: batch.improvementIds,
      latestAt: batch.latestAt,
    }))
    .sort((a, b) => b.latestAt - a.latestAt);
  const count = (...states: AttentionState[]) =>
    states.reduce((sum, state) => sum + (byState[state] ?? 0), 0);
  const issues = new Map<string, number>();
  for (const { view } of views)
    if (view.issue) issues.set(view.issue.id, (issues.get(view.issue.id) ?? 0) + 1);
  const implemented = views.flatMap(({ item, view }) => {
    const first = listImprovementOutcomes(db, view.id).find(
      (o) =>
        o.track === "implementation" && DONE.includes(o.state as ImprovementImplementationState),
    );
    return first && item.improvement.reviewedAt !== null
      ? [{ view, at: first.recordedAt, from: item.improvement.reviewedAt }]
      : [];
  });
  return {
    counts: {
      newReview: count("needs_review"),
      filingErrors: count("filing_failed"),
      needsAttention: count(
        "blocked",
        "canceled",
        "unavailable",
        "stale_sync",
        "verification_stale",
      ),
      verificationDue: count("awaiting_verification"),
      total: count(
        "needs_review",
        "filing_failed",
        "blocked",
        "canceled",
        "unavailable",
        "stale_sync",
        "verification_stale",
        "awaiting_verification",
      ),
      byState,
    },
    items: views.map(({ view }) => ({ id: view.id, attention: view.attention })),
    activity,
    metrics: {
      timeToDecisionMs: median(
        views.flatMap(({ item }) =>
          item.improvement.reviewState !== "needs_review" && item.improvement.reviewedAt !== null
            ? [item.improvement.reviewedAt - item.improvement.createdAt]
            : [],
        ),
      ),
      awaitingFiling: count("accepted_unfiled", "filing_failed"),
      awaitingDelegation: count("ready_to_delegate"),
      implementationCompleted: implemented.length,
      acceptanceToImplementationMs: median(implemented.map((entry) => entry.at - entry.from)),
      verified: count("verified"),
      sharedIssues: [...issues.values()].filter((n) => n > 1).length,
    },
  };
}

export type FollowThroughOutcome =
  | {
      status: "delegated" | "existing" | "unchanged" | "in_progress" | "recorded";
      item: FollowThrough;
    }
  | {
      status: "not_found" | "conflict" | "invalid" | "forbidden" | "unavailable" | "failed";
      reason: string;
      message: string;
      item?: FollowThrough;
    };

const NOT_FOUND = {
  status: "not_found",
  reason: "not_found",
  message: "This improvement is not in your inbox. Refresh the list.",
} as const;

const MESSAGES = {
  not_linked: "Paws delegates only after the Linear issue is confirmed. Wait for filing to finish.",
  stale: "This improvement changed after you opened it. Review its current state.",
  destination:
    "Delegate only issues in a Linear team mapped to this repository that you belong to.",
  linear_unavailable: "Linear is unavailable. Nothing was delegated; try again.",
  issue_missing: "Paws can no longer read this Linear issue. Choose a recovery action.",
  issue_closed: "This Linear issue is closed. Paws does not delegate closed issues.",
  delegation_failed: "Linear did not start the Paws session. Check the issue and delegate again.",
  criterion_required: "Record a verification criterion before recording a result.",
  not_implemented: "Verified needs merged or completed work first.",
  revision_required: "Name the revision or deployed version the check ran against.",
  revision_invalid: "A revision is a 7 to 40 character commit sha.",
  revision_mismatch: "That revision is not the one Paws merged for this improvement.",
  evidence_not_found: "That check result is not part of this improvement's work.",
  evidence_failed: "That check did not pass, so it cannot verify this improvement.",
  not_applicable: "That check is not the one the verification criterion names.",
  evidence_outdated:
    "That check ran on an older revision, not the one Closeout accepted for this work.",
  verified: "This improvement is already verified. Record contrary evidence instead.",
  recovery_unavailable: "That recovery is not available for this improvement now.",
} as const;

type Reason = keyof typeof MESSAGES;

function refuse(
  status: "conflict" | "invalid" | "forbidden" | "unavailable" | "failed",
  reason: Reason,
  item?: FollowThrough,
): FollowThroughOutcome {
  return { status, reason, message: MESSAGES[reason], ...(item ? { item } : {}) };
}

function issueTeam(db: Database, item: InboxItem): string | null {
  const sync = improvementIssueSync(db, item.improvement.id);
  if (sync?.teamId) return sync.teamId;
  for (const delivery of listImprovementDeliveries(db, item.improvement.id)) {
    const linked = delivery.content?.["issue"] as { teamId?: unknown } | undefined;
    if (typeof linked?.teamId === "string") return linked.teamId;
    if (delivery.operation === "create_issue" && delivery.targetTeamId)
      return delivery.targetTeamId;
  }
  return null;
}

function syncFrom(
  db: Database,
  improvementId: string,
  issueId: string,
  observedAt: number,
  result: Awaited<ReturnType<IssueReader["findIssue"]>>,
) {
  if (!result.ok) {
    if (result.failure === "unauthorized" || result.failure === "unavailable")
      recordImprovementIssueSync(db, {
        improvementId,
        issueId,
        status: result.failure,
        observedAt,
      });
    return;
  }
  if (result.value === null) {
    recordImprovementIssueSync(db, { improvementId, issueId, status: "missing", observedAt });
    return;
  }
  const issue = result.value;
  recordImprovementIssueSync(db, {
    improvementId,
    issueId,
    status: "available",
    stateType: issue.stateType ?? (issue.state === "closed" ? "completed" : "unstarted"),
    teamId: issue.teamId,
    delegated: issue.delegated,
    observedAt,
  });
}

export async function delegateImprovement(
  db: Database,
  input: {
    reviewer: ImprovementReviewer;
    reauthorize?: () => ImprovementReviewer | null;
    improvementId: string;
    expectedVersion: number;
    linear?: IssueReader;
    startSession?: StartIssueSession;
    dashboardUrl: string;
    again?: boolean;
    signal?: AbortSignal;
    now: () => number;
  },
): Promise<FollowThroughOutcome> {
  const first = findInboxItem(db, input.reviewer, input.improvementId);
  if (!first) return NOT_FOUND;
  const view = followThrough(db, first, input.now());
  const issue = first.improvement.issue;
  if (first.improvement.reviewState !== "accepted" || !issue)
    return refuse("conflict", "not_linked", view);
  if (
    !input.again &&
    view.delegation &&
    ["started", "existing", "requested"].includes(view.delegation.state)
  )
    return {
      status: view.delegation.state === "requested" ? "in_progress" : "unchanged",
      item: view,
    };
  if (!input.again && view.work) {
    claimAndSettleExisting(db, first, input.reviewer.userId, input.now());
    return { status: "existing", item: followThrough(db, first, input.now()) };
  }
  if (first.improvement.version !== input.expectedVersion) return refuse("conflict", "stale", view);
  if (input.again && !view.recovery.includes("redelegate"))
    return refuse("conflict", "recovery_unavailable", view);
  const team = issueTeam(db, first);
  if (
    team === null ||
    !improvementDestinations(db, input.reviewer, first.improvement.repository).includes(team)
  )
    return refuse("forbidden", "destination", view);
  if (!input.linear || !input.startSession)
    return refuse("unavailable", "linear_unavailable", view);

  const observedAt = input.now();
  const read = await input.linear.findIssue(issue.id);
  syncFrom(db, first.improvement.id, issue.id, observedAt, read);
  if (!read.ok)
    return refuse("unavailable", "linear_unavailable", followThrough(db, first, input.now()));
  if (read.value === null)
    return refuse("conflict", "issue_missing", followThrough(db, first, input.now()));
  if (read.value.state === "closed")
    return refuse("conflict", "issue_closed", followThrough(db, first, input.now()));
  const freshTeam = read.value.teamId;
  if (
    !improvementDestinations(db, input.reviewer, first.improvement.repository).includes(freshTeam)
  )
    return refuse("forbidden", "destination", followThrough(db, first, input.now()));
  if (!input.again && read.value.delegated) {
    claimAndSettleExisting(db, first, input.reviewer.userId, input.now());
    return { status: "existing", item: followThrough(db, first, input.now()) };
  }

  const claim = immediate(db, (): FollowThroughOutcome | { attempts: number } => {
    const current = input.reauthorize ? input.reauthorize() : input.reviewer;
    const item = current && findInboxItem(db, current, input.improvementId);
    if (!current || !item) return NOT_FOUND;
    const latest = followThrough(db, item, input.now());
    if (!improvementDestinations(db, current, item.improvement.repository).includes(freshTeam))
      return refuse("forbidden", "destination", latest);
    if (item.improvement.version !== input.expectedVersion) {
      if (latest.delegation?.state === "requested") return { status: "in_progress", item: latest };
      return refuse("conflict", "stale", latest);
    }
    const claimed = claimImprovementDelegation(db, {
      improvementId: item.improvement.id,
      issueId: issue.id,
      actor: current.userId,
      now: input.now(),
      leaseMs: IMPROVEMENT_OUTCOME_LIMITS.delegationLeaseMs,
      ...(input.again ? { again: true } : {}),
    });
    if (!claimed) return { status: "in_progress", item: latest };
    recordImprovementAction(db, {
      improvementId: item.improvement.id,
      expectedVersion: input.expectedVersion,
      action: input.again ? "redelegate" : "delegate",
      prior: {
        delegation: latest.delegation,
        implementation: latest.implementation.state,
        work: latest.work?.itemId ?? null,
      },
      detail: { issueId: issue.id, attempt: claimed.attempts },
      actor: current.userId,
      now: input.now(),
    });
    return { attempts: claimed.attempts };
  });
  if (!("attempts" in claim)) return claim;
  try {
    const session = await input.startSession(
      { kind: "issue", id: issue.id },
      input.dashboardUrl,
      input.signal,
    );
    settleImprovementDelegation(db, {
      improvementId: first.improvement.id,
      attempts: claim.attempts,
      state: "started",
      sessionId: session.id,
      now: input.now(),
    });
    return { status: "delegated", item: followThrough(db, first, input.now()) };
  } catch (error) {
    journalCaught(error, "improvements.delegateImprovement", null);
    settleImprovementDelegation(db, {
      improvementId: first.improvement.id,
      attempts: claim.attempts,
      state: "failed",
      error: MESSAGES.delegation_failed,
      now: input.now(),
    });
    return refuse("failed", "delegation_failed", followThrough(db, first, input.now()));
  }
}

function claimAndSettleExisting(db: Database, item: InboxItem, actor: string, now: number) {
  immediate(db, () => {
    const claimed = claimImprovementDelegation(db, {
      improvementId: item.improvement.id,
      issueId: item.improvement.issue!.id,
      actor,
      now,
      leaseMs: IMPROVEMENT_OUTCOME_LIMITS.delegationLeaseMs,
    });
    if (claimed)
      settleImprovementDelegation(db, {
        improvementId: item.improvement.id,
        attempts: claimed.attempts,
        state: "existing",
        now,
      });
  });
}

export type VerificationRequest = {
  outcome: "verified" | "contradicted";
  check: string;
  result: string;
  revision?: string;
  deployment?: string;
  evidence:
    | { kind: "closeout_step"; progressId: string; stepId: string }
    | { kind: "attestation"; url?: string };
};

const SHA = /^[0-9a-f]{7,40}$/i;

export function recordVerification(
  db: Database,
  input: {
    access: ImprovementAccess & { userId: string };
    improvementId: string;
    expectedVersion: number;
    request: VerificationRequest;
    now: number;
  },
): FollowThroughOutcome {
  const { request } = input;
  return immediate(db, (): FollowThroughOutcome => {
    const item = findInboxItem(db, input.access, input.improvementId);
    if (!item) return NOT_FOUND;
    const view = followThrough(db, item, input.now);
    if (item.improvement.reviewState !== "accepted" || !view.issue)
      return refuse("conflict", "not_linked", view);
    if (item.improvement.version !== input.expectedVersion)
      return refuse("conflict", "stale", view);
    const criterion = view.verification.criterion;
    if (!criterion) return refuse("invalid", "criterion_required", view);
    const verified = request.outcome === "verified";
    if (verified && !DONE.includes(view.implementation.state))
      return refuse("conflict", "not_implemented", view);
    if (request.revision !== undefined && !SHA.test(request.revision))
      return refuse("invalid", "revision_invalid", view);
    let revision = request.revision?.toLowerCase();
    const evidence = [`check:${request.check}`, `result:${request.result}`];
    if (request.evidence.kind === "closeout_step") {
      const step = closeoutStepResult(db, request.evidence.progressId, request.evidence.stepId);
      if (!step || step.itemId !== view.work?.itemId)
        return refuse("invalid", "evidence_not_found", view);
      if (verified && (step.state !== "passed" || step.kind !== "command"))
        return refuse("invalid", "evidence_failed", view);
      const named = criterion.toLowerCase();
      if (!named.includes(step.stepId.toLowerCase()) && !named.includes(step.command.toLowerCase()))
        return refuse("invalid", "not_applicable", view);
      const accepted = view.work?.acceptedHead?.toLowerCase();
      if (!accepted || step.head.toLowerCase() !== accepted)
        return refuse("invalid", "evidence_outdated", view);
      if (revision !== undefined && !step.head.toLowerCase().startsWith(revision))
        return refuse("invalid", "revision_mismatch", view);
      revision = step.head.toLowerCase();
      evidence.push(`closeout:${step.progressId}/${step.stepId}:${step.state}`);
    } else {
      const merged = view.work?.merge?.sha?.toLowerCase();
      if (
        revision !== undefined &&
        merged &&
        !merged.startsWith(revision) &&
        !revision.startsWith(merged)
      )
        return refuse("invalid", "revision_mismatch", view);
      evidence.push(`attestation:${input.access.userId}`);
      if (request.evidence.url) evidence.push(`url:${request.evidence.url}`);
    }
    if (verified && revision === undefined && !request.deployment)
      return refuse("invalid", "revision_required", view);
    const version = recordImprovementAction(db, {
      improvementId: item.improvement.id,
      expectedVersion: input.expectedVersion,
      action: verified ? "verify" : "contradict",
      prior: {
        verification: item.improvement.verificationState,
        verificationAt: item.improvement.verificationAt,
      },
      detail: {
        criterion,
        evidence,
        revision: revision ?? null,
        deployment: request.deployment ?? null,
        issueState: view.issue.sync?.stateType ?? null,
      },
      actor: input.access.userId,
      now: input.now,
    });
    if (version === null) return refuse("conflict", "stale", view);
    recordImprovementOutcome(db, {
      improvementId: item.improvement.id,
      track: "verification",
      state: request.outcome,
      evidence,
      ...(revision ? { revision } : {}),
      ...(request.deployment ? { deployment: request.deployment } : {}),
      actor: input.access.userId,
      now: input.now,
    });
    return {
      status: "recorded",
      item: followThrough(db, findInboxItem(db, input.access, item.improvement.id)!, input.now),
    };
  });
}

export function recordCriterion(
  db: Database,
  input: {
    access: ImprovementAccess & { userId: string };
    improvementId: string;
    expectedVersion: number;
    criterion: string;
    now: number;
  },
): FollowThroughOutcome {
  return immediate(db, (): FollowThroughOutcome => {
    const item = findInboxItem(db, input.access, input.improvementId);
    if (!item) return NOT_FOUND;
    const view = followThrough(db, item, input.now);
    if (item.improvement.reviewState !== "accepted" || item.improvement.reviewedProposal === null)
      return refuse("conflict", "not_linked", view);
    if (item.improvement.version !== input.expectedVersion)
      return refuse("conflict", "stale", view);
    if (item.improvement.verificationState === "verified")
      return refuse("conflict", "verified", view);
    recordImprovementAction(db, {
      improvementId: item.improvement.id,
      expectedVersion: input.expectedVersion,
      action: "criterion",
      prior: { criterion: view.verification.criterion },
      detail: { criterion: input.criterion },
      actor: input.access.userId,
      now: input.now,
    });
    annotateImprovementCriterion(db, {
      improvementId: item.improvement.id,
      proposalVersion: item.improvement.reviewedProposal,
      criterion: input.criterion,
      actor: input.access.userId,
      now: input.now,
    });
    return {
      status: "recorded",
      item: followThrough(db, findInboxItem(db, input.access, item.improvement.id)!, input.now),
    };
  });
}

export function recoverImprovement(
  db: Database,
  input: {
    access: ImprovementAccess & { userId: string };
    improvementId: string;
    expectedVersion: number;
    choice: Exclude<RecoveryChoice, "redelegate">;
    reason: string;
    now: number;
  },
): FollowThroughOutcome {
  return immediate(db, (): FollowThroughOutcome => {
    const item = findInboxItem(db, input.access, input.improvementId);
    if (!item) return NOT_FOUND;
    const view = followThrough(db, item, input.now);
    if (item.improvement.version !== input.expectedVersion)
      return refuse("conflict", "stale", view);
    if (!view.recovery.includes(input.choice))
      return refuse("conflict", "recovery_unavailable", view);
    const created = listImprovementDeliveries(db, item.improvement.id).find(
      (d) => d.operation === "create_issue" && d.remoteId !== null,
    );
    const version = recordImprovementAction(db, {
      improvementId: item.improvement.id,
      expectedVersion: input.expectedVersion,
      action: input.choice,
      prior: {
        attention: view.attention,
        issue: view.issue,
        work: view.work,
        delegation: view.delegation,
        implementation: view.implementation,
        verification: view.verification,
        deliveries: listImprovementDeliveries(db, item.improvement.id).map((d) => ({
          id: d.id,
          operation: d.operation,
          state: d.state,
          targetIssueId: d.targetIssueId,
          remoteId: d.remoteId,
          remoteIdentifier: d.remoteIdentifier,
        })),
      },
      detail: {
        reason: input.reason,
        ...(created
          ? { createdIssue: { id: created.remoteId, identifier: created.remoteIdentifier } }
          : {}),
      },
      actor: input.access.userId,
      now: input.now,
    });
    if (version === null) return refuse("conflict", "stale", view);
    if (input.choice === "acknowledge")
      recordImprovementOutcome(db, {
        improvementId: item.improvement.id,
        track: "implementation",
        state: "canceled",
        evidence: [`reason:${input.reason}`],
        actor: input.access.userId,
        now: input.now,
      });
    else
      returnImprovementToReview(db, {
        improvementId: item.improvement.id,
        version,
        actor: input.access.userId,
        now: input.now,
      });
    return {
      status: "recorded",
      item: followThrough(db, findInboxItem(db, input.access, item.improvement.id)!, input.now),
    };
  });
}

export function reconcileImprovement(
  db: Database,
  improvementId: string,
  workspaceId: string,
  now: number,
): void {
  immediate(db, () => {
    const item = findInboxItem(db, { workspaceId }, improvementId);
    if (!item || !item.improvement.issue) return;
    const view = followThrough(db, item, now);
    if (view.attention === "closed") return;
    const { improvement } = item;
    const implementation = view.implementation;
    if (
      implementation.source !== "none" &&
      implementation.state !== improvement.implementationState
    )
      recordImprovementOutcome(db, {
        improvementId,
        track: "implementation",
        state: implementation.state,
        evidence: view.work
          ? [
              `work:${view.work.itemId}:${view.work.state}`,
              ...(view.work.pull ? [`pull:${view.work.pull.number}`] : []),
            ]
          : [`linear:${view.issue?.sync?.stateType ?? "unknown"}`],
        ...(view.work?.merge?.sha ? { revision: view.work.merge.sha } : {}),
        actor: "paws",
        now,
      });
    if (improvement.verificationState === "unknown" && DONE.includes(implementation.state))
      recordImprovementOutcome(db, {
        improvementId,
        track: "verification",
        state: "due",
        evidence: [`implementation:${implementation.state}`],
        actor: "paws",
        now,
      });
    if (improvement.verificationState === "verified" && view.verification.stale)
      recordImprovementOutcome(db, {
        improvementId,
        track: "verification",
        state: "contradicted",
        evidence:
          view.verification.stale === "recurred"
            ? item.members
                .filter(
                  (m) => m.status === "open" && m.lastSeenAt > (improvement.verificationAt ?? 0),
                )
                .map((m) => `review_finding:${m.key}`)
            : [`implementation:${implementation.state}`],
        actor: "paws",
        now,
      });
  });
}

export async function syncImprovementOutcomes(options: {
  db: Database;
  linearFor: (workspaceId: string) => Promise<IssueReader | null>;
  now?: () => number;
  limit?: number;
}): Promise<void> {
  const { db } = options;
  const now = options.now ?? Date.now;
  for (const delegation of expiredImprovementDelegations(db, now())) {
    const work = workForLinearIssue(db, delegation.issueId);
    settleImprovementDelegation(db, {
      improvementId: delegation.improvementId,
      attempts: delegation.attempts,
      state: work ? "existing" : "failed",
      ...(work
        ? {}
        : { error: "Paws did not hear back from Linear. Check the issue, then delegate again." }),
      now: now(),
    });
  }
  for (const candidate of followThroughCandidates(
    db,
    options.limit ?? IMPROVEMENT_OUTCOME_LIMITS.syncBatch,
  )) {
    const linear = await options.linearFor(candidate.workspaceId);
    if (linear) {
      const observedAt = now();
      syncFrom(
        db,
        candidate.id,
        candidate.issueId,
        observedAt,
        await linear.findIssue(candidate.issueId),
      );
    }
    reconcileImprovement(db, candidate.id, candidate.workspaceId, now());
  }
}

export function startImprovementOutcomeSync(
  options: Parameters<typeof syncImprovementOutcomes>[0] & {
    signal: AbortSignal;
    intervalMs?: number;
  },
): void {
  let running = false;
  const tick = () => {
    if (running || options.signal.aborted) return;
    running = true;
    void syncImprovementOutcomes(options)
      .catch((error: unknown) =>
        journalCaught(error, "improvements.startImprovementOutcomeSync", null),
      )
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, options.intervalMs ?? IMPROVEMENT_OUTCOME_LIMITS.syncIntervalMs);
  timer.unref?.();
  options.signal.addEventListener("abort", () => clearInterval(timer));
  tick();
}
