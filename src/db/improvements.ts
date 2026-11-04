import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { immediate } from "./tx";
import { ulid } from "./ulid";

export type ImprovementSourceKind = "retro_item" | "daily_finding";
export type ImprovementSource = { kind: ImprovementSourceKind; key: string };
export type ImprovementActionStep = "automatic" | "rule" | "convention" | "decision" | "issue";
export type ImprovementReviewState = "needs_review" | "accepted" | "rejected";
export type ImprovementImplementationState =
  | "unknown"
  | "not_started"
  | "in_progress"
  | "blocked"
  | "merged"
  | "completed"
  | "canceled"
  | "stale";
export type ImprovementVerificationState = "unknown" | "due" | "verified" | "contradicted";
export type ImprovementDeliveryOperation = "create_issue" | "link_issue" | "evidence_comment";
export type ImprovementDeliveryState = "pending" | "claimed" | "succeeded" | "failed" | "unknown";

export type ImprovementProposalInput = {
  title: string;
  problem: string;
  proposedChange: string;
  actionStep: ImprovementActionStep;
  verificationCriterion: string;
  evidence: string[];
};

export type ImprovementProposal = ImprovementProposalInput & {
  improvementId: string;
  version: number;
  source: ImprovementSource;
  contentSha256: string;
  createdAt: number;
};

export type Improvement = {
  id: string;
  workspaceId: string;
  repository: string;
  createdAt: number;
  version: number;
  reviewState: ImprovementReviewState;
  reviewedProposal: number | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewReason: string | null;
  intent: "create" | "link" | null;
  intentIssueId: string | null;
  evidenceComment: boolean;
  issue: { id: string; identifier: string | null; url: string | null; confirmedAt: number } | null;
  implementationState: ImprovementImplementationState;
  implementationAt: number | null;
  verificationState: ImprovementVerificationState;
  verificationAt: number | null;
};

export type ImprovementDecision = {
  improvementId: string;
  version: number;
  reviewState: ImprovementReviewState;
  proposalVersion: number | null;
  intent: "create" | "link" | null;
  intentIssueId: string | null;
  evidenceComment: boolean;
  reason: string | null;
  actor: string;
  at: number;
};

export type ImprovementDelivery = {
  id: string;
  improvementId: string;
  operation: ImprovementDeliveryOperation;
  targetIssueId: string | null;
  targetTeamId: string | null;
  content: Record<string, unknown> | null;
  state: ImprovementDeliveryState;
  claimOwner: string | null;
  claimExpiresAt: number | null;
  attempts: number;
  remoteId: string | null;
  remoteIdentifier: string | null;
  remoteUrl: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ImprovementOutcome =
  | { track: "implementation"; state: ImprovementImplementationState }
  | { track: "verification"; state: ImprovementVerificationState };

export type ImprovementOutcomeRecord = ImprovementOutcome & {
  id: number;
  improvementId: string;
  evidence: string[];
  revision: string | null;
  deployment: string | null;
  actor: string;
  recordedAt: number;
};

export type ImprovementIntent =
  | { kind: "create"; teamId?: string }
  | { kind: "link"; issueId: string; addEvidenceComment?: boolean };

export type ImprovementReview =
  | { kind: "accept"; proposalVersion: number; intent: ImprovementIntent }
  | { kind: "reject"; reason: string }
  | { kind: "reopen" };

export type ImprovementDecisionResult =
  | { ok: true; improvement: Improvement }
  | {
      ok: false;
      reason: "not_found" | "stale" | "accepted" | "unknown_proposal" | "unchanged";
      improvement: Improvement | null;
    };

type ImprovementRow = {
  id: string;
  workspace_id: string;
  repository: string;
  created_at: number;
  version: number;
  review_state: ImprovementReviewState;
  reviewed_proposal: number | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  review_reason: string | null;
  intent: "create" | "link" | null;
  intent_issue_id: string | null;
  evidence_comment: number;
  issue_id: string | null;
  issue_identifier: string | null;
  issue_url: string | null;
  issue_confirmed_at: number | null;
  implementation_state: ImprovementImplementationState;
  implementation_at: number | null;
  verification_state: ImprovementVerificationState;
  verification_at: number | null;
};

function improvementFromRow(row: ImprovementRow): Improvement {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repository: row.repository,
    createdAt: row.created_at,
    version: row.version,
    reviewState: row.review_state,
    reviewedProposal: row.reviewed_proposal,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewReason: row.review_reason,
    intent: row.intent,
    intentIssueId: row.intent_issue_id,
    evidenceComment: row.evidence_comment === 1,
    issue:
      row.issue_id === null
        ? null
        : {
            id: row.issue_id,
            identifier: row.issue_identifier,
            url: row.issue_url,
            confirmedAt: row.issue_confirmed_at!,
          },
    implementationState: row.implementation_state,
    implementationAt: row.implementation_at,
    verificationState: row.verification_state,
    verificationAt: row.verification_at,
  };
}

