import type { Database } from "bun:sqlite";

export type WorkItemBlockRecord = {
  epicId: string;
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
export function listWorkItemBlocks(db: Database, epicId?: string): WorkItemBlockRecord[] {
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
    .all(epicId ?? null, epicId ?? null)
    .map((row) => ({
      epicId: row.delegation_id,
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
              p.id AS project_id,
              json_extract(p.preview, '$.project.name') AS project_name,
              i.created_at AS created_at
       FROM work_item i
       LEFT JOIN workspace_user u ON u.id = i.owner_user_id
       LEFT JOIN project_approval p ON p.id = i.project_approval_id
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
