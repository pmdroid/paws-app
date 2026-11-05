import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

export type ImprovementIssueSyncStatus = "available" | "missing" | "unauthorized" | "unavailable";

export type ImprovementIssueSync = {
  improvementId: string;
  issueId: string;
  status: ImprovementIssueSyncStatus;
  stateType: string | null;
  teamId: string | null;
  delegated: boolean | null;
  observedAt: number;
  confirmedAt: number | null;
};

type SyncRow = {
  improvement_id: string;
  issue_id: string;
  status: ImprovementIssueSyncStatus;
  state_type: string | null;
  team_id: string | null;
  delegated: number | null;
  observed_at: number;
  confirmed_at: number | null;
};

const syncFromRow = (row: SyncRow): ImprovementIssueSync => ({
  improvementId: row.improvement_id,
  issueId: row.issue_id,
  status: row.status,
  stateType: row.state_type,
  teamId: row.team_id,
  delegated: row.delegated === null ? null : row.delegated === 1,
  observedAt: row.observed_at,
  confirmedAt: row.confirmed_at,
});

export function improvementIssueSync(
  db: Database,
  improvementId: string,
): ImprovementIssueSync | null {
  const row = db
    .query<SyncRow, [string]>("SELECT * FROM improvement_issue_sync WHERE improvement_id = ?")
    .get(improvementId);
  return row ? syncFromRow(row) : null;
}

export function recordImprovementIssueSync(
  db: Database,
  input: {
    improvementId: string;
    issueId: string;
    status: ImprovementIssueSyncStatus;
    stateType?: string;
    teamId?: string;
    delegated?: boolean;
    observedAt: number;
  },
): boolean {
  const available = input.status === "available";
  return (
    db.run(
      `INSERT INTO improvement_issue_sync (improvement_id, issue_id, status, state_type, team_id,
         delegated, observed_at, confirmed_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE EXISTS (SELECT 1 FROM improvement WHERE id = ?1 AND issue_id = ?2)
       ON CONFLICT(improvement_id) DO UPDATE SET status = excluded.status,
         issue_id = excluded.issue_id,
         state_type = CASE WHEN excluded.status = 'available' THEN excluded.state_type ELSE state_type END,
         team_id = coalesce(excluded.team_id, team_id),
         delegated = CASE WHEN excluded.status = 'available' THEN excluded.delegated ELSE delegated END,
         observed_at = excluded.observed_at,
         confirmed_at = coalesce(excluded.confirmed_at, confirmed_at)
       WHERE excluded.observed_at > improvement_issue_sync.observed_at
         OR improvement_issue_sync.issue_id <> excluded.issue_id`,
      [
        input.improvementId,
        input.issueId,
        input.status,
        available ? (input.stateType ?? null) : null,
        input.teamId ?? null,
        available && input.delegated !== undefined ? (input.delegated ? 1 : 0) : null,
        input.observedAt,
        available ? input.observedAt : null,
      ],
    ).changes === 1
  );
}

export function followThroughCandidates(
  db: Database,
  limit: number,
): { id: string; workspaceId: string; issueId: string }[] {
  return db
    .query<{ id: string; workspaceId: string; issueId: string }, [number]>(
      `SELECT i.id, i.workspace_id AS workspaceId, i.issue_id AS issueId FROM improvement i
       LEFT JOIN improvement_issue_sync s ON s.improvement_id = i.id
       WHERE i.review_state = 'accepted' AND i.issue_id IS NOT NULL
       ORDER BY coalesce(s.observed_at, 0), i.id LIMIT ?`,
    )
    .all(limit);
}

export type ImprovementDelegationState = "requested" | "started" | "existing" | "failed";

export type ImprovementDelegation = {
  improvementId: string;
  issueId: string;
  state: ImprovementDelegationState;
  sessionId: string | null;
  error: string | null;
  attempts: number;
  leaseExpiresAt: number | null;
  actor: string;
  requestedAt: number;
  updatedAt: number;
};

type DelegationRow = {
  improvement_id: string;
  issue_id: string;
  state: ImprovementDelegationState;
  session_id: string | null;
  error: string | null;
  attempts: number;
  lease_expires_at: number | null;
  actor: string;
  requested_at: number;
  updated_at: number;
};

const delegationFromRow = (row: DelegationRow): ImprovementDelegation => ({
  improvementId: row.improvement_id,
  issueId: row.issue_id,
  state: row.state,
  sessionId: row.session_id,
  error: row.error,
  attempts: row.attempts,
  leaseExpiresAt: row.lease_expires_at,
  actor: row.actor,
  requestedAt: row.requested_at,
  updatedAt: row.updated_at,
});