export function getImprovement(db: Database, id: string): Improvement | null {
  const row = db.query<ImprovementRow, [string]>("SELECT * FROM improvement WHERE id = ?").get(id);
  return row === null ? null : improvementFromRow(row);
}

export function improvementBySource(
  db: Database,
  workspaceId: string,
  source: ImprovementSource,
): Improvement | null {
  const row = db
    .query<ImprovementRow, [string, string, string]>(
      `SELECT improvement.* FROM improvement_source
       JOIN improvement ON improvement.id = improvement_source.improvement_id
       WHERE improvement_source.workspace_id = ? AND source_kind = ? AND source_key = ?`,
    )
    .get(workspaceId, source.kind, source.key);
  return row === null ? null : improvementFromRow(row);
}

export function improvementsForIssue(
  db: Database,
  workspaceId: string,
  issueId: string,
): Improvement[] {
  return db
    .query<ImprovementRow, [string, string]>(
      "SELECT * FROM improvement WHERE workspace_id = ? AND issue_id = ? ORDER BY created_at, id",
    )
    .all(workspaceId, issueId)
    .map(improvementFromRow);
}

export function listImprovements(db: Database, workspaceId: string): Improvement[] {
  return db
    .query<ImprovementRow, [string]>(
      "SELECT * FROM improvement WHERE workspace_id = ? ORDER BY created_at DESC, id",
    )
    .all(workspaceId)
    .map(improvementFromRow);
}

function proposalDigest(proposal: ImprovementProposalInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        proposal.title,
        proposal.problem,
        proposal.proposedChange,
        proposal.actionStep,
        proposal.verificationCriterion,
        proposal.evidence,
      ]),
    )
    .digest("hex");
}

function nextProposalVersion(db: Database, improvementId: string): number {
  return (
    (db
      .query<{ version: number | null }, [string]>(
        "SELECT max(version) AS version FROM improvement_proposal WHERE improvement_id = ?",
      )
      .get(improvementId)?.version ?? 0) + 1
  );
}

