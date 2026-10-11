import type { Database } from "bun:sqlite";

export type StoredArtifact = {
  id: string;
  itemId: string;
  runId: string;
  path: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  state: "pending" | "uploaded" | "failed";
  assetUrl: string | null;
};

const COLUMNS = `id, item_id AS itemId, run_id AS runId, path, display_name AS displayName,
  mime_type AS mimeType, size_bytes AS sizeBytes, sha256, state, asset_url AS assetUrl`;

export function saveArtifact(db: Database, artifact: StoredArtifact, now: number): StoredArtifact {
  db.query(`INSERT OR IGNORE INTO linear_artifact
    (id, item_id, run_id, path, display_name, mime_type, size_bytes, sha256, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
    artifact.id,
    artifact.itemId,
    artifact.runId,
    artifact.path,
    artifact.displayName,
    artifact.mimeType,
    artifact.sizeBytes,
    artifact.sha256,
    now,
  );
  const stored = db
    .query<StoredArtifact, [string, string, string, string, string]>(
      `SELECT ${COLUMNS} FROM linear_artifact
     WHERE item_id = ? AND path = ? AND display_name = ? AND mime_type = ? AND sha256 = ?`,
    )
    .get(artifact.itemId, artifact.path, artifact.displayName, artifact.mimeType, artifact.sha256)!;
  db.query(`UPDATE linear_artifact SET request_version = (
    SELECT COALESCE(max(request_version), 0) + 1 FROM linear_artifact WHERE item_id = ?
  ) WHERE id = ?`).run(artifact.itemId, stored.id);
  return stored;
}

export function markArtifact(db: Database, id: string, assetUrl: string | null): void {
  db.query("UPDATE linear_artifact SET state = ?, asset_url = ? WHERE id = ?").run(
    assetUrl === null ? "failed" : "uploaded",
    assetUrl,
    id,
  );
}

export function listArtifacts(db: Database, itemId: string): StoredArtifact[] {
  return db
    .query<StoredArtifact, [string]>(`SELECT ${COLUMNS} FROM linear_artifact WHERE item_id = ?`)
    .all(itemId);
}

export function artifactPublicationReady(db: Database, itemId: string): boolean {
  return (
    db
      .query<{ pending: number }, [string]>(
        `SELECT count(*) AS pending FROM linear_artifact AS artifact
     WHERE item_id = ? AND state != 'uploaded' AND NOT EXISTS (
       SELECT 1 FROM linear_artifact AS newer
       WHERE newer.item_id = artifact.item_id AND newer.path = artifact.path
         AND newer.request_version > artifact.request_version
     )`,
      )
      .get(itemId)!.pending === 0
  );
}
