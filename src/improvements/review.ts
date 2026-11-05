import type { Database } from "bun:sqlite";
import {
  decideImprovement,
  immediate,
  listImprovementCriteria,
  listImprovementDecisions,
  listImprovementDeliveries,
  listImprovementProposals,
  listRetroEvidence,
  listWorkspaceRepositories,
  listWorkspaceRepositoryNames,
  repairImprovementDestination,
  requeueImprovementDelivery,
  workspaceMember,
  workspaceMemberUsable,
  type ImprovementDelivery,
  type ImprovementProposal,
  type ImprovementReview,
} from "../db";
import { inboxCounts, listInboxItems, type ImprovementAccess, type InboxItem } from "./inbox";

export type ImprovementReviewer = ImprovementAccess & {
  userId: string;
  role: "admin" | "member";
  teamIds: readonly string[];
};

export type LinkableIssue = {
  id: string;
  identifier: string;
  url: string | null;
  teamId: string;
  state: "open" | "closed";
};

export type IssueLookup = (issue: string, signal?: AbortSignal) => Promise<LinkableIssue | null>;

export function createFakeIssueLookup(issues: readonly LinkableIssue[] = []) {
  const calls: string[] = [];
  let unavailable = false;
  const lookup: IssueLookup = async (issue) => {
    calls.push(issue);
    if (unavailable) throw new Error("Linear is unavailable.");
    return issues.find((entry) => entry.id === issue || entry.identifier === issue) ?? null;
  };
  return {
    lookup,
    calls,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
  };
}

export const IMPROVEMENT_REVIEW_LIMITS = {
  criterion: 1_000,
  reason: 500,
  pageSize: 50,
  maxPageSize: 100,
  candidates: 10,
} as const;

export type ImprovementDecisionRequest =
  | {
      kind: "accept";
      proposalVersion: number;
      verificationCriterion?: string;
      intent:
        | { kind: "create"; teamId: string }
        | { kind: "link"; issue: string; addEvidenceComment?: boolean; allowClosed?: boolean };
    }
  | { kind: "reject"; reason: string }
  | { kind: "reopen" };

export type DeliveryView = {
  id: string;
  operation: ImprovementDelivery["operation"];
  status: "pending" | "retryable" | "unknown" | "succeeded";
  attempts: number;
  targetIssueId: string | null;
  targetTeamId: string | null;
  issue: { id: string | null; identifier: string | null; url: string | null } | null;
  error: string | null;
  blocked: ImprovementDelivery["blocked"];
  nextAttemptAt: number | null;
  recovery: "retry" | "choose_destination" | null;
  updatedAt: number;
};

export type ImprovementView = {
  id: string;
  version: number;
  sourceKind: InboxItem["sourceKind"];
  repository: string;
  lifecycle: InboxItem["lifecycle"];
  reviewState: InboxItem["improvement"]["reviewState"];
  proposal: Omit<ImprovementProposal, "improvementId" | "contentSha256">;
  criterion: string | null;
  decision: {
    proposalVersion: number | null;
    intent: "create" | "link" | null;
    intentIssueId: string | null;
    evidenceComment: boolean;
    reason: string | null;
    by: string | null;
    at: number | null;
  };
  issue: InboxItem["issue"];
  legacy: InboxItem["legacy"];
  deliveries: DeliveryView[];
  implementation: InboxItem["improvement"]["implementationState"];
  verification: InboxItem["verification"];
};

const deliveryStatus = (state: ImprovementDelivery["state"]): DeliveryView["status"] =>
  state === "failed"
    ? "retryable"
    : state === "unknown"
      ? "unknown"
      : state === "succeeded"
        ? "succeeded"
        : "pending";

function effectiveCriterion(db: Database, item: InboxItem): string | null {
  return listImprovementCriteria(db, item.improvement.id).at(-1)?.criterion ?? item.criterion;
}

