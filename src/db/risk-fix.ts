import { and, desc, eq } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { jsonValue, parsedJson } from "./json-text";
import type { riskFix } from "./schema-pg";

/**
 * What a fix changed on a high-risk pull request since the head a person approved. `paths` are
 * the changed files a high-risk glob matched: empty means the approval carried over to `head`,
 * otherwise Paws asks again about those paths only.
 */
export type RiskFix = {
  itemId: string;
  head: string;
  approvedHead: string;
  /** The risk link ask whose approval this head was compared with. */
  approvedQuestionId: string;
  /** Every file the fix changed since the approved head, sorted. */
  changed: string[];
  paths: string[];
  recordedAt: number;
};

export function* saveRiskFixSteps(q: Q, fix: RiskFix) {
  const { riskFix } = q.t;
  const values = {
    approvedHead: fix.approvedHead,
    approvedQuestionId: fix.approvedQuestionId,
    changed: jsonValue(q, fix.changed),
    paths: jsonValue(q, fix.paths),
    recordedAt: fix.recordedAt,
  };
  yield* q.exec(
    q.orm
      .insert(riskFix)
      .values({ itemId: fix.itemId, headSha: fix.head, ...values })
      .onConflictDoUpdate({ target: [riskFix.itemId, riskFix.headSha], set: values }),
  );
}

/** Records the comparison for a head. A repeat for the same head replaces it. */
export async function saveRiskFix(store: Db, fix: RiskFix): Promise<void> {
  await store.run((q) => saveRiskFixSteps(q, fix));
}

export function* deleteRiskFixSteps(q: Q, itemId: string, head: string) {
  const { riskFix } = q.t;
  yield* q.exec(
    q.orm.delete(riskFix).where(and(eq(riskFix.itemId, itemId), eq(riskFix.headSha, head))),
  );
}

/** Forgets the comparison for a head, as when Paws can no longer read the fix. */
export async function deleteRiskFix(store: Db, itemId: string, head: string): Promise<void> {
  await store.run((q) => deleteRiskFixSteps(q, itemId, head));
}

type Row = typeof riskFix.$inferSelect;

export function* getRiskFixSteps(q: Q, itemId: string, head: string) {
  const { riskFix } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(riskFix)
      .where(and(eq(riskFix.itemId, itemId), eq(riskFix.headSha, head))),
  );
  return row ? fromRow(q, row) : null;
}

export async function getRiskFix(store: Db, itemId: string, head: string): Promise<RiskFix | null> {
  return store.run((q) => getRiskFixSteps(q, itemId, head));
}

/** Ties on `recorded_at` go to the greater head SHA. */
export function* latestRiskFixSteps(q: Q, itemId: string) {
  const { riskFix } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(riskFix)
      .where(eq(riskFix.itemId, itemId))
      .orderBy(desc(riskFix.recordedAt), desc(riskFix.headSha))
      .limit(1),
  );
  return row ? fromRow(q, row) : null;
}

/** The most recently recorded fix of the item. */
export async function latestRiskFix(store: Db, itemId: string): Promise<RiskFix | null> {
  return store.run((q) => latestRiskFixSteps(q, itemId));
}

function fromRow(q: Q, row: Row): RiskFix {
  return {
    itemId: row.itemId,
    head: row.headSha,
    approvedHead: row.approvedHead,
    approvedQuestionId: row.approvedQuestionId,
    changed: parsedJson<string[]>(q, row.changed),
    paths: parsedJson<string[]>(q, row.paths),
    recordedAt: row.recordedAt,
  };
}
