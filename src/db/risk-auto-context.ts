import type { Database } from "bun:sqlite";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

/** Inputs observed by the lane, never an automatic approval. */
export type RiskAutoContext = {
  autoApproveHighRisk: boolean;
  policyDigest: string | null;
  policyPaths: readonly string[] | null;
  settingsKey?: string;
  policyFiles?: Array<{ path: string; digest: string | null }>;
  /** An earlier human approval whose patch the lane checked against this head. */
  approvedHead?: string;
  approvalKind?: "exact" | "same_patch" | "fix";
};

export function* saveRiskAutoContextSteps(
  q: Q,
  itemId: string,
  head: string,
  context: RiskAutoContext | null,
) {
  const { riskAutoContext } = q.t;
  if (context === null) {
    yield* q.exec(q.orm.delete(riskAutoContext).where(eq(riskAutoContext.itemId, itemId)));
    return;
  }
  yield* q.exec(
    q.orm
      .delete(riskAutoContext)
      .where(and(eq(riskAutoContext.itemId, itemId), ne(riskAutoContext.head, head))),
  );
  yield* q.exec(
    q.orm
      .insert(riskAutoContext)
      .values({ itemId, head, context: JSON.stringify(context) })
      .onConflictDoUpdate({
        target: [riskAutoContext.itemId, riskAutoContext.head],
        set: { context: sql`excluded.context` },
        setWhere: sql`${riskAutoContext.context} != excluded.context`,
      }),
  );
}

/** Keep only the most recently evaluated head; identical polls make no writes. */
export function saveRiskAutoContext(
  db: Database,
  itemId: string,
  head: string,
  context: RiskAutoContext | null,
): void {
  settled(sqliteDb(db).transaction((q) => saveRiskAutoContextSteps(q, itemId, head, context)));
}

/** An item keeps one row, so ordering by `head` only makes the pick deterministic. */
export function* getRiskAutoContextSteps(q: Q, itemId: string) {
  const { riskAutoContext } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ head: riskAutoContext.head, context: riskAutoContext.context })
      .from(riskAutoContext)
      .where(eq(riskAutoContext.itemId, itemId))
      .orderBy(desc(riskAutoContext.head))
      .limit(1),
  );
  if (!row) return null;
  return { head: row.head, context: contextOf(row.context) };
}

export function getRiskAutoContext(
  db: Database,
  itemId: string,
): { head: string; context: RiskAutoContext } | null {
  return settled(sqliteDb(db).run((q) => getRiskAutoContextSteps(q, itemId)));
}

function contextOf(text: string): RiskAutoContext {
  const value = JSON.parse(text) as RiskAutoContext;
  if (
    typeof value.autoApproveHighRisk !== "boolean" ||
    !(value.policyDigest === null || typeof value.policyDigest === "string") ||
    !(
      value.policyPaths === null ||
      (Array.isArray(value.policyPaths) &&
        value.policyPaths.every((path) => typeof path === "string"))
    ) ||
    !(value.settingsKey === undefined || typeof value.settingsKey === "string") ||
    !(value.approvedHead === undefined || typeof value.approvedHead === "string") ||
    !(
      value.approvalKind === undefined ||
      ["exact", "same_patch", "fix"].includes(value.approvalKind)
    ) ||
    !(
      value.policyFiles === undefined ||
      (Array.isArray(value.policyFiles) &&
        value.policyFiles.every(
          (file) =>
            typeof file.path === "string" &&
            (file.digest === null || typeof file.digest === "string"),
        ))
    )
  )
    throw new Error("Invalid stored automatic risk context");
  return value;
}

export function* listRiskAutoContextsSteps(q: Q) {
  const { riskAutoContext } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        itemId: riskAutoContext.itemId,
        head: riskAutoContext.head,
        context: riskAutoContext.context,
      })
      .from(riskAutoContext),
  );
  return rows.map((row) => ({ ...row, context: contextOf(row.context) }));
}

/** Restored outside the request path so file watches survive a process restart. */
export function listRiskAutoContexts(
  db: Database,
): Array<{ itemId: string; head: string; context: RiskAutoContext }> {
  return settled(sqliteDb(db).run((q) => listRiskAutoContextsSteps(q)));
}