function deliveryRecovery(delivery: ImprovementDelivery): DeliveryView["recovery"] {
  if (
    delivery.operation === "create_issue" &&
    delivery.state === "failed" &&
    delivery.blocked === "destination" &&
    delivery.remoteId === null
  )
    return "choose_destination";
  if (delivery.state === "failed" || (delivery.state === "unknown" && delivery.blocked !== null))
    return "retry";
  return null;
}

export function improvementView(db: Database, item: InboxItem): ImprovementView {
  const { improvement, proposal } = item;
  const { improvementId: _id, contentSha256: _sha, ...shown } = proposal;
  return {
    id: improvement.id,
    version: improvement.version,
    sourceKind: item.sourceKind,
    repository: improvement.repository,
    lifecycle: item.lifecycle,
    reviewState: improvement.reviewState,
    proposal: shown,
    criterion: effectiveCriterion(db, item),
    decision: {
      proposalVersion: improvement.reviewedProposal,
      intent: improvement.intent,
      intentIssueId: improvement.intentIssueId,
      evidenceComment: improvement.evidenceComment,
      reason: improvement.reviewReason,
      by: improvement.reviewedBy,
      at: improvement.reviewedAt,
    },
    issue: item.issue,
    legacy: item.legacy,
    deliveries: listImprovementDeliveries(db, improvement.id).map((delivery) => ({
      id: delivery.id,
      operation: delivery.operation,
      status: deliveryStatus(delivery.state),
      attempts: delivery.attempts,
      targetIssueId: delivery.targetIssueId,
      targetTeamId: delivery.targetTeamId,
      issue:
        delivery.state === "succeeded"
          ? {
              id:
                delivery.operation === "create_issue" ? delivery.remoteId : delivery.targetIssueId,
              identifier: delivery.remoteIdentifier,
              url: delivery.remoteUrl,
            }
          : null,
      error: delivery.state === "failed" || delivery.state === "unknown" ? delivery.error : null,
      blocked: delivery.blocked,
      nextAttemptAt: delivery.nextAttemptAt,
      recovery: deliveryRecovery(delivery),
      updatedAt: delivery.updatedAt,
    })),
    implementation: improvement.implementationState,
    verification: item.verification,
  };
}

export function findInboxItem(
  db: Database,
  access: ImprovementAccess,
  improvementId: string,
): InboxItem | null {
  return listInboxItems(db, access).find((item) => item.improvement.id === improvementId) ?? null;
}

export type InboxFilter = {
  source?: "daily" | "weekly";
  repository?: string;
  state?: InboxItem["lifecycle"];
  cursor?: number;
  limit?: number;
};

export function listImprovementPage(db: Database, access: ImprovementAccess, filter: InboxFilter) {
  const all = listInboxItems(db, access);
  const kind =
    filter.source === undefined
      ? undefined
      : filter.source === "daily"
        ? "daily_finding"
        : "retro_item";
  const matching = all.filter(
    (item) =>
      (kind === undefined || item.sourceKind === kind) &&
      (filter.repository === undefined ||
        item.improvement.repository.toLowerCase() === filter.repository.toLowerCase()) &&
      (filter.state === undefined || item.lifecycle === filter.state),
  );
  const offset = filter.cursor ?? 0;
  const limit = Math.min(
    filter.limit ?? IMPROVEMENT_REVIEW_LIMITS.pageSize,
    IMPROVEMENT_REVIEW_LIMITS.maxPageSize,
  );
  const page = matching.slice(offset, offset + limit);
  return {
    items: page.map((item) => improvementView(db, item)),
    matching: matching.length,
    counts: inboxCounts(all),
    repositories: [...new Set(all.map((item) => item.improvement.repository))].sort(),
    nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
  };
}

export function memberRepositories(db: Database, workspaceId: string, userId: string): string[] {
  const member = workspaceMember(db, workspaceId, userId);
  if (!workspaceMemberUsable(member)) return [];
  if (member.role === "admin") return listWorkspaceRepositoryNames(db, workspaceId);
  return [
    ...new Set(
      listWorkspaceRepositories(db, workspaceId)
        .filter((entry) => member.teamIds.includes(entry.teamId))
        .map((entry) => entry.repository),
    ),
  ];
}