export function recordImprovementProposal(
  db: Database,
  input: {
    workspaceId: string;
    repository: string;
    source: ImprovementSource;
    proposal: ImprovementProposalInput;
    attachTo?: string;
    now: number;
  },
): { improvementId: string; version: number; created: boolean; changed: boolean } {
  return immediate(db, () => {
    const digest = proposalDigest(input.proposal);
    const existing = db
      .query<{ id: string }, [string, string, string]>(
        `SELECT improvement_id AS id FROM improvement_source
         WHERE workspace_id = ? AND source_kind = ? AND source_key = ?`,
      )
      .get(input.workspaceId, input.source.kind, input.source.key);
    if (existing !== null && input.attachTo !== undefined && existing.id !== input.attachTo)
      throw new Error(
        `Source ${input.source.kind}:${input.source.key} belongs to another improvement`,
      );
    let improvementId: string;
    let version = 1;
    if (existing === null) {
      if (input.attachTo === undefined) {
        improvementId = ulid(input.now);
        db.run(
          "INSERT INTO improvement (id, workspace_id, repository, created_at) VALUES (?, ?, ?, ?)",
          [improvementId, input.workspaceId, input.repository, input.now],
        );
      } else {
        const target = getImprovement(db, input.attachTo);
        if (
          target === null ||
          target.workspaceId !== input.workspaceId ||
          target.repository.toLowerCase() !== input.repository.toLowerCase()
        )
          throw new Error(`Improvement ${input.attachTo} is not in this workspace and repository`);
        improvementId = target.id;
        version = nextProposalVersion(db, improvementId);
      }
      db.run(
        `INSERT INTO improvement_source (workspace_id, source_kind, source_key, improvement_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [input.workspaceId, input.source.kind, input.source.key, improvementId, input.now],
      );
    } else {
      improvementId = existing.id;
      const latest = db
        .query<{ version: number; content_sha256: string }, [string, string, string]>(
          `SELECT version, content_sha256 FROM improvement_proposal
           WHERE improvement_id = ? AND source_kind = ? AND source_key = ?
           ORDER BY version DESC LIMIT 1`,
        )
        .get(improvementId, input.source.kind, input.source.key);
      if (latest?.content_sha256 === digest)
        return { improvementId, version: latest.version, created: false, changed: false };
      version = nextProposalVersion(db, improvementId);
    }
    const proposal = input.proposal;
    db.run(
      `INSERT INTO improvement_proposal (improvement_id, version, source_kind, source_key, title,
         problem, proposed_change, action_step, verification_criterion, evidence, content_sha256,
         created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        improvementId,
        version,
        input.source.kind,
        input.source.key,
        proposal.title,
        proposal.problem,
        proposal.proposedChange,
        proposal.actionStep,
        proposal.verificationCriterion,
        JSON.stringify(proposal.evidence),
        digest,
        input.now,
      ],
    );
    return {
      improvementId,
      version,
      created: existing === null && input.attachTo === undefined,
      changed: true,
    };
  });
}

type ProposalRow = {
  improvement_id: string;
  version: number;
  source_kind: ImprovementSourceKind;
  source_key: string;
  title: string;
  problem: string;
  proposed_change: string;
  action_step: ImprovementActionStep;
  verification_criterion: string;
  evidence: string;
  content_sha256: string;
  created_at: number;
};

export function listImprovementProposals(
  db: Database,
  improvementId: string,
): ImprovementProposal[] {
  return db
    .query<ProposalRow, [string]>(
      "SELECT * FROM improvement_proposal WHERE improvement_id = ? ORDER BY version",
    )
    .all(improvementId)
    .map((row) => ({
      improvementId: row.improvement_id,
      version: row.version,
      source: { kind: row.source_kind, key: row.source_key },
      title: row.title,
      problem: row.problem,
      proposedChange: row.proposed_change,
      actionStep: row.action_step,
      verificationCriterion: row.verification_criterion,
      evidence: JSON.parse(row.evidence) as string[],
      contentSha256: row.content_sha256,
      createdAt: row.created_at,
    }));
}

export function improvementDeliveryId(
  improvementId: string,
  operation: ImprovementDeliveryOperation,
): string {
  const hex = createHash("sha256")
    .update(`paws:improvement:${improvementId}:${operation}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function decideImprovement(
  db: Database,
  input: {
    improvementId: string;
    expectedVersion: number;
    review: ImprovementReview;
    actor: string;
    now: number;
    content?: Record<string, unknown>;
    criterion?: string;
  },
): ImprovementDecisionResult {
  return immediate(db, () => {
    const current = getImprovement(db, input.improvementId);
    if (current === null) return { ok: false, reason: "not_found", improvement: null };
    if (current.version !== input.expectedVersion)
      return { ok: false, reason: "stale", improvement: current };
    if (current.reviewState === "accepted")
      return { ok: false, reason: "accepted", improvement: current };
    const review = input.review;
    if (review.kind === "reopen" && current.reviewState === "needs_review")
      return { ok: false, reason: "unchanged", improvement: current };
    if (
      review.kind === "accept" &&
      db
        .query("SELECT 1 FROM improvement_proposal WHERE improvement_id = ? AND version = ?")
        .get(input.improvementId, review.proposalVersion) === null
    )
      return { ok: false, reason: "unknown_proposal", improvement: current };
    const state: ImprovementReviewState =
      review.kind === "accept"
        ? "accepted"
        : review.kind === "reject"
          ? "rejected"
          : "needs_review";
    const proposal = review.kind === "accept" ? review.proposalVersion : null;
    const intent = review.kind === "accept" ? review.intent.kind : null;
    const intentIssue =
      review.kind === "accept" && review.intent.kind === "link" ? review.intent.issueId : null;
    const comment =
      review.kind === "accept" && review.intent.kind === "link" && review.intent.addEvidenceComment
        ? 1
        : 0;
    const reason = review.kind === "reject" ? review.reason : null;
    const version = current.version + 1;
    db.run(
      `UPDATE improvement SET version = ?, review_state = ?, reviewed_proposal = ?, reviewed_by = ?,
         reviewed_at = ?, review_reason = ?, intent = ?, intent_issue_id = ?, evidence_comment = ?
       WHERE id = ? AND version = ?`,
      [
        version,
        state,
        proposal,
        input.actor,
        input.now,
        reason,
        intent,
        intentIssue,
        comment,
        input.improvementId,
        current.version,
      ],
    );
    db.run(
      `INSERT INTO improvement_decision (improvement_id, version, review_state, proposal_version,
         intent, intent_issue_id, evidence_comment, reason, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.improvementId,
        version,
        state,
        proposal,
        intent,
        intentIssue,
        comment,
        reason,
        input.actor,
        input.now,
      ],
    );
    if (review.kind === "accept") {
      const operation = review.intent.kind === "create" ? "create_issue" : "link_issue";
      const team = review.intent.kind === "create" ? (review.intent.teamId ?? null) : null;
      const content = input.content === undefined ? null : JSON.stringify(input.content);
      insertDelivery(db, input.improvementId, operation, intentIssue, team, content, input.now);
      if (comment === 1)
        insertDelivery(
          db,
          input.improvementId,
          "evidence_comment",
          intentIssue,
          null,
          content,
          input.now,
        );
      if (input.criterion !== undefined)
        db.run(
          `INSERT INTO improvement_criterion (improvement_id, revision, proposal_version, criterion,
             actor, at) VALUES (?, (SELECT coalesce(max(revision), 0) + 1 FROM improvement_criterion
             WHERE improvement_id = ?), ?, ?, ?, ?)`,
          [
            input.improvementId,
            input.improvementId,
            review.proposalVersion,
            input.criterion,
            input.actor,
            input.now,
          ],
        );
    }
    return { ok: true, improvement: getImprovement(db, input.improvementId)! };
  });
}

