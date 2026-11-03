import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  findingGroupSources,
  getImprovement,
  improvementBySource,
  listFindingGroups,
  listImprovementProposals,
  recordImprovementProposal,
  reviewFindingsByIds,
  type FindingGroup,
  type Improvement,
  type ImprovementProposalInput,
  type ReviewFindingRecord,
} from "../db";

export function dailyFindingKey(
  finding: Pick<ReviewFindingRecord, "id" | "repository" | "key">,
): string {
  const digest = createHash("sha256").update(finding.key).digest("hex");
  return `${finding.repository.toLowerCase()}#${finding.id}:${digest}`;
}

function source(finding: ReviewFindingRecord) {
  return { kind: "daily_finding", key: dailyFindingKey(finding) } as const;
}

function findingLine(f: ReviewFindingRecord): string {
  return `- ${f.repository} ${f.path}${f.lines ? `:${f.lines}` : ""} (${f.severity}, ${f.review}): ${f.text}`;
}

function dailyProposal(
  group: Pick<FindingGroup, "title" | "summary" | "scope"> | null,
  members: readonly ReviewFindingRecord[],
): ImprovementProposalInput {
  const lines = members.map(findingLine).join("\n");
  const first = members[0]!;
  return {
    title:
      (group?.title ?? `${first.path}: ${first.text.split("\n")[0]}`).slice(0, 300) || "Finding",
    problem: group ? `${group.summary}\n\n## Review findings\n\n${lines}` : lines,
    proposedChange: group ? `Scope: ${group.scope}` : "",
    actionStep: "issue",
    verificationCriterion: "",
    evidence: members.map((f) => `review_finding:${f.key}`),
  };
}

function sameProposal(a: ImprovementProposalInput, b: ImprovementProposalInput): boolean {
  return (
    a.title === b.title &&
    a.problem === b.problem &&
    a.proposedChange === b.proposedChange &&
    a.actionStep === b.actionStep &&
    a.verificationCriterion === b.verificationCriterion &&
    JSON.stringify(a.evidence) === JSON.stringify(b.evidence)
  );
}

export type LegacyAction = {
  kind: "filed" | "added" | "dismissed" | "claimed";
  groupId: string | null;
  findingIds: number[];
  issue: string | null;
  reason: string | null;
  by: string | null;
  at: number | null;
};

