import { sql } from "drizzle-orm";
import { type Q, type Db } from "./db";

export function* countLinearRequestSteps(q: Q, itemId: string) {
  const { linearItemRequest } = q.t;
  yield* q.exec(
    q.orm
      .insert(linearItemRequest)
      .values({ itemId, requests: 1 })
      .onConflictDoUpdate({
        target: linearItemRequest.itemId,
        set: { requests: sql`${linearItemRequest.requests}+1` },
      }),
  );
}

export async function countLinearRequest(store: Db, itemId: string): Promise<void> {
  await store.run((q) => countLinearRequestSteps(q, itemId));
}

export function* linearRequestsByItemSteps(q: Q) {
  const { linearItemRequest } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ itemId: linearItemRequest.itemId, requests: linearItemRequest.requests })
      .from(linearItemRequest),
  );
  return new Map(rows.map((row) => [row.itemId, row.requests]));
}

export async function linearRequestsByItem(store: Db): Promise<Map<string, number>> {
  return store.run((q) => linearRequestsByItemSteps(q));
}