export function improvementDelegation(
  db: Database,
  improvementId: string,
): ImprovementDelegation | null {
  const row = db
    .query<DelegationRow, [string]>("SELECT * FROM improvement_delegation WHERE improvement_id = ?")
    .get(improvementId);
  return row ? delegationFromRow(row) : null;
}

export function claimImprovementDelegation(
  db: Database,
  input: {
    improvementId: string;
    issueId: string;
    actor: string;
    now: number;
    leaseMs: number;
    again?: boolean;
  },
): ImprovementDelegation | null {
  const row = db
    .query<DelegationRow, [string, string, string, number, number, number]>(
      `INSERT INTO improvement_delegation (improvement_id, issue_id, state, attempts,
         lease_expires_at, actor, requested_at, updated_at)
       VALUES (?1, ?2, 'requested', 1, ?4 + ?5, ?3, ?4, ?4)
       ON CONFLICT(improvement_id) DO UPDATE SET state = 'requested', issue_id = excluded.issue_id,
         attempts = attempts + 1, lease_expires_at = excluded.lease_expires_at, error = NULL,
         actor = excluded.actor, updated_at = excluded.updated_at
       WHERE improvement_delegation.state = 'failed'
         OR (improvement_delegation.state = 'requested' AND improvement_delegation.lease_expires_at <= ?4)
         OR (?6 = 1 AND improvement_delegation.state IN ('started','existing'))
       RETURNING *`,
    )
    .get(
      input.improvementId,
      input.issueId,
      input.actor,
      input.now,
      input.leaseMs,
      input.again ? 1 : 0,
    );
  return row ? delegationFromRow(row) : null;
}

export function settleImprovementDelegation(
  db: Database,
  input: {
    improvementId: string;
    attempts: number;
    state: Exclude<ImprovementDelegationState, "requested">;
    sessionId?: string;
    error?: string;
    now: number;
  },
): boolean {
  return (
    db.run(
      `UPDATE improvement_delegation SET state = ?, session_id = coalesce(?, session_id), error = ?,
         lease_expires_at = NULL, updated_at = ?
       WHERE improvement_id = ? AND state = 'requested' AND attempts = ?`,
      [
        input.state,
        input.sessionId ?? null,
        input.error ?? null,
        input.now,
        input.improvementId,
        input.attempts,
      ],
    ).changes === 1
  );
}

export function otherDelegationForIssue(
  db: Database,
  input: { improvementId: string; issueId: string; now: number },
): ImprovementDelegation | null {
  const row = db
    .query<DelegationRow, [string, string, number]>(
      `SELECT * FROM improvement_delegation WHERE issue_id = ? AND improvement_id <> ?
         AND (state IN ('started','existing') OR (state = 'requested' AND lease_expires_at > ?))
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(input.issueId, input.improvementId, input.now);
  return row ? delegationFromRow(row) : null;
}

export function bumpImprovementVersion(db: Database, improvementId: string): void {
  db.run("UPDATE improvement SET version = version + 1 WHERE id = ?", [improvementId]);
}

export function expiredImprovementDelegations(db: Database, now: number): ImprovementDelegation[] {
  return db
    .query<DelegationRow, [number]>(
      "SELECT * FROM improvement_delegation WHERE state = 'requested' AND lease_expires_at <= ?",
    )
    .all(now)
    .map(delegationFromRow);
}

export type ImprovementActionKind =
  | "delegate"
  | "verify"
  | "contradict"
  | "criterion"
  | "acknowledge"
  | "redelegate"
  | "return_to_review"
  | "follow_work";

export type ImprovementAction = {
  id: number;
  improvementId: string;
  action: ImprovementActionKind;
  version: number;
  prior: Record<string, unknown>;
  detail: Record<string, unknown>;
  actor: string;
  at: number;
};

export function recordImprovementAction(
  db: Database,
  input: {
    improvementId: string;
    expectedVersion: number;
    action: ImprovementActionKind;
    prior: Record<string, unknown>;
    detail: Record<string, unknown>;
    actor: string;
    now: number;
  },
): number | null {
  return immediate(db, () => {
    const version = input.expectedVersion + 1;
    if (
      db.run("UPDATE improvement SET version = ? WHERE id = ? AND version = ?", [
        version,
        input.improvementId,
        input.expectedVersion,
      ]).changes !== 1
    )
      return null;
    db.run(
      `INSERT INTO improvement_action (improvement_id, action, version, prior, detail, actor, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.improvementId,
        input.action,
        version,
        JSON.stringify(input.prior),
        JSON.stringify(input.detail),
        input.actor,
        input.now,
      ],
    );
    return version;
  });
}

