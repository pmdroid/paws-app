import {
  findingGroupingEnabledSteps,
  lastFindingGroupRunSteps,
  listImprovementProposalsSteps,
  listImprovementsSteps,
  listRetroCoverageGapsSteps,
  listRetroEvidenceSteps,
  listRetrosSteps,
  retroScheduleRuntimeSteps,
  reviewFindingItemsSteps,
  type FindingGroupRun,
  type Improvement,
  type ImprovementProposal,
  type ImprovementSourceKind,
  type ImprovementVerificationState,
  type Q,
  type RetroState,
  type Steps,
  type Db,
} from "../db";
import { improvementFindingsSteps } from "./daily";

export type ImprovementAccess = {
  workspaceId: string;
  repositories?: readonly string[];
  sessionIds?: readonly string[];
  retroEvidence?: (q: Q, retroId: string) => Steps<ReadonlySet<string> | null>;
};

export type InboxLifecycle = "needs_review" | "pending" | "linked" | "rejected";

export type KnownIssue = {
  id: string | null;
  identifier: string | null;
  url: string | null;
  origin: "decision";
};

export type DailyMember = {
  findingId: number;
  key: string;
  status: string;
  repository: string;
  path: string;
  lines: string;
  lastSeenAt: number;
};

export type InboxItem = {
  improvement: Improvement;
  sourceKind: ImprovementSourceKind;
  sourceKeys: string[];
  proposal: ImprovementProposal;
  criterion: string | null;
  lifecycle: InboxLifecycle;
  issue: KnownIssue | null;
  verification: ImprovementVerificationState;
  members: DailyMember[];
};

function allowedRepository(access: ImprovementAccess, repository: string): boolean {
  return (
    access.repositories === undefined ||
    access.repositories.some((r) => r.toLowerCase() === repository.toLowerCase())
  );
}

function lifecycleOf(improvement: Improvement): InboxLifecycle {
  if (improvement.reviewState === "rejected") return "rejected";
  if (improvement.issue) return "linked";
  if (improvement.reviewState === "accepted") return "pending";
  return "needs_review";
}

function issueOf(improvement: Improvement): KnownIssue | null {
  if (improvement.issue)
    return {
      id: improvement.issue.id,
      identifier: improvement.issue.identifier,
      url: improvement.issue.url,
      origin: "decision",
    };
  return null;
}

export function* listInboxItemsSteps(q: Q, access: ImprovementAccess): Steps<InboxItem[]> {
  const evidence = new Map<string, Map<string, string>>();
  function* retroEvidenceSteps(retroId: string) {
    if (!evidence.has(retroId))
      evidence.set(
        retroId,
        new Map(
          (yield* listRetroEvidenceSteps(q, retroId)).map((e) => [e.evidenceId, e.repository]),
        ),
      );
    return evidence.get(retroId)!;
  }
  const result: InboxItem[] = [];
  for (const improvement of yield* listImprovementsSteps(q, access.workspaceId)) {
    if (!allowedRepository(access, improvement.repository)) continue;
    const proposals = yield* listImprovementProposalsSteps(q, improvement.id);
    const proposal = proposals.at(-1);
    if (!proposal) continue;
    const sourceKind = proposal.source.kind;
    const sourceKeys = [...new Set(proposals.map((p) => p.source.key))];
    let members: DailyMember[] = [];
    if (sourceKind === "daily_finding") {
      const findings = yield* improvementFindingsSteps(q, improvement.id);
      if (findings.length !== sourceKeys.length) continue;
      const items = yield* reviewFindingItemsSteps(
        q,
        findings.map((f) => f.id),
      );
      const visible = findings.every(
        (f) =>
          allowedRepository(access, f.repository) &&
          (access.sessionIds === undefined ||
            (items.get(f.id) ?? []).some(
              (i) => i.sessionKey !== null && access.sessionIds!.includes(i.sessionKey),
            )),
      );
      if (!visible) continue;
      members = findings.map((f) => ({
        findingId: f.id,
        key: f.key,
        status: f.status,
        repository: f.repository,
        path: f.path,
        lines: f.lines,
        lastSeenAt: f.last.at,
      }));
    } else {
      let visible = proposal.evidence.length > 0;
      for (const ref of proposal.evidence) {
        if (!visible) break;
        const [, retroId, evidenceId] = ref.split(":");
        const repository = (yield* retroEvidenceSteps(retroId ?? "")).get(evidenceId ?? "");
        visible =
          repository !== undefined &&
          allowedRepository(access, repository) &&
          (access.retroEvidence === undefined ||
            (yield* access.retroEvidence(q, retroId!))?.has(evidenceId!) === true);
      }
      if (!visible) continue;
    }
    result.push({
      improvement,
      sourceKind,
      sourceKeys,
      proposal,
      criterion: proposal.verificationCriterion.trim() || null,
      lifecycle: lifecycleOf(improvement),
      issue: issueOf(improvement),
      verification: improvement.verificationState,
      members,
    });
  }
  return result;
}