export function improvementDestinations(
  db: Database,
  reviewer: ImprovementReviewer,
  repository: string,
): string[] {
  const teams = listWorkspaceRepositories(db, reviewer.workspaceId)
    .filter((entry) => entry.repository.toLowerCase() === repository.toLowerCase())
    .map((entry) => entry.teamId);
  return [
    ...new Set(
      reviewer.role === "admin" ? teams : teams.filter((id) => reviewer.teamIds.includes(id)),
    ),
  ];
}

function evidenceOf(db: Database, access: ImprovementAccess, item: InboxItem) {
  if (item.sourceKind === "daily_finding")
    return item.members.map((member) => ({
      kind: "review_finding" as const,
      ref: member.key,
      repository: member.repository,
      location: `${member.path}${member.lines ? `:${member.lines}` : ""}`,
      status: member.status,
      lastSeenAt: member.lastSeenAt,
    }));
  const byRetro = new Map<string, Map<string, ReturnType<typeof listRetroEvidence>[number]>>();
  return item.proposal.evidence.flatMap((ref) => {
    const [, retroId = "", evidenceId = ""] = ref.split(":");
    if (!byRetro.has(retroId))
      byRetro.set(retroId, new Map(listRetroEvidence(db, retroId).map((e) => [e.evidenceId, e])));
    const entry = byRetro.get(retroId)!.get(evidenceId);
    if (!entry || access.retroEvidence?.(retroId)?.has(evidenceId) === false) return [];
    return [
      {
        kind: "retro_evidence" as const,
        ref,
        retroId,
        repository: entry.repository,
        sourceKind: entry.sourceKind,
        occurredAt: entry.occurredAt,
        excerpt: entry.excerpt,
      },
    ];
  });
}

export function improvementDetail(
  db: Database,
  reviewer: ImprovementReviewer,
  improvementId: string,
) {
  const items = listInboxItems(db, reviewer);
  const item = items.find((entry) => entry.improvement.id === improvementId);
  if (!item) return null;
  const known = new Map<
    string,
    { issue: NonNullable<InboxItem["issue"]>; improvements: string[] }
  >();
  for (const other of items) {
    if (
      !other.issue ||
      other.improvement.repository.toLowerCase() !== item.improvement.repository.toLowerCase()
    )
      continue;
    const key = other.issue.id ?? other.issue.identifier ?? "";
    const entry = known.get(key) ?? { issue: other.issue, improvements: [] };
    entry.improvements.push(other.improvement.id);
    known.set(key, entry);
  }
  const evidence = evidenceOf(db, reviewer, item);
  const visibleRefs = new Set(
    item.sourceKind === "daily_finding"
      ? item.members.map((member) => `review_finding:${member.key}`)
      : evidence.map((entry) => entry.ref),
  );
  return {
    item: improvementView(db, item),
    proposals: listImprovementProposals(db, improvementId)
      .filter((proposal) => proposal.evidence.every((ref) => visibleRefs.has(ref)))
      .map(({ improvementId: _id, contentSha256: _sha, ...proposal }) => proposal),
    decisions: listImprovementDecisions(db, improvementId).map(
      ({ improvementId: _id, ...decision }) => decision,
    ),
    criteria: listImprovementCriteria(db, improvementId),
    evidence,
    destinations: improvementDestinations(db, reviewer, item.improvement.repository),
    candidates: [...known.values()].slice(0, IMPROVEMENT_REVIEW_LIMITS.candidates),
  };
}

export type ImprovementDecisionOutcome =
  | { status: "decided" | "unchanged"; item: ImprovementView }
  | { status: "conflict"; reason: string; message: string; item: ImprovementView }
  | {
      status: "not_found" | "invalid" | "forbidden" | "unavailable";
      reason: string;
      message: string;
      item?: ImprovementView;
      issue?: LinkableIssue;
    };

