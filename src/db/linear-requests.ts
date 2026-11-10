import type { Database } from "bun:sqlite";
import { asc, eq, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Db } from "./db";

export function* countLinearRequestSteps(q: Q, itemId: string, caller: string) {
  const { linearItemCallerRequest, linearItemRequest } = q.t;
  yield* q.exec(
    q.orm
      .insert(linearItemRequest)
      .values({ itemId, requests: 1 })
      .onConflictDoUpdate({
        target: linearItemRequest.itemId,
        set: { requests: sql`${linearItemRequest.requests}+1` },
      }),
  );
  yield* q.exec(
    q.orm
      .insert(linearItemCallerRequest)
      .values({ itemId, caller, requests: 1 })
      .onConflictDoUpdate({
        target: [linearItemCallerRequest.itemId, linearItemCallerRequest.caller],
        set: { requests: sql`${linearItemCallerRequest.requests}+1` },
      }),
  );
}

export function countLinearRequest(db: Database, itemId: string, caller: string): void {
  settled(sqliteDb(db).transaction((q) => countLinearRequestSteps(q, itemId, caller)));
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

export function* linearRequestsByCallerSteps(q: Q, itemId: string) {
  const { linearItemCallerRequest } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        caller: linearItemCallerRequest.caller,
        requests: linearItemCallerRequest.requests,
      })
      .from(linearItemCallerRequest)
      .where(eq(linearItemCallerRequest.itemId, itemId))
      .orderBy(asc(linearItemCallerRequest.caller)),
  );
  return Object.fromEntries(rows.map((row) => [row.caller, row.requests])) as Record<
    string,
    number
  >;
}

export async function linearRequestsByCaller(
  store: Db,
  itemId: string,
): Promise<Record<string, number>> {
  return store.run((q) => linearRequestsByCallerSteps(q, itemId));
}
