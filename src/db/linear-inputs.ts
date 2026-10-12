import type { Database } from "bun:sqlite";

export type LinearInputRecord = {
  sessionId: string;
  turnId: string;
  assetId: string;
  assetUrl: string;
  mimeType: string;
  size: number;
  sha256: string;
};

export function recordLinearInput(db: Database, input: LinearInputRecord): void {
  db.query(`INSERT OR IGNORE INTO linear_input (session_id, turn_id, asset_id, asset_url, mime_type, size, sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    input.sessionId,
    input.turnId,
    input.assetId,
    input.assetUrl,
    input.mimeType,
    input.size,
    input.sha256,
  );
}

export function listLinearInputs(
  db: Database,
  sessionId: string,
  turnId: string,
): LinearInputRecord[] {
  return db
    .query<LinearInputRecord, [string, string]>(`SELECT session_id AS sessionId, turn_id AS turnId,
    asset_id AS assetId, asset_url AS assetUrl, mime_type AS mimeType, size, sha256 FROM linear_input
    WHERE session_id = ? AND turn_id = ? ORDER BY asset_id`)
    .all(sessionId, turnId);
}