function sameDecision(db: Database, item: InboxItem, request: ImprovementDecisionRequest) {
  const current = item.improvement;
  if (request.kind === "reopen") return current.reviewState === "needs_review";
  if (request.kind === "reject")
    return current.reviewState === "rejected" && current.reviewReason === request.reason.trim();
  if (current.reviewState !== "accepted" || current.reviewedProposal !== request.proposalVersion)
    return false;
  const intent = request.intent;
  const deliveries = listImprovementDeliveries(db, current.id);
  const frozen = deliveries.find(
    (d) => d.operation === (intent.kind === "create" ? "create_issue" : "link_issue"),
  );
  const criterion = request.verificationCriterion?.trim();
  if (
    frozen === undefined ||
    (criterion !== undefined && frozen.content?.verificationCriterion !== criterion)
  )
    return false;
  if (intent.kind === "create")
    return current.intent === "create" && frozen.targetTeamId === intent.teamId;
  const linked = frozen.content?.issue as { id?: unknown; identifier?: unknown } | undefined;
  return (
    current.intent === "link" &&
    (current.intentIssueId === intent.issue ||
      linked?.id === intent.issue ||
      linked?.identifier === intent.issue ||
      frozen.remoteIdentifier === intent.issue ||
      current.issue?.identifier === intent.issue) &&
    current.evidenceComment === (intent.addEvidenceComment === true)
  );
}

const CONFLICT_MESSAGE = {
  stale: "Someone decided this improvement after you opened it. Review the current decision.",
  accepted:
    "This improvement is already accepted and its issue delivery may have reached Linear. It cannot be rejected or reopened here.",
  legacy:
    "A Findings action already filed, added or is filing these findings. Review the existing issue instead.",
  proposal_changed:
    "A newer proposal replaced the one you reviewed. Review the current text before deciding.",
  known_issue: "This improvement already has an issue. Link it instead of creating a duplicate.",
} as const;

function destinationRefusal(
  db: Database,
  reviewer: ImprovementReviewer,
  item: InboxItem,
  teamId: string,
): ImprovementDecisionOutcome | null {
  if (improvementDestinations(db, reviewer, item.improvement.repository).includes(teamId))
    return null;
  return {
    status: "forbidden",
    reason: "destination",
    message: "Choose a Linear team mapped to this repository that you belong to.",
    item: improvementView(db, item),
  };
}

function linkRefusal(
  db: Database,
  reviewer: ImprovementReviewer,
  item: InboxItem,
  linked: LinkableIssue | null,
  allowClosed: boolean,
): ImprovementDecisionOutcome | null {
  const readableTeams =
    reviewer.role === "admin"
      ? listWorkspaceRepositories(db, reviewer.workspaceId).map((entry) => entry.teamId)
      : reviewer.teamIds;
  if (linked === null || !readableTeams.includes(linked.teamId))
    return {
      status: "invalid",
      reason: "issue_not_found",
      message: "That Linear issue does not exist or Paws cannot read it.",
    };
  if (!improvementDestinations(db, reviewer, item.improvement.repository).includes(linked.teamId))
    return {
      status: "conflict",
      reason: "team_mismatch",
      message:
        "That issue belongs to a team outside this repository's mapping. Choose another issue or create one.",
      item: improvementView(db, item),
    };
  if (linked.state === "closed" && !allowClosed)
    return {
      status: "conflict",
      reason: "issue_closed",
      message:
        "That issue is closed. Linking does not reopen it. Confirm the link to a closed issue, or create a new one.",
      item: improvementView(db, item),
      issue: linked,
    } as ImprovementDecisionOutcome;
  return null;
}