export type InboxCounts = {
  total: number;
  needsReview: number;
  daily: number;
  weekly: number;
  linked: number;
  missingCriterion: number;
};

export function inboxCounts(items: readonly InboxItem[]): InboxCounts {
  return {
    total: items.length,
    needsReview: items.filter((i) => i.lifecycle === "needs_review").length,
    daily: items.filter((i) => i.sourceKind === "daily_finding").length,
    weekly: items.filter((i) => i.sourceKind === "retro_item").length,
    linked: items.filter((i) => i.lifecycle === "linked").length,
    missingCriterion: items.filter((i) => i.lifecycle === "needs_review" && !i.criterion).length,
  };
}

export function itemsForIssue(
  items: readonly InboxItem[],
  issue: { id?: string; identifier?: string },
): InboxItem[] {
  return items.filter(
    (i) =>
      i.issue !== null &&
      ((issue.id !== undefined && i.issue.id === issue.id) ||
        (issue.identifier !== undefined && i.issue.identifier === issue.identifier)),
  );
}

export type ReuseChoice =
  | { kind: "create" }
  | { kind: "reuse"; issue: KnownIssue }
  | {
      kind: "review";
      issue: KnownIssue;
      reason: "closed" | "unconfirmed" | "scope_changed" | "recurred";
    };

export function reuseChoice(
  item: InboxItem,
  issueState: "open" | "closed" | "unknown",
): ReuseChoice {
  const issue = item.issue;
  if (!issue) return { kind: "create" };
  if (issueState === "closed") return { kind: "review", issue, reason: "closed" };
  const verifiedAt = item.improvement.verificationAt ?? 0;
  if (
    item.verification === "verified" &&
    item.members.some((m) => m.status === "open" && m.lastSeenAt > verifiedAt)
  )
    return { kind: "review", issue, reason: "recurred" };
  const scopeChanged = item.improvement.reviewedProposal !== item.proposal.version;
  if (scopeChanged) return { kind: "review", issue, reason: "scope_changed" };
  if (issueState === "unknown") return { kind: "review", issue, reason: "unconfirmed" };
  return { kind: "reuse", issue };
}

export type ImprovementSourceStatus = {
  daily: { enabled: boolean; lastRun: FindingGroupRun | null };
  weekly: {
    lastRetro: {
      id: string;
      state: RetroState;
      windowStart: number;
      windowEnd: number;
      publishedAt: number | null;
      error: string | null;
      coverageGaps: number;
    } | null;
    nextDueAt: number | null;
  };
};

export function improvementSourceStatus(
  store: Db,
  workspaceId: string,
): Promise<ImprovementSourceStatus> {
  return store.run(function* (q) {
    const retro = (yield* listRetrosSteps(q, workspaceId))[0] ?? null;
    const enabled = yield* findingGroupingEnabledSteps(q, workspaceId);
    const lastRun = yield* lastFindingGroupRunSteps(q, workspaceId);
    const coverageGaps = retro && (yield* listRetroCoverageGapsSteps(q, retro.id)).length;
    const runtime = yield* retroScheduleRuntimeSteps(q, workspaceId);
    return {
      daily: { enabled, lastRun },
      weekly: {
        lastRetro: retro && {
          id: retro.id,
          state: retro.state,
          windowStart: retro.windowStart,
          windowEnd: retro.windowEnd,
          publishedAt: retro.publishedAt,
          error: retro.error,
          coverageGaps: coverageGaps!,
        },
        nextDueAt: runtime?.nextDueAt ?? null,
      },
    };
  });
}
