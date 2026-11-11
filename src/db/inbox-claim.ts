import { and, eq, inArray, isNull, lt, lte, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { type Db, type Q } from "./db";
import type { inboxEvent } from "./schema";

export type ClaimedInboxRow = typeof inboxEvent.$inferSelect;

type InboxColumns = Record<
  "handled" | "action" | "signal" | "lockedUntil" | "sessionId" | "issueId",
  AnyPgColumn
>;

type Claim = { owner: string; now: number; leaseMs: number };

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

function claimed(
  q: Q,
  row: Q["t"]["inboxEvent"]["$inferSelect"] | undefined,
): ClaimedInboxRow | null {
  if (row === undefined) return null;
  return {
    ...row,
    payload: q.dialect === "sqlite" ? (row.payload as string) : JSON.stringify(row.payload),
  };
}

export function* claimNextInboxEventSteps(q: Q, claim: Claim) {
  const { inboxEvent } = q.t;
  const candidate = alias(inboxEvent, "candidate");
  const earlier = alias(inboxEvent, "earlier");
  const lane = (table: InboxColumns) => sql`COALESCE(${table.sessionId}, ${table.issueId})`;
  const head = q.orm
    .select({ dedupeKey: candidate.dedupeKey })
    .from(candidate)
    .where(
      and(
        queued(candidate),
        free(candidate, claim.now),
        or(isNull(candidate.nextAttemptAt), lte(candidate.nextAttemptAt, claim.now)),
        notExists(
          q.orm
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
  const row = yield* q.one(
    q.orm
      .update(inboxEvent)
      .set({ lockedBy: claim.owner, lockedUntil: claim.now + claim.leaseMs })
      .where(
        and(inArray(inboxEvent.dedupeKey, head), queued(inboxEvent), free(inboxEvent, claim.now)),
      )
      .returning(),
  );
  return claimed(q, row);
}

export async function claimNextInboxEvent(
  store: Db,
  claim: Claim,
): Promise<ClaimedInboxRow | null> {
  return store.run((q) => claimNextInboxEventSteps(q, claim));
}

export function* claimInboxEventSteps(q: Q, dedupeKey: string, claim: Claim) {
  const { inboxEvent } = q.t;
  const row = yield* q.one(
    q.orm
      .update(inboxEvent)
      .set({ lockedBy: claim.owner, lockedUntil: claim.now + claim.leaseMs })
      .where(
        and(
          eq(inboxEvent.dedupeKey, dedupeKey),
          eq(inboxEvent.handled, 0),
          free(inboxEvent, claim.now),
        ),
      )
      .returning(),
  );
  return claimed(q, row);
}

export async function claimInboxEvent(
  store: Db,
  dedupeKey: string,
  claim: Claim,
): Promise<ClaimedInboxRow | null> {
  return store.run((q) => claimInboxEventSteps(q, dedupeKey, claim));
}

export function* renewInboxClaimSteps(q: Q, dedupeKey: string, claim: Claim) {
  const { inboxEvent } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(inboxEvent)
      .set({ lockedUntil: claim.now + claim.leaseMs })
      .where(and(eq(inboxEvent.dedupeKey, dedupeKey), eq(inboxEvent.lockedBy, claim.owner)))
      .returning({ dedupeKey: inboxEvent.dedupeKey }),
  );
  return rows.length > 0;
}

export async function renewInboxClaim(
  store: Db,
  dedupeKey: string,
  claim: Claim,
): Promise<boolean> {
  return store.run((q) => renewInboxClaimSteps(q, dedupeKey, claim));
}

export function* releaseInboxClaimSteps(q: Q, dedupeKey: string, owner: string) {
  const { inboxEvent } = q.t;
  yield* q.exec(
    q.orm
      .update(inboxEvent)
      .set({ lockedBy: null, lockedUntil: null })
      .where(and(eq(inboxEvent.dedupeKey, dedupeKey), eq(inboxEvent.lockedBy, owner))),
  );
}

export async function releaseInboxClaim(
  store: Db,
  dedupeKey: string,
  owner: string,
): Promise<void> {
  return store.run((q) => releaseInboxClaimSteps(q, dedupeKey, owner));
}

export function* incrementSyncCounterSteps(q: Q, name: string) {
  const { syncCursor } = q.t;
  const row = yield* q.one(
    q.orm
      .insert(syncCursor)
      .values({ name, cursorMs: 1 })
      .onConflictDoUpdate({
        target: syncCursor.name,
        set: { cursorMs: sql`${syncCursor.cursorMs} + 1` },
      })
      .returning({ count: syncCursor.cursorMs }),
  );
  return row!.count;
}

export async function incrementSyncCounter(store: Db, name: string): Promise<number> {
  return store.run((q) => incrementSyncCounterSteps(q, name));
}

export function* clearSyncCursorSteps(q: Q, name: string) {
  yield* q.exec(q.orm.delete(q.t.syncCursor).where(eq(q.t.syncCursor.name, name)));
}

export async function clearSyncCursor(store: Db, name: string): Promise<void> {
  return store.run((q) => clearSyncCursorSteps(q, name));
}
