import type { Database } from "bun:sqlite";

/**
 * Records what was still open at the item's last published head: the line the final Linear
 * response carries, already escaped. An empty line means nothing was open. Each publication
 * replaces it.
 */
export function saveOpenFindings(
  db: Database,
  input: { itemId: string; head: string; line: string; now: number },
): void {
  db.run(
    `INSERT INTO open_findings (item_id, head_sha, line, recorded_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET
       head_sha = excluded.head_sha, line = excluded.line, recorded_at = excluded.recorded_at`,
    [input.itemId, input.head, input.line, input.now],
  );
}

/** The open-findings line of the item's last published head, or null when nothing was open. */
export function getOpenFindingsLine(db: Database, itemId: string): string | null {
  const row = db
    .query<{ line: string }, [string]>("SELECT line FROM open_findings WHERE item_id = ?")
    .get(itemId);
  return row?.line ? row.line : null;
}

/** A final response with the open-findings line of the item's last published head after it. */
export function withOpenFindings(db: Database, itemId: string, body: string): string {
  const line = getOpenFindingsLine(db, itemId);
  return line === null ? body : `${body}\n\n${line}`;
}
