import { and, count, eq, like } from "drizzle-orm";
import { type Q, type Db } from "./db";

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

export async function countMergeDenials(store: Db, itemId: string, head: string): Promise<number> {
  return store.run((q) => countMergeDenialsSteps(q, itemId, head));
}
