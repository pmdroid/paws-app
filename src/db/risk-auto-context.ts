import type { Database } from "bun:sqlite";
import { and, eq, ne, sql } from "drizzle-orm";
import { orm } from "./orm";
import { riskAutoContext } from "./schema";
import { immediate } from "./tx";

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

/** Keep only the most recently evaluated head; identical polls make no writes. */
export function saveRiskAutoContext(
  db: Database,
  itemId: string,
  head: string,
  context: RiskAutoContext | null,
): void {
  immediate(db, () => {
    if (context === null) {
      orm(db).delete(riskAutoContext).where(eq(riskAutoContext.itemId, itemId)).run();
      return;
    }
    orm(db)
      .delete(riskAutoContext)
      .where(and(eq(riskAutoContext.itemId, itemId), ne(riskAutoContext.head, head)))
      .run();
    orm(db)
      .insert(riskAutoContext)
      .values({ itemId, head, context: JSON.stringify(context) })
      .onConflictDoUpdate({
        target: [riskAutoContext.itemId, riskAutoContext.head],
        set: { context: sql`excluded.context` },
        setWhere: sql`${riskAutoContext.context} != excluded.context`,
      })
      .run();
  });
}

export function getRiskAutoContext(
  db: Database,
  itemId: string,
): { head: string; context: RiskAutoContext } | null {
  const row = orm(db)
    .select({ head: riskAutoContext.head, context: riskAutoContext.context })
    .from(riskAutoContext)
    .where(eq(riskAutoContext.itemId, itemId))
    .orderBy(sql`rowid DESC`)
    .limit(1)
    .get();
  if (!row) return null;
  const value = contextOf(row.context);
  return { head: row.head, context: value };
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

/** Restored outside the request path so file watches survive a process restart. */
export function listRiskAutoContexts(
  db: Database,
): Array<{ itemId: string; head: string; context: RiskAutoContext }> {
  return orm(db)
    .select({
      itemId: riskAutoContext.itemId,
      head: riskAutoContext.head,
      context: riskAutoContext.context,
    })
    .from(riskAutoContext)
    .all()
    .map((row) => ({ ...row, context: contextOf(row.context) }));
}