function insertDelivery(
  db: Database,
  improvementId: string,
  operation: ImprovementDeliveryOperation,
  targetIssueId: string | null,
  targetTeamId: string | null,
  content: string | null,
  now: number,
): void {
  db.run(
    `INSERT INTO improvement_delivery (id, improvement_id, operation, target_issue_id,
       target_team_id, content, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      improvementDeliveryId(improvementId, operation),
      improvementId,
      operation,
      targetIssueId,
      targetTeamId,
      content,
      now,
      now,
    ],
  );
}

export type ImprovementCriterion = {
  revision: number;
  proposalVersion: number;
  criterion: string;
  actor: string;
  at: number;
};

export function listImprovementCriteria(
  db: Database,
  improvementId: string,
): ImprovementCriterion[] {
  return db
    .query<ImprovementCriterion, [string]>(
      `SELECT revision, proposal_version AS proposalVersion, criterion, actor, at
       FROM improvement_criterion WHERE improvement_id = ? ORDER BY revision`,
    )
    .all(improvementId);
}

export function requeueImprovementDelivery(
  db: Database,
  input: { deliveryId: string; now: number },
): ImprovementDelivery | null {
  const row = db
    .query<DeliveryRow, [number, string]>(
      `UPDATE improvement_delivery SET state = 'pending', updated_at = ?
       WHERE id = ? AND state = 'failed' RETURNING *`,
    )
    .get(input.now, input.deliveryId);
  return row === null ? null : deliveryFromRow(row);
}

export function acceptedImprovementsForFindings(
  db: Database,
  workspaceId: string,
  findingIds: readonly number[],
): Improvement[] {
  if (findingIds.length === 0) return [];
  return db
    .query<ImprovementRow, [string, string]>(
      `SELECT DISTINCT improvement.* FROM improvement_source AS source
       JOIN improvement ON improvement.id = source.improvement_id
       WHERE source.workspace_id = ? AND source.source_kind = 'daily_finding'
         AND improvement.review_state = 'accepted'
         AND EXISTS (SELECT 1 FROM json_each(?) AS finding
           WHERE instr(source.source_key, '#' || finding.value || ':') > 0)
       ORDER BY improvement.id`,
    )
    .all(workspaceId, JSON.stringify(findingIds))
    .map(improvementFromRow);
}

export function listImprovementDecisions(
  db: Database,
  improvementId: string,
): ImprovementDecision[] {
  return db
    .query<
      {
        improvement_id: string;
        version: number;
        review_state: ImprovementReviewState;
        proposal_version: number | null;
        intent: "create" | "link" | null;
        intent_issue_id: string | null;
        evidence_comment: number;
        reason: string | null;
        actor: string;
        at: number;
      },
      [string]
    >("SELECT * FROM improvement_decision WHERE improvement_id = ? ORDER BY version")
    .all(improvementId)
    .map((row) => ({
      improvementId: row.improvement_id,
      version: row.version,
      reviewState: row.review_state,
      proposalVersion: row.proposal_version,
      intent: row.intent,
      intentIssueId: row.intent_issue_id,
      evidenceComment: row.evidence_comment === 1,
      reason: row.reason,
      actor: row.actor,
      at: row.at,
    }));
}

type DeliveryRow = {
  id: string;
  improvement_id: string;
  operation: ImprovementDeliveryOperation;
  target_issue_id: string | null;
  target_team_id: string | null;
  content: string | null;
  state: ImprovementDeliveryState;
  claim_owner: string | null;
  claim_expires_at: number | null;
  attempts: number;
  remote_id: string | null;
  remote_identifier: string | null;
  remote_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

function deliveryFromRow(row: DeliveryRow): ImprovementDelivery {
  return {
    id: row.id,
    improvementId: row.improvement_id,
    operation: row.operation,
    targetIssueId: row.target_issue_id,
    targetTeamId: row.target_team_id,
    content: row.content === null ? null : (JSON.parse(row.content) as Record<string, unknown>),
    state: row.state,
    claimOwner: row.claim_owner,
    claimExpiresAt: row.claim_expires_at,
    attempts: row.attempts,
    remoteId: row.remote_id,
    remoteIdentifier: row.remote_identifier,
    remoteUrl: row.remote_url,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listImprovementDeliveries(
  db: Database,
  improvementId: string,
): ImprovementDelivery[] {
  return db
    .query<DeliveryRow, [string]>(
      "SELECT * FROM improvement_delivery WHERE improvement_id = ? ORDER BY created_at, operation",
    )
    .all(improvementId)
    .map(deliveryFromRow);
}

export function claimableImprovementDeliveries(
  db: Database,
  workspaceId: string,
  now: number,
): ImprovementDelivery[] {
  return db
    .query<DeliveryRow, [string, number]>(
      `SELECT delivery.* FROM improvement_delivery AS delivery
       JOIN improvement ON improvement.id = delivery.improvement_id
       WHERE improvement.workspace_id = ? AND (delivery.state IN ('pending','failed','unknown')
         OR (delivery.state = 'claimed' AND delivery.claim_expires_at <= ?))
       ORDER BY delivery.created_at, delivery.id`,
    )
    .all(workspaceId, now)
    .map(deliveryFromRow);
}

export function claimImprovementDelivery(
  db: Database,
  input: { deliveryId: string; owner: string; now: number; leaseMs: number },
): ImprovementDelivery | null {
  return immediate(db, () => {
    const row = db
      .query<DeliveryRow, [string, number, number, string, number]>(
        `UPDATE improvement_delivery SET state = 'claimed', claim_owner = ?, claim_expires_at = ?,
           attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND (state IN ('pending','failed','unknown')
           OR (state = 'claimed' AND claim_expires_at <= ?))
         RETURNING *`,
      )
      .get(input.owner, input.now + input.leaseMs, input.now, input.deliveryId, input.now);
    if (row === null) return null;
    db.run(
      `UPDATE improvement_delivery_attempt SET outcome = 'expired', settled_at = ?
       WHERE delivery_id = ? AND outcome = 'claimed'`,
      [input.now, row.id],
    );
    db.run(
      `INSERT INTO improvement_delivery_attempt (delivery_id, attempt, owner, claimed_at,
         claim_expires_at) VALUES (?, ?, ?, ?, ?)`,
      [row.id, row.attempts, input.owner, input.now, input.now + input.leaseMs],
    );
    return deliveryFromRow(row);
  });
}

export function settleImprovementDelivery(
  db: Database,
  input: {
    deliveryId: string;
    attempt: number;
    owner: string;
    outcome: "succeeded" | "failed" | "unknown";
    remote?: { id: string; identifier?: string; url?: string };
    error?: string;
    now: number;
  },
): boolean {
  return immediate(db, () => {
    if (input.outcome === "succeeded" && input.remote === undefined)
      throw new Error("A succeeded delivery needs its remote record");
    const error = input.outcome === "succeeded" ? null : (input.error ?? null);
    const row = db
      .query<
        DeliveryRow,
        [
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          number,
          string,
          string,
          number,
        ]
      >(
        `UPDATE improvement_delivery SET state = ?, remote_id = coalesce(?, remote_id),
           remote_identifier = coalesce(?, remote_identifier), remote_url = coalesce(?, remote_url),
           error = ?, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'claimed' AND claim_owner = ? AND attempts = ?
         RETURNING *`,
      )
      .get(
        input.outcome,
        input.remote?.id ?? null,
        input.remote?.identifier ?? null,
        input.remote?.url ?? null,
        error,
        input.now,
        input.deliveryId,
        input.owner,
        input.attempt,
      );
    if (row === null) return false;
    db.run(
      `UPDATE improvement_delivery_attempt SET outcome = ?, remote_id = ?, remote_identifier = ?,
         remote_url = ?, error = ?, settled_at = ?
       WHERE delivery_id = ? AND attempt = ? AND outcome = 'claimed'`,
      [
        input.outcome,
        input.remote?.id ?? null,
        input.remote?.identifier ?? null,
        input.remote?.url ?? null,
        error,
        input.now,
        input.deliveryId,
        input.attempt,
      ],
    );
    if (input.outcome === "succeeded" && row.operation !== "evidence_comment")
      db.run(
        `UPDATE improvement SET issue_id = ?, issue_identifier = ?, issue_url = ?,
           issue_confirmed_at = ? WHERE id = ? AND issue_id IS NULL`,
        [
          row.operation === "link_issue" ? row.target_issue_id : row.remote_id,
          row.remote_identifier,
          row.remote_url,
          input.now,
          row.improvement_id,
        ],
      );
    return true;
  });
}

export type ImprovementDeliveryAttempt = {
  attempt: number;
  owner: string;
  claimedAt: number;
  claimExpiresAt: number;
  outcome: "claimed" | "succeeded" | "failed" | "unknown" | "expired";
  remoteId: string | null;
  remoteIdentifier: string | null;
  remoteUrl: string | null;
  error: string | null;
  settledAt: number | null;
};

export function listImprovementDeliveryAttempts(
  db: Database,
  deliveryId: string,
): ImprovementDeliveryAttempt[] {
  return db
    .query<ImprovementDeliveryAttempt, [string]>(
      `SELECT attempt, owner, claimed_at AS claimedAt, claim_expires_at AS claimExpiresAt, outcome,
         remote_id AS remoteId, remote_identifier AS remoteIdentifier, remote_url AS remoteUrl,
         error, settled_at AS settledAt
       FROM improvement_delivery_attempt WHERE delivery_id = ? ORDER BY attempt`,
    )
    .all(deliveryId);
}

export function recordImprovementOutcome(
  db: Database,
  input: ImprovementOutcome & {
    improvementId: string;
    evidence: string[];
    revision?: string;
    deployment?: string;
    actor: string;
    now: number;
  },
): ImprovementOutcomeRecord {
  if (input.track === "verification" && input.state === "verified" && input.evidence.length === 0)
    throw new Error("Verified needs evidence for the stated criterion");
  return immediate(db, () => {
    const id = db
      .query<
        { id: number },
        [string, string, string, string, string | null, string | null, string, number]
      >(
        `INSERT INTO improvement_outcome (improvement_id, track, state, evidence, revision,
           deployment, actor, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.improvementId,
        input.track,
        input.state,
        JSON.stringify(input.evidence),
        input.revision ?? null,
        input.deployment ?? null,
        input.actor,
        input.now,
      )!.id;
    const changed =
      input.track === "implementation"
        ? db.run(
            "UPDATE improvement SET implementation_state = ?, implementation_at = ? WHERE id = ?",
            [input.state, input.now, input.improvementId],
          ).changes
        : db.run(
            "UPDATE improvement SET verification_state = ?, verification_at = ? WHERE id = ?",
            [input.state, input.now, input.improvementId],
          ).changes;
    if (changed !== 1) throw new Error(`Unknown improvement ${input.improvementId}`);
    return {
      id,
      improvementId: input.improvementId,
      ...({ track: input.track, state: input.state } as ImprovementOutcome),
      evidence: input.evidence,
      revision: input.revision ?? null,
      deployment: input.deployment ?? null,
      actor: input.actor,
      recordedAt: input.now,
    };
  });
}

export function listImprovementOutcomes(
  db: Database,
  improvementId: string,
): ImprovementOutcomeRecord[] {
  return db
    .query<
      {
        id: number;
        improvement_id: string;
        track: "implementation" | "verification";
        state: string;
        evidence: string;
        revision: string | null;
        deployment: string | null;
        actor: string;
        recorded_at: number;
      },
      [string]
    >("SELECT * FROM improvement_outcome WHERE improvement_id = ? ORDER BY id")
    .all(improvementId)
    .map(
      (row) =>
        ({
          id: row.id,
          improvementId: row.improvement_id,
          track: row.track,
          state: row.state,
          evidence: JSON.parse(row.evidence) as string[],
          revision: row.revision,
          deployment: row.deployment,
          actor: row.actor,
          recordedAt: row.recorded_at,
        }) as ImprovementOutcomeRecord,
    );
}
