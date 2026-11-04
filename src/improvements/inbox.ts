import type { Database } from "bun:sqlite";
import {
  findingGroupingEnabled,
  lastFindingGroupRun,
  listFindingGroups,
  listImprovementProposals,
  listImprovements,
  listRetroCoverageGaps,
  listRetroEvidence,
  listRetros,
  retroScheduleRuntime,
  reviewFindingItems,
  type FindingGroupRun,
  type Improvement,
  type ImprovementProposal,
  type ImprovementSourceKind,
  type ImprovementVerificationState,
  type RetroState,
} from "../db";
import { improvementFindings, legacyActions, type LegacyAction } from "./daily";

export type ImprovementAccess = {
  workspaceId: string;
  repositories?: readonly string[];
  sessionIds?: readonly string[];
  retroEvidence?: (retroId: string) => ReadonlySet<string> | null;
};

export type InboxLifecycle = "needs_review" | "pending" | "linked" | "rejected";

export type KnownIssue = {
  id: string | null;
  identifier: string | null;
  url: string | null;
  origin: "decision" | "legacy";
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
  legacy: LegacyAction[];
  undecided: number[];
  verification: ImprovementVerificationState;
  members: DailyMember[];
};

function allowedRepository(access: ImprovementAccess, repository: string): boolean {
  return (
    access.repositories === undefined ||
    access.repositories.some((r) => r.toLowerCase() === repository.toLowerCase())
  );
}

function lifecycleOf(
  improvement: Improvement,
  legacy: readonly LegacyAction[],
  undecided: readonly number[],
): InboxLifecycle {
  if (improvement.reviewState === "rejected") return "rejected";
  if (improvement.issue) return "linked";
  if (improvement.reviewState === "accepted") return "pending";
  if (legacy.some((a) => a.kind === "claimed")) return "pending";
  if (undecided.length) return "needs_review";
  if (legacy.some((a) => a.kind === "filed" || a.kind === "added")) return "linked";
  if (legacy.length && legacy.every((a) => a.kind === "dismissed")) return "rejected";
  return "needs_review";
}

function issueOf(improvement: Improvement, legacy: readonly LegacyAction[]): KnownIssue | null {
  if (improvement.issue)
    return {
      id: improvement.issue.id,
      identifier: improvement.issue.identifier,
      url: improvement.issue.url,
      origin: "decision",
    };
  const filed = legacy.find((a) => a.issue !== null && a.kind !== "dismissed");
  return filed ? { id: null, identifier: filed.issue, url: null, origin: "legacy" } : null;
}

export function listInboxItems(db: Database, access: ImprovementAccess): InboxItem[] {
  const groups = listFindingGroups(db, access.workspaceId);
  const evidence = new Map<string, Map<string, string>>();
  const retroEvidence = (retroId: string) => {
    if (!evidence.has(retroId))
      evidence.set(
        retroId,
        new Map(listRetroEvidence(db, retroId).map((e) => [e.evidenceId, e.repository])),
      );
    return evidence.get(retroId)!;
  };
  return listImprovements(db, access.workspaceId).flatMap((improvement) => {
    if (!allowedRepository(access, improvement.repository)) return [];
    const proposals = listImprovementProposals(db, improvement.id);
    const proposal = proposals.at(-1);
    if (!proposal) return [];
    const sourceKind = proposal.source.kind;
    const sourceKeys = [...new Set(proposals.map((p) => p.source.key))];
    let members: DailyMember[] = [];
    let legacy: LegacyAction[] = [];
    let undecided: number[] = [];
    if (sourceKind === "daily_finding") {
      const findings = improvementFindings(db, improvement.id);
      if (findings.length !== sourceKeys.length) return [];
      const items = reviewFindingItems(
        db,
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
      if (!visible) return [];
      legacy = legacyActions(findings, groups);
      const decided = new Set(legacy.flatMap((a) => a.findingIds));
      undecided = findings.filter((f) => !decided.has(f.id)).map((f) => f.id);
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
      const visible =
        proposal.evidence.length > 0 &&
        proposal.evidence.every((ref) => {
          const [, retroId, evidenceId] = ref.split(":");
          const repository = retroEvidence(retroId ?? "").get(evidenceId ?? "");
          return (
            repository !== undefined &&
            allowedRepository(access, repository) &&
            (access.retroEvidence === undefined ||
              access.retroEvidence(retroId!)?.has(evidenceId!) === true)
          );
        });
      if (!visible) return [];
    }
    return [
      {
        improvement,
        sourceKind,
        sourceKeys,
        proposal,
        criterion: proposal.verificationCriterion.trim() || null,
        lifecycle: lifecycleOf(improvement, legacy, undecided),
        issue: issueOf(improvement, legacy),
        legacy,
        undecided,
        verification: improvement.verificationState,
        members,
      },
    ];
  });
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
  const scopeChanged =
    issue.origin === "decision"
      ? item.improvement.reviewedProposal !== item.proposal.version
      : item.undecided.length > 0;
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
  db: Database,
  workspaceId: string,
): ImprovementSourceStatus {
  const retro = listRetros(db, workspaceId)[0] ?? null;
  return {
    daily: {
      enabled: findingGroupingEnabled(db, workspaceId),
      lastRun: lastFindingGroupRun(db, workspaceId),
    },
    weekly: {
      lastRetro: retro && {
        id: retro.id,
        state: retro.state,
        windowStart: retro.windowStart,
        windowEnd: retro.windowEnd,
        publishedAt: retro.publishedAt,
        error: retro.error,
        coverageGaps: listRetroCoverageGaps(db, retro.id).length,
      },
      nextDueAt: retroScheduleRuntime(db, workspaceId)?.nextDueAt ?? null,
    },
  };
}
