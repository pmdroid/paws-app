import type { Database } from "bun:sqlite";
import {
  cancelImprovementEvidenceCommentSteps,
  decideImprovementSteps,
  improvementWithdrawableSteps,
  listImprovementActionsSteps,
  listImprovementCriteriaSteps,
  listImprovementDecisionsSteps,
  listImprovementDeliveriesSteps,
  listImprovementProposalsSteps,
  listRetroEvidenceSteps,
  listWorkspaceRepositories,
  listWorkspaceRepositoriesSteps,
  listWorkspaceRepositoryNamesSteps,
  repairImprovementDestinationSteps,
  requeueImprovementDeliverySteps,
  settled,
  sqliteDb,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type ImprovementDelivery,
  type ImprovementProposal,
  type ImprovementReview,
  type Q,
  type RetroEvidence,
  type Steps,
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
  recovery: "retry" | "choose_destination" | "reopen" | "cancel_comment" | null;
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

function* effectiveCriterionSteps(q: Q, item: InboxItem): Steps<string | null> {
  return (
    (yield* listImprovementCriteriaSteps(q, item.improvement.id)).at(-1)?.criterion ??
    item.criterion
  );
}

const STRANDED: readonly (ImprovementDelivery["blocked"] & string)[] = [
  "destination",
  "conflict",
  "unavailable",
];

function deliveryRecovery(
  delivery: ImprovementDelivery,
  deliveries: readonly ImprovementDelivery[],
): DeliveryView["recovery"] {
  const stranded =
    delivery.state === "failed" &&
    delivery.remoteId === null &&
    delivery.blocked !== null &&
    STRANDED.includes(delivery.blocked);
  if (stranded && delivery.operation === "link_issue") return "reopen";
  if (
    stranded &&
    delivery.operation === "evidence_comment" &&
    deliveries.some((d) => d.operation === "link_issue" && d.state === "succeeded")
  )
    return "cancel_comment";
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

export function improvementView(db: Database, item: InboxItem): Promise<ImprovementView> {
  return sqliteDb(db).run((q) => improvementViewSteps(q, item));
}

function* improvementViewSteps(q: Q, item: InboxItem): Steps<ImprovementView> {
  const { improvement, proposal } = item;
  const { improvementId: _id, contentSha256: _sha, ...shown } = proposal;
  const deliveries = yield* listImprovementDeliveriesSteps(q, improvement.id);
  const criterion = yield* effectiveCriterionSteps(q, item);
  return {
    id: improvement.id,
    version: improvement.version,
    sourceKind: item.sourceKind,
    repository: improvement.repository,
    lifecycle: item.lifecycle,
    reviewState: improvement.reviewState,
    proposal: shown,
    criterion,
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
    deliveries: deliveries.map((delivery) => ({
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
      recovery: deliveryRecovery(delivery, deliveries),
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

export async function listImprovementPage(
  db: Database,
  access: ImprovementAccess,
  filter: InboxFilter,
) {
  const store = sqliteDb(db);
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
  const items: ImprovementView[] = [];
  for (const item of page) items.push(await store.run((q) => improvementViewSteps(q, item)));
  return {
    items,
    matching: matching.length,
    counts: inboxCounts(all),
    repositories: [...new Set(all.map((item) => item.improvement.repository))].sort(),
    nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
  };
}

export function* memberRepositoriesSteps(
  q: Q,
  workspaceId: string,
  userId: string,
): Steps<string[]> {
  const member = yield* workspaceMemberSteps(q, workspaceId, userId);
  if (!workspaceMemberUsable(member)) return [];
  if (member.role === "admin") return yield* listWorkspaceRepositoryNamesSteps(q, workspaceId);
  return [
    ...new Set(
      (yield* listWorkspaceRepositoriesSteps(q, workspaceId))
        .filter((entry) => member.teamIds.includes(entry.teamId))
        .map((entry) => entry.repository),
    ),
  ];
}

export function memberRepositories(db: Database, workspaceId: string, userId: string): string[] {
  return settled(sqliteDb(db).run((q) => memberRepositoriesSteps(q, workspaceId, userId)));
}

export function improvementDestinations(
  db: Database,
  reviewer: ImprovementReviewer,
  repository: string,
): string[] {
  return destinationTeams(
    listWorkspaceRepositories(db, reviewer.workspaceId),
    reviewer,
    repository,
  );
}

function* improvementDestinationsSteps(
  q: Q,
  reviewer: ImprovementReviewer,
  repository: string,
): Steps<string[]> {
  const entries = yield* listWorkspaceRepositoriesSteps(q, reviewer.workspaceId);
  return destinationTeams(entries, reviewer, repository);
}

function destinationTeams(
  entries: readonly { repository: string; teamId: string }[],
  reviewer: ImprovementReviewer,
  repository: string,
): string[] {
  const teams = entries
    .filter((entry) => entry.repository.toLowerCase() === repository.toLowerCase())
    .map((entry) => entry.teamId);
  return [
    ...new Set(
      reviewer.role === "admin" ? teams : teams.filter((id) => reviewer.teamIds.includes(id)),
    ),
  ];
}

function* evidenceOfSteps(q: Q, access: ImprovementAccess, item: InboxItem) {
  if (item.sourceKind === "daily_finding")
    return item.members.map((member) => ({
      kind: "review_finding" as const,
      ref: member.key,
      repository: member.repository,
      location: `${member.path}${member.lines ? `:${member.lines}` : ""}`,
      status: member.status,
      lastSeenAt: member.lastSeenAt,
    }));
  const byRetro = new Map<string, Map<string, RetroEvidence>>();
  const evidence = [];
  for (const ref of item.proposal.evidence) {
    const [, retroId = "", evidenceId = ""] = ref.split(":");
    if (!byRetro.has(retroId))
      byRetro.set(
        retroId,
        new Map((yield* listRetroEvidenceSteps(q, retroId)).map((e) => [e.evidenceId, e])),
      );
    const entry = byRetro.get(retroId)!.get(evidenceId);
    if (
      !entry ||
      (access.retroEvidence !== undefined &&
        (yield* access.retroEvidence(q, retroId))?.has(evidenceId) === false)
    )
      continue;
    evidence.push({
      kind: "retro_evidence" as const,
      ref,
      retroId,
      repository: entry.repository,
      sourceKind: entry.sourceKind,
      occurredAt: entry.occurredAt,
      excerpt: entry.excerpt,
    });
  }
  return evidence;
}

export async function improvementDetail(
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
  return sqliteDb(db).run(function* (q) {
    const evidence = yield* evidenceOfSteps(q, reviewer, item);
    const visibleRefs = new Set(
      item.sourceKind === "daily_finding"
        ? item.members.map((member) => `review_finding:${member.key}`)
        : evidence.map((entry) => entry.ref),
    );
    const view = yield* improvementViewSteps(q, item);
    const proposals = yield* listImprovementProposalsSteps(q, improvementId);
    const decisions = yield* listImprovementDecisionsSteps(q, improvementId);
    const criteria = yield* listImprovementCriteriaSteps(q, improvementId);
    const destinations = yield* improvementDestinationsSteps(
      q,
      reviewer,
      item.improvement.repository,
    );
    return {
      item: view,
      proposals: proposals
        .filter((proposal) => proposal.evidence.every((ref) => visibleRefs.has(ref)))
        .map(({ improvementId: _id, contentSha256: _sha, ...proposal }) => proposal),
      decisions: decisions.map(({ improvementId: _id, ...decision }) => decision),
      criteria,
      evidence,
      destinations,
      candidates: [...known.values()].slice(0, IMPROVEMENT_REVIEW_LIMITS.candidates),
    };
  });
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

function* sameDecisionSteps(
  q: Q,
  item: InboxItem,
  request: ImprovementDecisionRequest,
): Steps<boolean> {
  const current = item.improvement;
  if (request.kind === "reopen") return current.reviewState === "needs_review";
  if (request.kind === "reject")
    return current.reviewState === "rejected" && current.reviewReason === request.reason.trim();
  if (current.reviewState !== "accepted" || current.reviewedProposal !== request.proposalVersion)
    return false;
  const intent = request.intent;
  const deliveries = yield* listImprovementDeliveriesSteps(q, current.id);
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
  cancel_comment:
    "This evidence comment may already have reached Linear, or its link has not finished. Retry it instead.",
  legacy:
    "A Findings action already filed, added or is filing these findings. Review the existing issue instead.",
  proposal_changed:
    "A newer proposal replaced the one you reviewed. Review the current text before deciding.",
  known_issue: "This improvement already has an issue. Link it instead of creating a duplicate.",
  recovered_issue:
    "Paws already created a Linear issue for this improvement before it returned to review. Link an existing issue instead of creating a replacement.",
} as const;

function* recoveredCreatedIssueSteps(q: Q, improvementId: string): Steps<boolean> {
  return (yield* listImprovementActionsSteps(q, improvementId)).some(
    (action) => action.action === "return_to_review" && action.detail["createdIssue"] !== undefined,
  );
}

function* destinationRefusalSteps(
  q: Q,
  reviewer: ImprovementReviewer,
  item: InboxItem,
  teamId: string,
): Steps<ImprovementDecisionOutcome | null> {
  if (
    (yield* improvementDestinationsSteps(q, reviewer, item.improvement.repository)).includes(teamId)
  )
    return null;
  return {
    status: "forbidden",
    reason: "destination",
    message: "Choose a Linear team mapped to this repository that you belong to.",
    item: yield* improvementViewSteps(q, item),
  };
}

function* linkRefusalSteps(
  q: Q,
  reviewer: ImprovementReviewer,
  item: InboxItem,
  linked: LinkableIssue | null,
  allowClosed: boolean,
): Steps<ImprovementDecisionOutcome | null> {
  const readableTeams =
    reviewer.role === "admin"
      ? (yield* listWorkspaceRepositoriesSteps(q, reviewer.workspaceId)).map(
          (entry) => entry.teamId,
        )
      : reviewer.teamIds;
  if (linked === null || !readableTeams.includes(linked.teamId))
    return {
      status: "invalid",
      reason: "issue_not_found",
      message: "That Linear issue does not exist or Paws cannot read it.",
    };
  if (
    !(yield* improvementDestinationsSteps(q, reviewer, item.improvement.repository)).includes(
      linked.teamId,
    )
  )
    return {
      status: "conflict",
      reason: "team_mismatch",
      message:
        "That issue belongs to a team outside this repository's mapping. Choose another issue or create one.",
      item: yield* improvementViewSteps(q, item),
    };
  if (linked.state === "closed" && !allowClosed)
    return {
      status: "conflict",
      reason: "issue_closed",
      message:
        "That issue is closed. Linking does not reopen it. Confirm the link to a closed issue, or create a new one.",
      item: yield* improvementViewSteps(q, item),
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
  const store = sqliteDb(db);
  const { reviewer, request } = input;
  const notFound = {
    status: "not_found",
    reason: "not_found",
    message: "This improvement is not in your inbox. Refresh the list.",
  } as const;
  const first = findInboxItem(db, reviewer, input.improvementId);
  if (!first) return notFound;
  function* conflict(q: Q, item: InboxItem, reason: keyof typeof CONFLICT_MESSAGE) {
    return {
      status: "conflict",
      reason,
      message: CONFLICT_MESSAGE[reason],
      item: yield* improvementViewSteps(q, item),
    } as const;
  }
  const checked = await store.run(function* (q): Steps<ImprovementDecisionOutcome | null> {
    if (yield* sameDecisionSteps(q, first, request))
      return { status: "unchanged", item: yield* improvementViewSteps(q, first) };
    if (first.improvement.version !== input.expectedVersion)
      return yield* conflict(q, first, "stale");
    if (
      first.improvement.reviewState === "accepted" &&
      !(request.kind === "reopen" && (yield* improvementWithdrawableSteps(q, first.improvement.id)))
    )
      return yield* conflict(q, first, "accepted");
    if (request.kind !== "accept") return null;
    if (request.proposalVersion !== first.proposal.version)
      return yield* conflict(q, first, "proposal_changed");
    const criterion = request.verificationCriterion?.trim();
    if (!criterion && !(yield* effectiveCriterionSteps(q, first)))
      return {
        status: "invalid",
        reason: "criterion_required",
        message: "Add a verification criterion: how will we know this improvement worked?",
        item: yield* improvementViewSteps(q, first),
      };
    const intent = request.intent;
    if (intent.kind !== "create") return null;
    if (first.issue) return yield* conflict(q, first, "known_issue");
    if (yield* recoveredCreatedIssueSteps(q, first.improvement.id))
      return yield* conflict(q, first, "recovered_issue");
    return yield* destinationRefusalSteps(q, reviewer, first, intent.teamId);
  });
  if (checked) return checked;

  let linked: LinkableIssue | null = null;
  if (request.kind === "accept" && request.intent.kind === "link") {
    const intent = request.intent;
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
    const found = linked;
    const refused = await store.run((q) =>
      linkRefusalSteps(q, reviewer, first, found, intent.allowClosed === true),
    );
    if (refused) return refused;
  }

  return store.transaction(function* (q): Steps<ImprovementDecisionOutcome> {
    const current = input.reauthorize ? input.reauthorize() : reviewer;
    if (!current) return notFound;
    const item = findInboxItem(db, current, input.improvementId);
    if (!item) return notFound;
    if (yield* sameDecisionSteps(q, item, request))
      return { status: "unchanged", item: yield* improvementViewSteps(q, item) };
    if (item.improvement.version !== input.expectedVersion)
      return yield* conflict(q, item, "stale");
    if (request.kind === "accept") {
      const refused =
        request.intent.kind === "create"
          ? yield* destinationRefusalSteps(q, current, item, request.intent.teamId)
          : yield* linkRefusalSteps(q, current, item, linked, request.intent.allowClosed === true);
      if (refused) return refused;
    }
    if (item.legacy.some((action) => action.kind !== "dismissed"))
      return yield* conflict(q, item, "legacy");
    if (request.kind === "accept" && item.proposal.version !== request.proposalVersion)
      return yield* conflict(q, item, "proposal_changed");
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
        verificationCriterion: criterion ?? (yield* effectiveCriterionSteps(q, item)),
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
    const decision = {
      improvementId: item.improvement.id,
      expectedVersion: input.expectedVersion,
      review,
      actor: reviewer.userId,
      now: input.now(),
      ...(content ? { content } : {}),
      ...(criterion ? { criterion } : {}),
    };
    const result = yield* q.transaction((tx) => decideImprovementSteps(tx, decision));
    if (result.ok)
      return {
        status: "decided",
        item: yield* improvementViewSteps(
          q,
          findInboxItem(db, current, item.improvement.id) ?? item,
        ),
      };
    if (result.reason === "unchanged")
      return { status: "unchanged", item: yield* improvementViewSteps(q, item) };
    if (result.reason === "unknown_proposal") return yield* conflict(q, item, "proposal_changed");
    if (result.reason === "not_found") return notFound;
    return yield* conflict(q, item, result.reason);
  });
}

export type DeliveryRetryOutcome =
  | { status: "requeued" | "in_progress" | "succeeded" | "cancelled"; item: ImprovementView }
  | { status: "not_found" | "conflict"; reason: string; message: string; item?: ImprovementView };

export function retryInboxDelivery(
  db: Database,
  input: { access: ImprovementAccess; improvementId: string; deliveryId: string; now: number },
): Promise<DeliveryRetryOutcome> {
  return sqliteDb(db).transaction(function* (q): Steps<DeliveryRetryOutcome> {
    const item = findInboxItem(db, input.access, input.improvementId);
    const delivery = item
      ? (yield* listImprovementDeliveriesSteps(q, item.improvement.id)).find(
          (d) => d.id === input.deliveryId,
        )
      : undefined;
    if (!item || !delivery)
      return {
        status: "not_found",
        reason: "not_found",
        message: "This delivery is not in your inbox. Refresh the item.",
      };
    if (delivery.state === "succeeded")
      return { status: "succeeded", item: yield* improvementViewSteps(q, item) };
    if (delivery.state === "unknown" && delivery.blocked === null)
      return {
        status: "conflict",
        reason: "reconciling",
        message:
          "Paws does not know whether this write reached Linear. It checks the same operation before trying again.",
        item: yield* improvementViewSteps(q, item),
      };
    const requeued =
      (yield* requeueImprovementDeliverySteps(q, { deliveryId: delivery.id, now: input.now })) !==
      null;
    return {
      status: requeued ? "requeued" : "in_progress",
      item: yield* improvementViewSteps(q, item),
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
): Promise<DeliveryRetryOutcome | ImprovementDecisionOutcome> {
  return sqliteDb(db).transaction(function* (q): Steps<
    DeliveryRetryOutcome | ImprovementDecisionOutcome
  > {
    const item = findInboxItem(db, input.reviewer, input.improvementId);
    const delivery = item
      ? (yield* listImprovementDeliveriesSteps(q, item.improvement.id)).find(
          (d) => d.id === input.deliveryId,
        )
      : undefined;
    if (!item || !delivery)
      return {
        status: "not_found",
        reason: "not_found",
        message: "This delivery is not in your inbox. Refresh the item.",
      };
    const refused = yield* destinationRefusalSteps(q, input.reviewer, item, input.teamId);
    if (refused) return refused;
    if (
      deliveryRecovery(delivery, yield* listImprovementDeliveriesSteps(q, item.improvement.id)) !==
      "choose_destination"
    )
      return {
        status: "conflict",
        reason: "destination_frozen",
        message:
          "Paws may already have sent this issue to Linear, so its team cannot change. Retry to reconcile it.",
        item: yield* improvementViewSteps(q, item),
      };
    const repair = { deliveryId: delivery.id, teamId: input.teamId, now: input.now };
    yield* q.transaction((tx) => repairImprovementDestinationSteps(tx, repair));
    return { status: "requeued", item: yield* improvementViewSteps(q, item) };
  });
}

export function cancelInboxEvidenceComment(
  db: Database,
  input: { access: ImprovementAccess; improvementId: string; deliveryId: string },
): Promise<DeliveryRetryOutcome> {
  return sqliteDb(db).transaction(function* (q): Steps<DeliveryRetryOutcome> {
    const item = findInboxItem(db, input.access, input.improvementId);
    const deliveries = item ? yield* listImprovementDeliveriesSteps(q, item.improvement.id) : [];
    const delivery = deliveries.find((d) => d.id === input.deliveryId);
    if (!item || !delivery)
      return {
        status: "not_found",
        reason: "not_found",
        message: "This delivery is not in your inbox. Refresh the item.",
      };
    if (
      deliveryRecovery(delivery, deliveries) !== "cancel_comment" ||
      (yield* q.transaction((tx) => cancelImprovementEvidenceCommentSteps(tx, delivery.id))) ===
        null
    )
      return {
        status: "conflict",
        reason: "cancel_comment",
        message: CONFLICT_MESSAGE.cancel_comment,
        item: yield* improvementViewSteps(q, item),
      };
    return {
      status: "cancelled",
      item: yield* improvementViewSteps(
        q,
        findInboxItem(db, input.access, item.improvement.id) ?? item,
      ),
    };
  });
}
