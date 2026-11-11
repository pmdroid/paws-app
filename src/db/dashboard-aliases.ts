import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";

type DashboardAliasKind = "runs" | "sessions" | "verdicts";

export function* resolveDashboardAliasSteps(
  q: Q,
  kind: DashboardAliasKind,
  id: string,
  sessionIds?: readonly string[],
) {
  const { run, workItem } = q.t;
  const publicId = sql<string>`CASE WHEN coalesce(trim(${workItem.linearIdentifier}), '') = '' THEN ${workItem.id} ELSE trim(${workItem.linearIdentifier}) END`;
  const visible =
    sessionIds === undefined ? undefined : inArray(workItem.sessionKey, [...sessionIds]);
  function* runAlias() {
    const row = yield* q.one(
      q.orm
        .select({ publicId })
        .from(run)
        .innerJoin(workItem, eq(workItem.id, run.itemId))
        .where(and(visible, eq(run.id, id))),
    );
    return row?.publicId ?? null;
  }
  switch (kind) {
    case "runs":
      return yield* runAlias();
    case "sessions": {
      const row = yield* q.one(
        q.orm
          .select({ publicId })
          .from(workItem)
          .where(and(visible, eq(workItem.sessionKey, id)))
          .orderBy(asc(workItem.createdAt), asc(workItem.id))
          .limit(1),
      );
      return row?.publicId ?? null;
    }
    case "verdicts": {
      const row = yield* q.one(
        q.orm
          .select({ publicId })
          .from(workItem)
          .where(and(visible, eq(publicId, id)))
          .limit(1),
      );
      return row?.publicId ?? (yield* runAlias());
    }
  }
}

export async function resolveDashboardAlias(
  store: Db,
  kind: DashboardAliasKind,
  id: string,
  sessionIds?: readonly string[],
): Promise<string | null> {
  return store.run((q) => resolveDashboardAliasSteps(q, kind, id, sessionIds));
}
