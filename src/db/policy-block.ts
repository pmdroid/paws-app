import type { Database } from "bun:sqlite";

export type PolicyBlock = {
  questionId: string;
  itemId: string;
  repository: string;
  cause: "policy_unreadable";
  error: string;
  policyPath: string;
  main: string;
  changedBy: string | null;
  createdAt: number;
};

type Row = {
  question_id: string;
  item_id: string;
  repository: string;
  cause: "policy_unreadable";
  error: string;
  policy_path: string;
  main_sha: string;
  changed_by_sha: string | null;
  created_at: number;
};

const map = (row: Row): PolicyBlock => ({
  questionId: row.question_id,
  itemId: row.item_id,
  repository: row.repository,
  cause: row.cause,
  error: row.error,
  policyPath: row.policy_path,
  main: row.main_sha,
  changedBy: row.changed_by_sha,
  createdAt: row.created_at,
});

export function savePolicyBlock(db: Database, block: PolicyBlock): void {
  db.run(
    `INSERT OR REPLACE INTO closeout_policy_block
       (question_id, item_id, repository, cause, error, policy_path, main_sha, changed_by_sha, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      block.questionId,
      block.itemId,
      block.repository,
      block.cause,
      block.error,
      block.policyPath,
      block.main,
      block.changedBy,
      block.createdAt,
    ],
  );
}

export function listOpenPolicyBlocks(db: Database, repository?: string): PolicyBlock[] {
  return db
    .query<Row, [string | null]>(
      `SELECT b.* FROM closeout_policy_block b JOIN question q ON q.id = b.question_id
       WHERE q.status = 'open' AND q.cancelled_at IS NULL AND (?1 IS NULL OR b.repository = ?1)
       ORDER BY b.created_at, b.rowid`,
    )
    .all(repository ?? null)
    .map(map);
}
