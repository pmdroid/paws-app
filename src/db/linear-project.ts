import type { Database } from "bun:sqlite";
import { eq, sql, type SQL } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

/** The Linear project an issue belongs to. A null name means the read did not include it. */
export type WorkItemLinearProject = { id: string; name: string | null };

function projectSet(project: WorkItemLinearProject | null) {
  const id = project?.id.trim() || null;
  const name = id === null ? null : project?.name?.trim() || null;
  const sameProject = id === null ? sql`linear_project_id IS NULL` : sql`linear_project_id = ${id}`;
  // A missing name keeps the stored one only while the project id stays the same.
  const linearProjectName: string | SQL =
    name ?? sql`CASE WHEN ${sameProject} THEN linear_project_name ELSE NULL END`;
  return { linearProjectId: id, linearProjectName };
}

export function* getWorkItemLinearProjectIdSteps(q: Q, itemId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm.select({ id: workItem.linearProjectId }).from(workItem).where(eq(workItem.id, itemId)),
  );
  return row?.id ?? null;
}

/** The item's Linear project id, or null when the issue has none or Paws has not read it. */
export function getWorkItemLinearProjectId(db: Database, itemId: string): string | null {
  return settled(sqliteDb(db).run((q) => getWorkItemLinearProjectIdSteps(q, itemId)));
}

export function* saveWorkItemLinearProjectSteps(
  q: Q,
  itemId: string,
  project: WorkItemLinearProject | null,
) {
  const { workItem } = q.t;
  yield* q.exec(q.orm.update(workItem).set(projectSet(project)).where(eq(workItem.id, itemId)));
}

/** Records the item's Linear project from the issue snapshot Paws already read. */
export function saveWorkItemLinearProject(
  db: Database,
  itemId: string,
  project: WorkItemLinearProject | null,
): void {
  settled(sqliteDb(db).run((q) => saveWorkItemLinearProjectSteps(q, itemId, project)));
}

export function* applyLinearIssueProjectSteps(
  q: Q,
  linearIssueId: string,
  project: WorkItemLinearProject | null,
) {
  const { workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(workItem)
      .set(projectSet(project))
      .where(eq(workItem.linearIssueId, linearIssueId))
      .returning({ id: workItem.id }),
  );
  return rows.length;
}

/** Moves every item for a Linear issue to the project an issue webhook reported. */
export function applyLinearIssueProject(
  db: Database,
  linearIssueId: string,
  project: WorkItemLinearProject | null,
): number {
  return settled(sqliteDb(db).run((q) => applyLinearIssueProjectSteps(q, linearIssueId, project)));
}
