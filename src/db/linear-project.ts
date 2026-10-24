import type { Database } from "bun:sqlite";

/** The Linear project an issue belongs to. A null name means the read did not include it. */
export type WorkItemLinearProject = { id: string; name: string | null };

// A missing name keeps the stored one only while the project id stays the same.
const SET_PROJECT = `linear_project_id=?1,
  linear_project_name=CASE WHEN ?2 IS NOT NULL THEN ?2
    WHEN linear_project_id IS ?1 THEN linear_project_name ELSE NULL END`;

function values(project: WorkItemLinearProject | null): [string | null, string | null] {
  const id = project?.id.trim() || null;
  const name = id === null ? null : project?.name?.trim() || null;
  return [id, name];
}

/** Records the item's Linear project from the issue snapshot Paws already read. */
export function saveWorkItemLinearProject(
  db: Database,
  itemId: string,
  project: WorkItemLinearProject | null,
): void {
  db.run(`UPDATE work_item SET ${SET_PROJECT} WHERE id=?3`, [...values(project), itemId]);
}

/** Moves every item for a Linear issue to the project an issue webhook reported. */
export function applyLinearIssueProject(
  db: Database,
  linearIssueId: string,
  project: WorkItemLinearProject | null,
): number {
  return db.run(`UPDATE work_item SET ${SET_PROJECT} WHERE linear_issue_id=?3`, [
    ...values(project),
    linearIssueId,
  ]).changes;
}
