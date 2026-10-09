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
  epic_id: string;
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
  const rows =
    epicId === undefined
      ? db
          .query<BlockSql, []>(
            `SELECT epic_id, blocker_linear_issue_id, blocked_linear_issue_id
             FROM work_item_block
             ORDER BY epic_id, blocked_linear_issue_id, blocker_linear_issue_id`,
          )
          .all()
      : db
          .query<BlockSql, [string]>(
            `SELECT epic_id, blocker_linear_issue_id, blocked_linear_issue_id
             FROM work_item_block
             WHERE epic_id = ?
             ORDER BY blocked_linear_issue_id, blocker_linear_issue_id`,
          )
          .all(epicId);
  return rows.map((row) => ({
    epicId: row.epic_id,
    blockerLinearIssueId: row.blocker_linear_issue_id,
    blockedLinearIssueId: row.blocked_linear_issue_id,
  }));
}

/** Unanswered questions, oldest first. */
export function listOpenQuestions(db: Database): OpenQuestionRecord[] {
  return db
    .query<QuestionSql, []>(
      `SELECT id, item_id, run_id, session_id, body, options, created_at
       FROM question
       WHERE status = 'open'
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
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}
