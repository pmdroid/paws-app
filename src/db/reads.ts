import type { Database } from "bun:sqlite";

export type WorkItemBlockRecord = {
  delegationId: string;
  blockerLinearIssueId: string;
  blockedLinearIssueId: string;
};

export type OpenQuestionRecord = {
  id: string;
  itemId: string;
  runId: string | null;
  sessionId: string;
  body: string;
  options: string[];
  createdAt: number;
};

type BlockSql = {
  delegation_id: string;
  blocker_linear_issue_id: string;
  blocked_linear_issue_id: string;
};

type QuestionSql = {
  id: string;
  item_id: string;
  run_id: string | null;
  session_id: string;
  body: string;
  options: string | null;
  created_at: number;
};

/** `blocks` edges. Pass `epicId` to read one epic. */
export function listWorkItemBlocks(db: Database, delegationId?: string): WorkItemBlockRecord[] {
  return db
    .query<BlockSql, [string | null, string | null]>(
      `SELECT i.delegation_id, b.blocker_linear_issue_id, b.blocked_linear_issue_id
       FROM task_block b
       JOIN work_item i ON i.id = (
         SELECT candidate.id FROM work_item candidate
         WHERE candidate.linear_issue_id = b.blocked_linear_issue_id
           AND candidate.state <> 'cancelled'
           AND NOT EXISTS (
             SELECT 1 FROM work_item_specification spec
             WHERE spec.item_id = candidate.id AND spec.present = 0
           )
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
       )
       WHERE (? IS NULL OR i.delegation_id = ?)
       ORDER BY i.delegation_id, b.blocked_linear_issue_id, b.blocker_linear_issue_id`,
    )
    .all(delegationId ?? null, delegationId ?? null)
    .map((row) => ({
      delegationId: row.delegation_id,
      blockerLinearIssueId: row.blocker_linear_issue_id,
      blockedLinearIssueId: row.blocked_linear_issue_id,
    }));
}

export type WorkItemFact = {
  itemId: string;
  owner: string | null;
  projectId: string | null;
  projectName: string | null;
  createdAt: number;
};

type FactSql = {
  item_id: string;
  owner: string | null;
  project_id: string | null;
  project_name: string | null;
  created_at: number;
};

export function listWorkItemFacts(db: Database): WorkItemFact[] {
  return db
    .query<FactSql, []>(
      `SELECT i.id AS item_id,
              u.name AS owner,
              i.linear_project_id AS project_id,
              i.linear_project_name AS project_name,
              i.created_at AS created_at
       FROM work_item i
       LEFT JOIN workspace_user u ON u.id = i.owner_user_id
       ORDER BY i.created_at DESC, i.id DESC`,
    )
    .all()
    .map((row) => ({
      itemId: row.item_id,
      owner: row.owner,
      projectId: row.project_id,
      projectName: typeof row.project_name === "string" ? row.project_name : null,
      createdAt: row.created_at,
    }));
}

/** Unanswered questions, oldest first. */
export function listOpenQuestions(db: Database): OpenQuestionRecord[] {
  return db
    .query<QuestionSql, []>(
      `SELECT id, item_id, run_id, session_id, body, options, created_at
       FROM question
       WHERE status = 'open' AND cancelled_at IS NULL
       ORDER BY created_at, id`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      itemId: row.item_id,
      runId: row.run_id,
      sessionId: row.session_id,
      body: row.body,
      options: row.options === null ? [] : stringList(row.options),
      createdAt: row.created_at,
    }));
}

export type DeliveredLinearIssueState = {
  stateType: string | null;
  identifier: string | null;
};

export function deliveredLinearIssueState(
  db: Database,
  organizationId: string,
  issueId: string,
): DeliveredLinearIssueState | null {
  return (
    db
      .query<DeliveredLinearIssueState, [string, string]>(
        `SELECT json_extract(payload,'$.data.state.type') AS stateType,
         json_extract(payload,'$.data.identifier') AS identifier
         FROM inbox_event
         WHERE json_extract(payload,'$.type')='Issue' AND json_extract(payload,'$.data.id')=?
         AND json_extract(payload,'$.organizationId')=?
         ORDER BY updated_at_ms DESC, received_at DESC LIMIT 1`,
      )
      .get(issueId, organizationId) ?? null
  );
}

function stringList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (typeof item !== "object" || item === null) return [];
      const label = item.label ?? item.value;
      return typeof label === "string" ? [label] : [];
    });
  } catch {
    return [];
  }
}
