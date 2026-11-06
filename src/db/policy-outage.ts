import type { Database } from "bun:sqlite";

export type PolicyOutage = {
  repository: string;
  startedAt: number;
  error: string;
  policyPath: string;
  main: string;
  changedBy: string | null;
  questionId: string | null;
  questionItemId: string | null;
};

type Row = {
  repository: string;
  started_at: number;
  error: string;
  policy_path: string;
  main_sha: string;
  changed_by_sha: string | null;
  question_id: string | null;
  question_item_id: string | null;
};

const map = (row: Row): PolicyOutage => ({
  repository: row.repository,
  startedAt: row.started_at,
  error: row.error,
  policyPath: row.policy_path,
  main: row.main_sha,
  changedBy: row.changed_by_sha,
  questionId: row.question_id,
  questionItemId: row.question_item_id,
});

export function getPolicyOutage(db: Database, repository: string): PolicyOutage | null {
  const row = db
    .query<Row, [string]>("SELECT * FROM closeout_policy_outage WHERE repository = ?")
    .get(repository);
  return row ? map(row) : null;
}

export function listPolicyOutages(db: Database): PolicyOutage[] {
  return db
    .query<Row, []>("SELECT * FROM closeout_policy_outage ORDER BY started_at, repository")
    .all()
    .map(map);
}

export function recordPolicyOutage(
  db: Database,
  input: {
    repository: string;
    error: string;
    policyPath: string;
    main: string;
    changedBy: string | null;
    now: number;
  },
): PolicyOutage {
  const current = getPolicyOutage(db, input.repository);
  if (current && current.error === input.error && current.changedBy === input.changedBy) {
    db.run("UPDATE closeout_policy_outage SET main_sha = ? WHERE repository = ?", [
      input.main,
      input.repository,
    ]);
  } else {
    db.run(
      `INSERT OR REPLACE INTO closeout_policy_outage
         (repository, started_at, error, policy_path, main_sha, changed_by_sha)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.repository, input.now, input.error, input.policyPath, input.main, input.changedBy],
    );
  }
  return getPolicyOutage(db, input.repository)!;
}

export function setPolicyOutageQuestion(
  db: Database,
  repository: string,
  question: { id: string; itemId: string } | null,
): void {
  db.run(
    "UPDATE closeout_policy_outage SET question_id = ?, question_item_id = ? WHERE repository = ?",
    [question?.id ?? null, question?.itemId ?? null, repository],
  );
}

export function endPolicyOutage(db: Database, repository: string): PolicyOutage | null {
  const current = getPolicyOutage(db, repository);
  if (current) db.run("DELETE FROM closeout_policy_outage WHERE repository = ?", [repository]);
  return current;
}
