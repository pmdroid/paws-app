import type { Database } from "bun:sqlite";
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
      db.run("DELETE FROM risk_auto_context WHERE item_id = ?", [itemId]);
      return;
    }
    db.run("DELETE FROM risk_auto_context WHERE item_id = ? AND head != ?", [itemId, head]);
    db.run(
      `INSERT INTO risk_auto_context (item_id, head, context) VALUES (?, ?, ?)
      ON CONFLICT (item_id, head) DO UPDATE SET context = excluded.context
      WHERE context != excluded.context`,
      [itemId, head, JSON.stringify(context)],
    );
  });
}

export function getRiskAutoContext(
  db: Database,
  itemId: string,
): { head: string; context: RiskAutoContext } | null {
  const row = db
    .query<{ head: string; context: string }, [string]>(
      "SELECT head, context FROM risk_auto_context WHERE item_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(itemId);
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
  return db
    .query<{ itemId: string; head: string; context: string }, []>(
      "SELECT item_id AS itemId, head, context FROM risk_auto_context",
    )
    .all()
    .map((row) => ({ ...row, context: contextOf(row.context) }));
}
