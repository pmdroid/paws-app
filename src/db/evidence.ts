import type { Database } from "bun:sqlite";

export type EvidenceMediaType =
  | "video/webm"
  | "video/mp4"
  | "image/png"
  | "image/jpeg"
  | "image/webp";

/** One stored Closeout video or screenshot. The file lives at `<evidence dir>/<id>`. */
export type EvidenceRecord = {
  id: string;
  itemId: string;
  runId: string;
  checkId: string;
  attempt: number;
  mediaType: EvidenceMediaType;
  size: number;
  sha256: string;
  displayName: string;
  headCommit: string;
  createdAt: number;
};

type EvidenceSql = {
  id: string;
  item_id: string;
  run_id: string;
  check_id: string;
  attempt: number;
  media_type: EvidenceMediaType;
  size: number;
  sha256: string;
  display_name: string;
  head_commit: string;
  created_at: number;
};

export function insertEvidence(db: Database, record: EvidenceRecord): void {
  db.run(
    `INSERT INTO evidence (
       id, item_id, run_id, check_id, attempt, media_type, size, sha256, display_name, head_commit, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.itemId,
      record.runId,
      record.checkId,
      record.attempt,
      record.mediaType,
      record.size,
      record.sha256,
      record.displayName,
      record.headCommit,
      record.createdAt,
    ],
  );
}

export function getEvidence(db: Database, id: string): EvidenceRecord | null {
  const row = db.query<EvidenceSql, [string]>("SELECT * FROM evidence WHERE id = ?").get(id);
  return row === null ? null : fromSql(row);
}

export function listEvidence(db: Database, itemId: string): EvidenceRecord[] {
  return db
    .query<EvidenceSql, [string]>(
      "SELECT * FROM evidence WHERE item_id = ? ORDER BY created_at, id",
    )
    .all(itemId)
    .map(fromSql);
}

function fromSql(row: EvidenceSql): EvidenceRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    checkId: row.check_id,
    attempt: row.attempt,
    mediaType: row.media_type,
    size: row.size,
    sha256: row.sha256,
    displayName: row.display_name,
    headCommit: row.head_commit,
    createdAt: row.created_at,
  };
}
