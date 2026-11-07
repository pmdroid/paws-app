import type { Database } from "bun:sqlite";
import { and, count, eq, like } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export const MERGE_DENIED_REASON = "merge_denied";

export function* countMergeDenialsSteps(q: Q, itemId: string, head: string) {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ n: count() })
      .from(question)
      .where(
        and(
          eq(question.itemId, itemId),
          eq(question.reason, MERGE_DENIED_REASON),
          like(question.body, `%${head}%`),
        ),
      ),
  );
  return Number(row?.n ?? 0);
}

export function countMergeDenials(db: Database, itemId: string, head: string): number {
  return settled(sqliteDb(db).run((q) => countMergeDenialsSteps(q, itemId, head)));
}
