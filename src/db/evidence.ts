import type { Database } from "bun:sqlite";

export type EvidenceMediaType =
  | "video/webm"
  | "video/mp4"
  | "image/png"
  | "image/jpeg"
  | "image/webp";

/** A Closeout video or screenshot. The file lives at `<evidence dir>/<id>`. */
export type EvidenceRow = {
  id: string;
  itemId: string;
  runId: string;
  checkId: string;
  attempt: number;
  mediaType: EvidenceMediaType;
  sizeBytes: number;
  sha256: string;
  displayName: string;
  headCommit: string;
  createdAt: number;
};

const COLUMNS = `id, item_id AS itemId, run_id AS runId, check_id AS checkId, attempt,
  media_type AS mediaType, size_bytes AS sizeBytes, sha256, display_name AS displayName,
  head_commit AS headCommit, created_at AS createdAt`;

export function insertEvidence(db: Database, row: EvidenceRow): void {
  db.query(`INSERT INTO evidence
    (id, item_id, run_id, check_id, attempt, media_type, size_bytes, sha256, display_name, head_commit, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id,
    row.itemId,
    row.runId,
    row.checkId,
    row.attempt,
    row.mediaType,
    row.sizeBytes,
    row.sha256,
    row.displayName,
    row.headCommit,
    row.createdAt,
  );
}

export function getEvidence(db: Database, id: string): EvidenceRow | null {
  return db.query<EvidenceRow, [string]>(`SELECT ${COLUMNS} FROM evidence WHERE id = ?`).get(id);
}
