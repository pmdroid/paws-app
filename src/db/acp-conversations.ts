import { and, asc, eq, gte, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { jsonFromText, jsonText } from "./json-text";

/** What the item page and the Linear session say while a block holds a reply back. */
export const CLEANUP_BLOCKED_NOTICE =
  "Paws couldn't confirm the previous agent stopped; it will continue when the runner confirms.";

type Conversation = {
  entries: string;
  transcript: string | null;
  transcriptOffset: number;
  blocked: boolean;
  /** When the block was set; 0 for a block recorded before Paws kept the time. */
  blockedAt: number | null;
};

export function* getConversationSteps(q: Q, itemId: string) {
  const { linearConversation } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        transcript: linearConversation.transcript,
        transcriptOffset: linearConversation.transcriptOffset,
        blocked: linearConversation.blocked,
        blockedAt: linearConversation.blockedAt,
      })
      .from(linearConversation)
      .where(eq(linearConversation.itemId, itemId)),
  );
  const entries = row ? yield* storedEntries(q, itemId) : "[]";
  return row
    ? {
        entries,
        transcript: row.transcript,
        transcriptOffset: row.transcriptOffset,
        blocked: row.blocked === 1,
        blockedAt: row.blocked === 1 ? (row.blockedAt ?? 0) : null,
      }
    : { entries: "[]", transcript: null, transcriptOffset: 0, blocked: false, blockedAt: null };
}

function* storedEntries(q: Q, itemId: string) {
  const { linearConversationEntry } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ entry: jsonText(q, linearConversationEntry.entry) })
      .from(linearConversationEntry)
      .where(eq(linearConversationEntry.itemId, itemId))
      .orderBy(asc(linearConversationEntry.position)),
  );
  return `[${rows.map((row) => row.entry).join(",")}]`;
}

function* appendEntries(q: Q, itemId: string, entries: string) {
  const { linearConversationEntry } = q.t;
  const list = JSON.parse(entries) as unknown[];
  const counted = yield* q.one(
    q.orm
      .select({
        count: sql<number>`count(*)`,
        differs: sql<
          number | null
        >`min(${linearConversationEntry.position}) FILTER (WHERE ${linearConversationEntry.position} < ${list.length} AND ${linearConversationEntry.entry} IS DISTINCT FROM (${entries}::text::jsonb -> ${linearConversationEntry.position}::int))`,
      })
      .from(linearConversationEntry)
      .where(eq(linearConversationEntry.itemId, itemId)),
  );
  const stored = Number(counted?.count ?? 0);
  const differs = counted?.differs;
  const kept = Math.min(
    stored,
    list.length,
    differs === null || differs === undefined ? Infinity : Number(differs),
  );
  if (kept < stored)
    yield* q.exec(
      q.orm
        .delete(linearConversationEntry)
        .where(
          and(
            eq(linearConversationEntry.itemId, itemId),
            gte(linearConversationEntry.position, kept),
          ),
        ),
    );
  const added = list.slice(kept);
  if (added.length === 0) return;
  const createdAt = Date.now();
  yield* q.exec(
    q.orm.insert(linearConversationEntry).values(
      added.map((entry, index) => ({
        itemId,
        position: kept + index,
        entry: jsonFromText(q, JSON.stringify(entry)),
        createdAt,
      })),
    ),
  );
}

export async function getConversation(store: Db, itemId: string): Promise<Conversation> {
  return store.run((q) => getConversationSteps(q, itemId));
}

/** The block time a write keeps: the stored one while the conversation is already blocked. */
function keptBlockedAt(q: Q) {
  const { linearConversation } = q.t;
  return sql`CASE WHEN ${linearConversation.blocked} = 1 THEN ${linearConversation.blockedAt} ELSE excluded.blocked_at END`;
}

/** An ordinary save can only raise the block; `clearConversationBlock` is the way down. */
export function* saveConversationSteps(
  q: Q,
  itemId: string,
  entries: string,
  transcript: string | null,
  blocked = false,
  transcriptOffset = 0,
) {
  yield* q.transaction(function* (t) {
    const { linearConversation } = t.t;
    const higher = sql`GREATEST`;
    yield* t.exec(
      t.orm
        .insert(linearConversation)
        .values({
          itemId,
          transcript,
          blocked: blocked ? 1 : 0,
          transcriptOffset,
          blockedAt: blocked ? Date.now() : null,
        })
        .onConflictDoUpdate({
          target: linearConversation.itemId,
          set: {
            transcript: sql`excluded.transcript`,
            transcriptOffset: sql`excluded.transcript_offset`,
            blocked: sql`${higher}(${linearConversation.blocked},excluded.blocked)`,
            blockedAt: keptBlockedAt(t),
          },
        }),
    );
    yield* appendEntries(t, itemId, entries);
  });
}

export async function saveConversation(
  store: Db,
  itemId: string,
  entries: string,
  transcript: string | null,
  blocked = false,
  transcriptOffset = 0,
): Promise<void> {
  await store.run((q) =>
    saveConversationSteps(q, itemId, entries, transcript, blocked, transcriptOffset),
  );
}

/**
 * Marks the conversation blocked: a process of its last run may still be alive, so no second
 * agent starts for the item. The first block keeps its time.
 */
export function* blockConversationSteps(q: Q, itemId: string, now: number) {
  const { linearConversation } = q.t;
  yield* q.exec(
    q.orm
      .insert(linearConversation)
      .values({
        itemId,
        transcript: null,
        blocked: 1,
        blockedAt: now,
      })
      .onConflictDoUpdate({
        target: linearConversation.itemId,
        set: { blockedAt: keptBlockedAt(q), blocked: 1 },
      }),
  );
}

export async function blockConversation(store: Db, itemId: string, now: number): Promise<void> {
  await store.run((q) => blockConversationSteps(q, itemId, now));
}

/**
 * Clears the block once the old agent is known to be gone. With `blockedAt`, only the block
 * set at that time is cleared, so a newer block stays. True when it cleared one.
 */
export function* clearConversationBlockSteps(q: Q, itemId: string, blockedAt?: number | null) {
  const { linearConversation } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(linearConversation)
      .set({ blocked: 0, blockedAt: null })
      .where(
        and(
          eq(linearConversation.itemId, itemId),
          eq(linearConversation.blocked, 1),
          blockedAt === undefined || blockedAt === null
            ? undefined
            : sql`COALESCE(${linearConversation.blockedAt},0) = ${blockedAt}`,
        ),
      )
      .returning({ itemId: linearConversation.itemId }),
  );
  return rows.length === 1;
}

export async function clearConversationBlock(
  store: Db,
  itemId: string,
  blockedAt?: number | null,
): Promise<boolean> {
  return store.run((q) => clearConversationBlockSteps(q, itemId, blockedAt));
}

/** Items whose conversation is blocked, with the time each block was set. */
export function* listBlockedConversationsSteps(q: Q) {
  const { linearConversation } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ itemId: linearConversation.itemId, blockedAt: linearConversation.blockedAt })
      .from(linearConversation)
      .where(eq(linearConversation.blocked, 1))
      .orderBy(asc(linearConversation.itemId)),
  );
  return rows.map((row) => ({ itemId: row.itemId, blockedAt: row.blockedAt ?? 0 }));
}

export async function listBlockedConversations(
  store: Db,
): Promise<{ itemId: string; blockedAt: number }[]> {
  return store.run((q) => listBlockedConversationsSteps(q));
}