export function improvementFindings(db: Database, improvementId: string): ReviewFindingRecord[] {
  const keys = new Set(
    listImprovementProposals(db, improvementId)
      .filter((p) => p.source.kind === "daily_finding")
      .map((p) => p.source.key),
  );
  const ids = [...keys].map((key) => Number(/#(\d+):/.exec(key)?.[1] ?? 0));
  return reviewFindingsByIds(db, ids)
    .filter((finding) => keys.has(dailyFindingKey(finding)))
    .sort((a, b) => a.id - b.id);
}

export function legacyActions(
  findings: readonly ReviewFindingRecord[],
  groups: readonly FindingGroup[],
): LegacyAction[] {
  const ids = new Set(findings.map((f) => f.id));
  const covered = new Set<number>();
  const actions: LegacyAction[] = [];
  for (const group of groups) {
    if (group.status === "open" && group.action === null) continue;
    const members = group.memberIds.filter((id) => ids.has(id));
    if (!members.length) continue;
    for (const id of members) covered.add(id);
    actions.push({
      kind: group.status === "open" ? "claimed" : group.status,
      groupId: group.id,
      findingIds: members,
      issue: group.filedIssue,
      reason: group.statusReason,
      by: null,
      at: null,
    });
  }
  for (const f of findings) {
    if (covered.has(f.id) || (f.status !== "filed" && f.status !== "dismissed")) continue;
    actions.push({
      kind: f.status,
      groupId: null,
      findingIds: [f.id],
      issue: f.filedIssue,
      reason: f.statusReason,
      by: f.statusBy,
      at: f.statusAt,
    });
  }
  return actions;
}

export type DailyIngestResult = {
  units: number;
  created: number;
  changed: number;
  attached: number;
  split: number;
  remaining: number;
};

type Unit = { group: FindingGroup | null; members: ReviewFindingRecord[]; acted: boolean };

export function ingestDailyFindings(
  db: Database,
  workspaceId: string,
  options: { now: number; limit?: number },
): DailyIngestResult {
  const limit = options.limit ?? 500;
  const inWorkspace = new Set(findingGroupSources(db, workspaceId).map((s) => s.id));
  const findings = new Map(reviewFindingsByIds(db, [...inWorkspace]).map((f) => [f.id, f]));
  const groups = listFindingGroups(db, workspaceId);
  const units: Unit[] = [];
  const grouped = new Set<number>();
  for (const group of groups) {
    const acted = group.status !== "open" || group.action !== null;
    const members = group.memberIds.flatMap((id) => {
      const f = findings.get(id);
      return f && (acted || f.status === "open") ? [f] : [];
    });
    if (!members.length) continue;
    for (const f of members) grouped.add(f.id);
    units.push({ group, members: members.sort((a, b) => a.id - b.id), acted });
  }
  for (const f of findings.values())
    if (!grouped.has(f.id) && f.status !== "gone")
      units.push({ group: null, members: [f], acted: f.status !== "open" });
  const first = (u: Unit) => u.members[0]!.id;
  units.sort(
    (a, b) =>
      Number(b.acted) - Number(a.acted) ||
      Number(b.group !== null) - Number(a.group !== null) ||
      first(a) - first(b),
  );
  const result: DailyIngestResult = {
    units: 0,
    created: 0,
    changed: 0,
    attached: 0,
    split: 0,
    remaining: 0,
  };
  const used = new Set<string>();
  let written = 0;
  units.forEach((unit, index) => {
    if (result.remaining) return;
    if (written >= limit) {
      result.remaining = units.length - index;
      return;
    }
    result.units++;
    if (ingestUnit(db, workspaceId, unit, groups, used, options.now, result)) written++;
  });
  return result;
}

function ingestUnit(
  db: Database,
  workspaceId: string,
  unit: Unit,
  groups: readonly FindingGroup[],
  used: Set<string>,
  now: number,
  result: DailyIngestResult,
): boolean {
  const owners = unit.members.map((f) => improvementBySource(db, workspaceId, source(f)));
  const open = (i: Improvement) =>
    i.reviewState === "needs_review" &&
    !used.has(i.id) &&
    (unit.acted || legacyActions(improvementFindings(db, i.id), groups).length === 0);
  const existing = owners.find((i): i is Improvement => i !== null && open(i)) ?? null;
  if (owners.some((i) => i !== null && i.id !== existing?.id)) result.split++;
  const unmapped = unit.members.filter((_, index) => owners[index] === null);
  if (!existing && !unmapped.length) return false;
  const owned = existing ? improvementFindings(db, existing.id) : [];
  const members = [...new Map([...owned, ...unmapped].map((f) => [f.id, f])).values()].sort(
    (a, b) => a.id - b.id,
  );
  const proposal = dailyProposal(unit.group, members);
  let target = existing;
  let wrote = false;
  unit.members.forEach((f, index) => {
    if (owners[index] !== null) return;
    const recorded = recordImprovementProposal(db, {
      workspaceId,
      repository: f.repository,
      source: source(f),
      proposal,
      ...(target ? { attachTo: target.id } : {}),
      now,
    });
    if (recorded.created) result.created++;
    else result.attached++;
    wrote = true;
    target ??= getImprovement(db, recorded.improvementId);
  });
  if (!target) return wrote;
  used.add(target.id);
  const latest = listImprovementProposals(db, target.id).at(-1);
  if (latest && sameProposal(latest, proposal)) return wrote;
  const recorded = recordImprovementProposal(db, {
    workspaceId,
    repository: target.repository,
    source: latest!.source,
    proposal,
    now,
  });
  if (!recorded.changed) return wrote;
  result.changed++;
  return true;
}
