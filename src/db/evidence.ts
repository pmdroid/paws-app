import type { Database } from "bun:sqlite";

export type EvidenceMediaType =
  | "video/webm"
  | "video/mp4"
  | "image/png"
  | "image/jpeg"
  | "image/webp";

export type StoredEvidence = {
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

export function saveEvidence(db: Database, evidence: StoredEvidence): void {
  db.query(`INSERT INTO evidence
    (id, item_id, run_id, check_id, attempt, media_type, size_bytes, sha256, display_name, head_commit, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    evidence.id,
    evidence.itemId,
    evidence.runId,
    evidence.checkId,
    evidence.attempt,
    evidence.mediaType,
    evidence.sizeBytes,
    evidence.sha256,
    evidence.displayName,
    evidence.headCommit,
    evidence.createdAt,
  );
}

export function getEvidence(db: Database, id: string): StoredEvidence | null {
  return db.query<StoredEvidence, [string]>(`SELECT ${COLUMNS} FROM evidence WHERE id = ?`).get(id);
}

export function listEvidence(db: Database, itemId: string): StoredEvidence[] {
  return db
    .query<StoredEvidence, [string]>(
      `SELECT ${COLUMNS} FROM evidence WHERE item_id = ? ORDER BY created_at, id`,
    )
    .all(itemId);
}