export function listImprovementActions(db: Database, improvementId: string): ImprovementAction[] {
  return db
    .query<
      {
        id: number;
        improvement_id: string;
        action: ImprovementActionKind;
        version: number;
        prior: string;
        detail: string;
        actor: string;
        at: number;
      },
      [string]
    >("SELECT * FROM improvement_action WHERE improvement_id = ? ORDER BY id")
    .all(improvementId)
    .map((row) => ({
      id: row.id,
      improvementId: row.improvement_id,
      action: row.action,
      version: row.version,
      prior: JSON.parse(row.prior) as Record<string, unknown>,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
      actor: row.actor,
      at: row.at,
    }));
}

export function annotateImprovementCriterion(
  db: Database,
  input: {
    improvementId: string;
    proposalVersion: number;
    criterion: string;
    actor: string;
    now: number;
  },
): void {
  db.run(
    `INSERT INTO improvement_criterion (improvement_id, revision, proposal_version, criterion,
       actor, at) VALUES (?1, (SELECT coalesce(max(revision), 0) + 1 FROM improvement_criterion
       WHERE improvement_id = ?1), ?2, ?3, ?4, ?5)`,
    [input.improvementId, input.proposalVersion, input.criterion, input.actor, input.now],
  );
}

export function returnImprovementToReview(
  db: Database,
  input: { improvementId: string; version: number; actor: string; now: number },
): void {
  immediate(db, () => {
    db.run(
      `DELETE FROM improvement_delivery_attempt WHERE delivery_id IN
         (SELECT id FROM improvement_delivery WHERE improvement_id = ?)`,
      [input.improvementId],
    );
    db.run("DELETE FROM improvement_delivery WHERE improvement_id = ?", [input.improvementId]);
    db.run("DELETE FROM improvement_issue_sync WHERE improvement_id = ?", [input.improvementId]);
    db.run("DELETE FROM improvement_delegation WHERE improvement_id = ?", [input.improvementId]);
    db.run("DELETE FROM improvement_work WHERE improvement_id = ?", [input.improvementId]);
    db.run(
      `UPDATE improvement SET review_state = 'needs_review', reviewed_proposal = NULL,
         reviewed_by = ?, reviewed_at = ?, review_reason = NULL, intent = NULL,
         intent_issue_id = NULL, evidence_comment = 0, issue_id = NULL, issue_identifier = NULL,
         issue_url = NULL, issue_confirmed_at = NULL, implementation_state = 'unknown',
         implementation_at = ?, verification_state = 'unknown', verification_at = ?
       WHERE id = ? AND version = ?`,
      [input.actor, input.now, input.now, input.now, input.improvementId, input.version],
    );
    db.run(
      `INSERT INTO improvement_decision (improvement_id, version, review_state, evidence_comment,
         actor, at) VALUES (?, ?, 'needs_review', 0, ?, ?)`,
      [input.improvementId, input.version, input.actor, input.now],
    );
  });
}

export type IssueWork = {
  itemId: string;
  state: string;
  identifier: string;
  repository: string | null;
  createdAt: number;
  updatedAt: number;
  acceptedHead: string | null;
  pull: { number: number; url: string | null; openedAt: number } | null;
  merge: { number: number; url: string | null; sha: string | null; confirmedAt: number } | null;
};

type WorkRow = {
  id: string;
  state: string;
  linear_identifier: string;
  created_at: number;
  accepted_head: string | null;
  owner: string | null;
  repo: string | null;
  updated_at: number | null;
  pull_number: number | null;
  pull_url: string | null;
  opened_at: number | null;
  merge_number: number | null;
  merge_url: string | null;
  merge_sha: string | null;
  confirmed_at: number | null;
};

const WORK_SELECT = `SELECT w.id, w.state, w.linear_identifier, w.created_at, w.accepted_head,
    r.owner, r.repo, (SELECT max(at) FROM work_item_event e WHERE e.item_id = w.id) AS updated_at,
    p.pull_number, p.pull_url, p.opened_at, m.pull_number AS merge_number,
    m.pull_url AS merge_url, m.merge_sha, m.confirmed_at
  FROM work_item w
  LEFT JOIN work_item_repository r ON r.item_id = w.id
  LEFT JOIN item_pull_request p ON p.item_id = w.id
  LEFT JOIN remote_merge_fact m ON m.item_id = w.id`;

