import type { Database } from "bun:sqlite";

/** What the item page and the Linear session say while a block holds a reply back. */
export const CLEANUP_BLOCKED_NOTICE =
  "Paws couldn't confirm the previous agent stopped; it will continue when the runner confirms.";

export function getConversation(
  db: Database,
  itemId: string,
): {
  entries: string;
  transcript: string | null;
  transcriptOffset: number;
  blocked: boolean;
  /** When the block was set; 0 for a block recorded before Paws kept the time. */
  blockedAt: number | null;
} {
  const row = db
    .query<
      {
        entries: string;
        transcript: string | null;
        transcript_offset: number;
        blocked: number;
        blocked_at: number | null;
      },
      [string]
    >(
      "SELECT entries,transcript,transcript_offset,blocked,blocked_at FROM linear_conversation WHERE item_id = ?",
    )
    .get(itemId);
  return row
    ? {
        entries: row.entries,
        transcript: row.transcript,
        transcriptOffset: row.transcript_offset,
        blocked: row.blocked === 1,
        blockedAt: row.blocked === 1 ? (row.blocked_at ?? 0) : null,
      }
    : { entries: "[]", transcript: null, transcriptOffset: 0, blocked: false, blockedAt: null };
}

/** An ordinary save can only raise the block; `clearConversationBlock` is the way down. */
export function saveConversation(
  db: Database,
  itemId: string,
  entries: string,
  transcript: string | null,
  blocked = false,
  transcriptOffset = 0,
): void {
  db.run(
    "INSERT INTO linear_conversation(item_id,entries,transcript,blocked,transcript_offset,blocked_at) VALUES (?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET entries = excluded.entries, transcript = excluded.transcript, transcript_offset = excluded.transcript_offset, blocked = MAX(linear_conversation.blocked,excluded.blocked), blocked_at = CASE WHEN linear_conversation.blocked = 1 THEN linear_conversation.blocked_at ELSE excluded.blocked_at END",
    [itemId, entries, transcript, blocked ? 1 : 0, transcriptOffset, blocked ? Date.now() : null],
  );
}

/**
 * Marks the conversation blocked: a process of its last run may still be alive, so no second
 * agent starts for the item. The first block keeps its time.
 */
export function blockConversation(db: Database, itemId: string, now: number): void {
  db.run(
    "INSERT INTO linear_conversation(item_id,entries,transcript,blocked,blocked_at) VALUES (?,'[]',NULL,1,?) ON CONFLICT(item_id) DO UPDATE SET blocked_at = CASE WHEN linear_conversation.blocked = 1 THEN linear_conversation.blocked_at ELSE excluded.blocked_at END, blocked = 1",
    [itemId, now],
  );
}

/**
 * Clears the block once the old agent is known to be gone. With `blockedAt`, only the block
 * set at that time is cleared, so a newer block stays. True when it cleared one.
 */
export function clearConversationBlock(
  db: Database,
  itemId: string,
  blockedAt?: number | null,
): boolean {
  return (
    db.run(
      "UPDATE linear_conversation SET blocked = 0, blocked_at = NULL WHERE item_id = ?1 AND blocked = 1 AND (?2 IS NULL OR COALESCE(blocked_at,0) = ?2)",
      [itemId, blockedAt ?? null],
    ).changes === 1
  );
}

/** Items whose conversation is blocked, with the time each block was set. */
export function listBlockedConversations(db: Database): { itemId: string; blockedAt: number }[] {
  return db
    .query<{ itemId: string; blockedAt: number }, []>(
      "SELECT item_id AS itemId,COALESCE(blocked_at,0) AS blockedAt FROM linear_conversation WHERE blocked = 1 ORDER BY item_id",
    )
    .all();
}