export async function decideInboxItem(
  db: Database,
  input: {
    reviewer: ImprovementReviewer;
    reauthorize?: () => ImprovementReviewer | null;
    improvementId: string;
    expectedVersion: number;
    request: ImprovementDecisionRequest;
    lookup?: IssueLookup;
    signal?: AbortSignal;
    now: () => number;
  },
): Promise<ImprovementDecisionOutcome> {
  const { reviewer, request } = input;
  const notFound = {
    status: "not_found",
    reason: "not_found",
    message: "This improvement is not in your inbox. Refresh the list.",
  } as const;
  const first = findInboxItem(db, reviewer, input.improvementId);
  if (!first) return notFound;
  if (sameDecision(db, first, request))
    return { status: "unchanged", item: improvementView(db, first) };
  const conflict = (item: InboxItem, reason: keyof typeof CONFLICT_MESSAGE) =>
    ({
      status: "conflict",
      reason,
      message: CONFLICT_MESSAGE[reason],
      item: improvementView(db, item),
    }) as const;
  if (first.improvement.version !== input.expectedVersion) return conflict(first, "stale");
  if (first.improvement.reviewState === "accepted") return conflict(first, "accepted");

  let linked: LinkableIssue | null = null;
  if (request.kind === "accept") {
    if (request.proposalVersion !== first.proposal.version)
      return conflict(first, "proposal_changed");
    const criterion = request.verificationCriterion?.trim();
    if (!criterion && !effectiveCriterion(db, first))
      return {
        status: "invalid",
        reason: "criterion_required",
        message: "Add a verification criterion: how will we know this improvement worked?",
        item: improvementView(db, first),
      };
    const intent = request.intent;
    if (intent.kind === "create") {
      if (first.issue) return conflict(first, "known_issue");
      const refused = destinationRefusal(db, reviewer, first, intent.teamId);
      if (refused) return refused;
    } else {
      if (!input.lookup)
        return {
          status: "unavailable",
          reason: "linear_unavailable",
          message: "Linear is unavailable. Your decision was not saved; try again.",
        };
      try {
        linked = await input.lookup(intent.issue, input.signal);
      } catch {
        return {
          status: "unavailable",
          reason: "linear_unavailable",
          message: "Linear is unavailable. Your decision was not saved; try again.",
        };
      }
      const refused = linkRefusal(db, reviewer, first, linked, intent.allowClosed === true);
      if (refused) return refused;
    }
  }

  return immediate(db, (): ImprovementDecisionOutcome => {
    const current = input.reauthorize ? input.reauthorize() : reviewer;
    if (!current) return notFound;
    const item = findInboxItem(db, current, input.improvementId);
    if (!item) return notFound;
    if (sameDecision(db, item, request))
      return { status: "unchanged", item: improvementView(db, item) };
    if (item.improvement.version !== input.expectedVersion) return conflict(item, "stale");
    if (request.kind === "accept") {
      const refused =
        request.intent.kind === "create"
          ? destinationRefusal(db, current, item, request.intent.teamId)
          : linkRefusal(db, current, item, linked, request.intent.allowClosed === true);
      if (refused) return refused;
    }
    if (item.legacy.some((action) => action.kind !== "dismissed")) return conflict(item, "legacy");
    if (request.kind === "accept" && item.proposal.version !== request.proposalVersion)
      return conflict(item, "proposal_changed");
    let review: ImprovementReview;
    let content: Record<string, unknown> | undefined;
    let criterion: string | undefined;
    if (request.kind === "accept") {
      criterion = request.verificationCriterion?.trim() || undefined;
      const proposal = item.proposal;
      content = {
        proposalVersion: proposal.version,
        repository: item.improvement.repository,
        sourceKind: item.sourceKind,
        sourceKeys: item.sourceKeys,
        title: proposal.title,
        problem: proposal.problem,
        proposedChange: proposal.proposedChange,
        actionStep: proposal.actionStep,
        verificationCriterion: criterion ?? effectiveCriterion(db, item),
        evidence: proposal.evidence,
        ...(linked
          ? {
              issue: {
                id: linked.id,
                identifier: linked.identifier,
                teamId: linked.teamId,
                state: linked.state,
              },
            }
          : {}),
      };
      review = {
        kind: "accept",
        proposalVersion: request.proposalVersion,
        intent:
          request.intent.kind === "create"
            ? { kind: "create", teamId: request.intent.teamId }
            : {
                kind: "link",
                issueId: linked!.id,
                teamId: linked!.teamId,
                addEvidenceComment: request.intent.addEvidenceComment === true,
              },
      };
    } else
      review =
        request.kind === "reject"
          ? { kind: "reject", reason: request.reason.trim() }
          : { kind: "reopen" };
    const result = decideImprovement(db, {
      improvementId: item.improvement.id,
      expectedVersion: input.expectedVersion,
      review,
      actor: reviewer.userId,
      now: input.now(),
      ...(content ? { content } : {}),
      ...(criterion ? { criterion } : {}),
    });
    if (result.ok)
      return {
        status: "decided",
        item: improvementView(db, findInboxItem(db, current, item.improvement.id) ?? item),
      };
    if (result.reason === "unchanged")
      return { status: "unchanged", item: improvementView(db, item) };
    if (result.reason === "unknown_proposal") return conflict(item, "proposal_changed");
    if (result.reason === "not_found") return notFound;
    return conflict(item, result.reason);
  });
}

