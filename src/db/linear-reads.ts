import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { orm } from "./orm";
import { linearActivityListing, workItemLinearRead } from "./schema";

export type TaskLinearReadKind = "project_overview" | "repository_hints" | "repository_suggestions";

export function keepTaskLinearRead(
  db: Database,
  itemId: string,
  kind: TaskLinearReadKind,
  value: unknown,
  now: number,
): void {
  const valueJson = JSON.stringify(value);
  orm(db)
    .insert(workItemLinearRead)
    .values({ itemId, kind, valueJson, readAt: now })
    .onConflictDoUpdate({
      target: [workItemLinearRead.itemId, workItemLinearRead.kind],
      set: { valueJson, readAt: now },
    })
    .run();
}

export function getTaskLinearRead(db: Database, itemId: string, kind: TaskLinearReadKind): unknown {
  const row = orm(db)
    .select({ valueJson: workItemLinearRead.valueJson })
    .from(workItemLinearRead)
    .where(and(eq(workItemLinearRead.itemId, itemId), eq(workItemLinearRead.kind, kind)))
    .get();
  return row === undefined ? undefined : JSON.parse(row.valueJson);
}

export function linearActivitiesListedAt(db: Database, sessionId: string): number | null {
  return (
    orm(db)
      .select({ generation: linearActivityListing.generation })
      .from(linearActivityListing)
      .where(eq(linearActivityListing.sessionId, sessionId))
      .get()?.generation ?? null
  );
}

export function markLinearActivitiesListed(
  db: Database,
  sessionId: string,
  generation: number,
): void {
  orm(db)
    .insert(linearActivityListing)
    .values({ sessionId, generation })
    .onConflictDoUpdate({ target: linearActivityListing.sessionId, set: { generation } })
    .run();
}
