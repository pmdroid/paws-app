import { and, eq, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";

export type TaskLinearReadKind = "project_overview" | "repository_hints" | "repository_suggestions";

export function* keepTaskLinearReadSteps(
  q: Q,
  itemId: string,
  kind: TaskLinearReadKind,
  value: unknown,
  now: number,
) {
  const { workItemLinearRead } = q.t;
  const text = JSON.stringify(value);
  const valueJson = q.dialect === "sqlite" ? text : sql`${text}::jsonb`;
  yield* q.exec(
    q.orm
      .insert(workItemLinearRead)
      .values({ itemId, kind, valueJson, readAt: now })
      .onConflictDoUpdate({
        target: [workItemLinearRead.itemId, workItemLinearRead.kind],
        set: { valueJson, readAt: now },
      }),
  );
}

export async function keepTaskLinearRead(
  store: Db,
  itemId: string,
  kind: TaskLinearReadKind,
  value: unknown,
  now: number,
): Promise<void> {
  await store.run((q) => keepTaskLinearReadSteps(q, itemId, kind, value, now));
}

export function* getTaskLinearReadSteps(q: Q, itemId: string, kind: TaskLinearReadKind) {
  const { workItemLinearRead } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ valueJson: workItemLinearRead.valueJson })
      .from(workItemLinearRead)
      .where(and(eq(workItemLinearRead.itemId, itemId), eq(workItemLinearRead.kind, kind))),
  );
  if (row === undefined) return undefined;
  return q.dialect === "sqlite" ? (JSON.parse(row.valueJson as string) as unknown) : row.valueJson;
}

export function* linearActivitiesListedAtSteps(q: Q, sessionId: string) {
  const { linearActivityListing } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ generation: linearActivityListing.generation })
      .from(linearActivityListing)
      .where(eq(linearActivityListing.sessionId, sessionId)),
  );
  return row?.generation ?? null;
}

export async function linearActivitiesListedAt(
  store: Db,
  sessionId: string,
): Promise<number | null> {
  return store.run((q) => linearActivitiesListedAtSteps(q, sessionId));
}

export function* markLinearActivitiesListedSteps(q: Q, sessionId: string, generation: number) {
  const { linearActivityListing } = q.t;
  yield* q.exec(
    q.orm
      .insert(linearActivityListing)
      .values({ sessionId, generation })
      .onConflictDoUpdate({ target: linearActivityListing.sessionId, set: { generation } }),
  );
}

export async function markLinearActivitiesListed(
  store: Db,
  sessionId: string,
  generation: number,
): Promise<void> {
  await store.run((q) => markLinearActivitiesListedSteps(q, sessionId, generation));
}