export type DeliveryRetryOutcome =
  | { status: "requeued" | "in_progress" | "succeeded"; item: ImprovementView }
  | { status: "not_found" | "conflict"; reason: string; message: string; item?: ImprovementView };

export function retryInboxDelivery(
  db: Database,
  input: { access: ImprovementAccess; improvementId: string; deliveryId: string; now: number },
): DeliveryRetryOutcome {
  return immediate(db, (): DeliveryRetryOutcome => {
    const item = findInboxItem(db, input.access, input.improvementId);
    const delivery = item
      ? listImprovementDeliveries(db, item.improvement.id).find((d) => d.id === input.deliveryId)
      : undefined;
    if (!item || !delivery)
      return {
        status: "not_found",
        reason: "not_found",
        message: "This delivery is not in your inbox. Refresh the item.",
      };
    if (delivery.state === "succeeded")
      return { status: "succeeded", item: improvementView(db, item) };
    if (delivery.state === "unknown" && delivery.blocked === null)
      return {
        status: "conflict",
        reason: "reconciling",
        message:
          "Paws does not know whether this write reached Linear. It checks the same operation before trying again.",
        item: improvementView(db, item),
      };
    const requeued =
      requeueImprovementDelivery(db, { deliveryId: delivery.id, now: input.now }) !== null;
    return {
      status: requeued ? "requeued" : "in_progress",
      item: improvementView(db, item),
    };
  });
}

export function repairInboxDestination(
  db: Database,
  input: {
    reviewer: ImprovementReviewer;
    improvementId: string;
    deliveryId: string;
    teamId: string;
    now: number;
  },
): DeliveryRetryOutcome | ImprovementDecisionOutcome {
  return immediate(db, (): DeliveryRetryOutcome | ImprovementDecisionOutcome => {
    const item = findInboxItem(db, input.reviewer, input.improvementId);
    const delivery = item
      ? listImprovementDeliveries(db, item.improvement.id).find((d) => d.id === input.deliveryId)
      : undefined;
    if (!item || !delivery)
      return {
        status: "not_found",
        reason: "not_found",
        message: "This delivery is not in your inbox. Refresh the item.",
      };
    const refused = destinationRefusal(db, input.reviewer, item, input.teamId);
    if (refused) return refused;
    if (deliveryRecovery(delivery) !== "choose_destination")
      return {
        status: "conflict",
        reason: "destination_frozen",
        message:
          "Paws may already have sent this issue to Linear, so its team cannot change. Retry to reconcile it.",
        item: improvementView(db, item),
      };
    repairImprovementDestination(db, {
      deliveryId: delivery.id,
      teamId: input.teamId,
      now: input.now,
    });
    return { status: "requeued", item: improvementView(db, item) };
  });
}
