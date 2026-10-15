import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { immediate } from "./tx";

export type ProjectRunSource = "project" | "parent";

export type TaskBlock = {
  blockerLinearIssueId: string;
  blockedLinearIssueId: string;
};

export type ProjectRun = {
  id: string;
  source: ProjectRunSource;
  linearId: string;
  createdAt: number;
};

export function createProjectRun(
  db: Database,
  input: { source: ProjectRunSource; linearId: string; now: number },
): string {
  const id = randomUUID();
  db.run("INSERT INTO project_run(id,source,linear_id,created_at) VALUES(?,?,?,?)", [
    id,
    input.source,
    input.linearId,
    input.now,
  ]);
  return id;
}

export function getProjectRun(db: Database, id: string): ProjectRun | null {
  return (
    db
      .query<ProjectRun, [string]>(
        "SELECT id,source,linear_id AS linearId,created_at AS createdAt FROM project_run WHERE id=?",
      )
      .get(id) ?? null
  );
}

export function saveTaskBlocks(
  db: Database,
  blockedLinearIssueIds: readonly string[],
  edges: readonly TaskBlock[],
): void {
  const blocked = new Set(blockedLinearIssueIds);
  if (edges.some((edge) => !blocked.has(edge.blockedLinearIssueId)))
    throw new Error("A task block names an issue outside the saved set");
  immediate(db, () => {
    for (const id of blocked)
      db.run("DELETE FROM task_block WHERE blocked_linear_issue_id=?", [id]);
    for (const edge of edges)
      db.run(
        "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?) ON CONFLICT DO NOTHING",
        [edge.blockerLinearIssueId, edge.blockedLinearIssueId],
      );
  });
}

export function listTaskBlockers(db: Database, blockedLinearIssueId: string): string[] {
  return db
    .query<{ id: string }, [string]>(
      "SELECT blocker_linear_issue_id AS id FROM task_block WHERE blocked_linear_issue_id=? ORDER BY id",
    )
    .all(blockedLinearIssueId)
    .map((row) => row.id);
}
