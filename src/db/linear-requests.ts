import type { Database } from "bun:sqlite";
import { asc, eq, sql } from "drizzle-orm";
import { orm } from "./orm";
import { linearItemCallerRequest, linearItemRequest } from "./schema";

export function countLinearRequest(db: Database, itemId: string, caller: string): void {
  db.transaction(() => {
    orm(db)
      .insert(linearItemRequest)
      .values({ itemId, requests: 1 })
      .onConflictDoUpdate({
        target: linearItemRequest.itemId,
        set: { requests: sql`${linearItemRequest.requests}+1` },
      })
      .run();
    orm(db)
      .insert(linearItemCallerRequest)
      .values({ itemId, caller, requests: 1 })
      .onConflictDoUpdate({
        target: [linearItemCallerRequest.itemId, linearItemCallerRequest.caller],
        set: { requests: sql`${linearItemCallerRequest.requests}+1` },
      })
      .run();
  })();
}

export function linearRequestsByItem(db: Database): Map<string, number> {
  return new Map(
    orm(db)
      .select({ itemId: linearItemRequest.itemId, requests: linearItemRequest.requests })
      .from(linearItemRequest)
      .all()
      .map((row) => [row.itemId, row.requests]),
  );
}

export function linearRequestsByCaller(db: Database, itemId: string): Record<string, number> {
  return Object.fromEntries(
    orm(db)
      .select({
        caller: linearItemCallerRequest.caller,
        requests: linearItemCallerRequest.requests,
      })
      .from(linearItemCallerRequest)
      .where(eq(linearItemCallerRequest.itemId, itemId))
      .orderBy(asc(linearItemCallerRequest.caller))
      .all()
      .map((row) => [row.caller, row.requests]),
  );
}