const IN_REPOSITORY = "(r.item_id IS NULL OR r.owner || '/' || r.repo = ?)";

const workFromRow = (row: WorkRow): IssueWork => ({
  itemId: row.id,
  state: row.state,
  identifier: row.linear_identifier,
  repository: row.owner && row.repo ? `${row.owner}/${row.repo}` : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at ?? row.created_at,
  acceptedHead: row.accepted_head,
  pull:
    row.pull_number === null
      ? null
      : { number: row.pull_number, url: row.pull_url, openedAt: row.opened_at ?? 0 },
  merge:
    row.merge_number === null
      ? null
      : {
          number: row.merge_number,
          url: row.merge_url,
          sha: row.merge_sha,
          confirmedAt: row.confirmed_at ?? 0,
        },
});

export type ImprovementWorkBinding = { issueId: string; itemId: string; boundAt: number };

export function improvementWorkBinding(
  db: Database,
  improvementId: string,
): ImprovementWorkBinding | null {
  return db
    .query<ImprovementWorkBinding, [string]>(
      `SELECT issue_id AS issueId, item_id AS itemId, bound_at AS boundAt FROM improvement_work
       WHERE improvement_id = ?`,
    )
    .get(improvementId);
}

export function boundImprovementWork(
  db: Database,
  improvement: { id: string; issueId: string; repository: string },
): IssueWork | null {
  const row = db
    .query<WorkRow, [string, string, string]>(
      `${WORK_SELECT} JOIN improvement_work b ON b.item_id = w.id
       WHERE b.improvement_id = ? AND b.issue_id = ? AND w.linear_issue_id = b.issue_id
         AND ${IN_REPOSITORY}`,
    )
    .get(improvement.id, improvement.issueId, improvement.repository);
  return row ? workFromRow(row) : null;
}

export function newestIssueWork(
  db: Database,
  input: {
    issueId: string;
    repository: string;
    createdSince: number;
    linkedAt: number;
    exceptItemId?: string;
  },
): IssueWork | null {
  const row = db
    .query<WorkRow, [string, string, number, number, string]>(
      `${WORK_SELECT} WHERE w.linear_issue_id = ? AND ${IN_REPOSITORY} AND w.created_at >= ?
         AND (w.created_at >= ? OR w.state NOT IN ('completed','merged','cancelled','failed'))
         AND w.id <> ? ORDER BY w.created_at DESC, w.rowid DESC LIMIT 1`,
    )
    .get(
      input.issueId,
      input.repository,
      input.createdSince,
      input.linkedAt,
      input.exceptItemId ?? "",
    );
  return row ? workFromRow(row) : null;
}

export function bindImprovementWork(
  db: Database,
  input: {
    improvementId: string;
    issueId: string;
    itemId: string;
    expectedItemId: string | null;
    now: number;
  },
): boolean {
  return (
    db.run(
      `INSERT INTO improvement_work (improvement_id, issue_id, item_id, bound_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM improvement WHERE id = ?1 AND issue_id = ?2)
         AND (?5 IS NULL OR EXISTS (SELECT 1 FROM improvement_work WHERE improvement_id = ?1))
       ON CONFLICT(improvement_id) DO UPDATE SET issue_id = excluded.issue_id,
         item_id = excluded.item_id, bound_at = excluded.bound_at
       WHERE improvement_work.item_id = ?5`,
      [input.improvementId, input.issueId, input.itemId, input.now, input.expectedItemId],
    ).changes === 1
  );
}

export type CloseoutStepResult = {
  progressId: string;
  stepId: string;
  itemId: string;
  head: string;
  kind: string;
  state: string;
  command: string;
  finishedAt: number | null;
};

export function closeoutStepResult(
  db: Database,
  progressId: string,
  stepId: string,
): CloseoutStepResult | null {
  return db
    .query<CloseoutStepResult, [string, string]>(
      `SELECT s.progress_id AS progressId, s.step_id AS stepId, p.item_id AS itemId, p.head,
         s.kind, s.state, s.command, s.finished_at AS finishedAt
       FROM closeout_step s JOIN closeout_progress p ON p.id = s.progress_id
       WHERE s.progress_id = ? AND s.step_id = ?
       ORDER BY s.attempt DESC LIMIT 1`,
    )
    .get(progressId, stepId);
}
