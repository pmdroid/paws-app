import type { Database } from "bun:sqlite";

export function getConversation(
  db: Database,
  itemId: string,
): { entries: string; transcript: string | null; transcriptOffset: number; blocked: boolean } {
  const row = db
    .query<
      { entries: string; transcript: string | null; transcript_offset: number; blocked: number },
      [string]
    >(
      "SELECT entries,transcript,transcript_offset,blocked FROM linear_conversation WHERE item_id = ?",
    )
    .get(itemId);
  return row
    ? {
        entries: row.entries,
        transcript: row.transcript,
        transcriptOffset: row.transcript_offset,
        blocked: row.blocked === 1,
      }
    : { entries: "[]", transcript: null, transcriptOffset: 0, blocked: false };
}

export function saveConversation(
  db: Database,
  itemId: string,
  entries: string,
  transcript: string | null,
  blocked = false,
  transcriptOffset = 0,
): void {
  db.run(
    "INSERT INTO linear_conversation(item_id,entries,transcript,blocked,transcript_offset) VALUES (?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET entries = excluded.entries, transcript = excluded.transcript, transcript_offset = excluded.transcript_offset, blocked = MAX(linear_conversation.blocked,excluded.blocked)",
    [itemId, entries, transcript, blocked ? 1 : 0, transcriptOffset],
  );
}
