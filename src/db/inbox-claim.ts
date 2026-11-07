import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull, lt, lte, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { orm } from "./orm";
import { inboxEvent, syncCursor } from "./schema";

export type ClaimedInboxRow = typeof inboxEvent.$inferSelect;

type InboxColumns = Record<
  "handled" | "action" | "signal" | "lockedUntil" | "sessionId" | "issueId",
  AnySQLiteColumn
>;

function queued(table: InboxColumns): SQL {
  return and(
    eq(table.handled, 0),
    inArray(table.action, ["created", "prompted"]),
    or(isNull(table.signal), ne(table.signal, "stop")),
  )!;
}

function free(table: InboxColumns, now: number): SQL {
  return or(isNull(table.lockedUntil), lte(table.lockedUntil, now))!;
}

export function claimNextInboxEvent(
  db: Database,
  claim: { owner: string; now: number; leaseMs: number },
): ClaimedInboxRow | null {
  const candidate = alias(inboxEvent, "candidate");
  const earlier = alias(inboxEvent, "earlier");
  const lane = (table: InboxColumns) => sql`COALESCE(${table.sessionId}, ${table.issueId})`;
  const head = orm(db)
    .select({ dedupeKey: candidate.dedupeKey })
    .from(candidate)
    .where(
      and(
        queued(candidate),
        free(candidate, claim.now),
        or(isNull(candidate.nextAttemptAt), lte(candidate.nextAttemptAt, claim.now)),
        notExists(
          orm(db)
            .select({ one: sql`1` })
            .from(earlier)
            .where(
              and(
                queued(earlier),
                sql`${lane(earlier)} = ${lane(candidate)}`,
                or(
                  lt(earlier.receivedAt, candidate.receivedAt),
                  and(
                    eq(earlier.receivedAt, candidate.receivedAt),
                    lt(earlier.dedupeKey, candidate.dedupeKey),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(candidate.receivedAt, candidate.dedupeKey)
    .limit(1);
  return (
    orm(db)
      .update(inboxEvent)
      .set({ lockedBy: claim.owner, lockedUntil: claim.now + claim.leaseMs })
      .where(
        and(inArray(inboxEvent.dedupeKey, head), queued(inboxEvent), free(inboxEvent, claim.now)),
      )
      .returning()
      .get() ?? null
  );
}

export function claimInboxEvent(
  db: Database,
  dedupeKey: string,
  claim: { owner: string; now: number; leaseMs: number },
): ClaimedInboxRow | null {
  return (
    orm(db)
      .update(inboxEvent)
      .set({ lockedBy: claim.owner, lockedUntil: claim.now + claim.leaseMs })
      .where(
        and(
          eq(inboxEvent.dedupeKey, dedupeKey),
          eq(inboxEvent.handled, 0),
          free(inboxEvent, claim.now),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function renewInboxClaim(
  db: Database,
  dedupeKey: string,
  claim: { owner: string; now: number; leaseMs: number },
): boolean {
  return (
    orm(db)
      .update(inboxEvent)
      .set({ lockedUntil: claim.now + claim.leaseMs })
      .where(and(eq(inboxEvent.dedupeKey, dedupeKey), eq(inboxEvent.lockedBy, claim.owner)))
      .returning({ dedupeKey: inboxEvent.dedupeKey })
      .get() !== undefined
  );
}

export function releaseInboxClaim(db: Database, dedupeKey: string, owner: string): void {
  orm(db)
    .update(inboxEvent)
    .set({ lockedBy: null, lockedUntil: null })
    .where(and(eq(inboxEvent.dedupeKey, dedupeKey), eq(inboxEvent.lockedBy, owner)))
    .run();
}

export function incrementSyncCounter(db: Database, name: string): number {
  return orm(db)
    .insert(syncCursor)
    .values({ name, cursorMs: 1 })
    .onConflictDoUpdate({
      target: syncCursor.name,
      set: { cursorMs: sql`${syncCursor.cursorMs} + 1` },
    })
    .returning({ count: syncCursor.cursorMs })
    .get()!.count;
}

export function clearSyncCursor(db: Database, name: string): void {
  orm(db).delete(syncCursor).where(eq(syncCursor.name, name)).run();
}
