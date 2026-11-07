import type { Database } from "bun:sqlite";
import { and, count, eq, sql } from "drizzle-orm";
import { orm } from "./orm";
import { linearArtifact, linearArtifactAttempt } from "./schema";

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

const columns = {
  id: linearArtifact.id,
  itemId: linearArtifact.itemId,
  runId: linearArtifact.runId,
  path: linearArtifact.path,
  displayName: linearArtifact.displayName,
  mimeType: linearArtifact.mimeType,
  sizeBytes: linearArtifact.sizeBytes,
  sha256: linearArtifact.sha256,
  state: sql<StoredArtifact["state"]>`${linearArtifact.state}`,
  assetUrl: linearArtifact.assetUrl,
};

export function saveArtifact(
  db: Database,
  artifact: StoredArtifact & { identityHash?: string },
  now: number,
): StoredArtifact {
  const identityHash = artifact.identityHash ?? null;
  orm(db)
    .insert(linearArtifact)
    .values({ ...artifact, state: "pending", assetUrl: null, createdAt: now, identityHash })
    .onConflictDoNothing()
    .run();
  const stored = orm(db)
    .select(columns)
    .from(linearArtifact)
    .where(
      and(
        eq(linearArtifact.itemId, artifact.itemId),
        eq(linearArtifact.path, artifact.path),
        eq(linearArtifact.displayName, artifact.displayName),
        eq(linearArtifact.mimeType, artifact.mimeType),
        eq(linearArtifact.sha256, artifact.sha256),
      ),
    )
    .get()!;
  orm(db)
    .update(linearArtifact)
    .set({
      requestVersion: sql`(
        SELECT COALESCE(max(request_version), 0) + 1 FROM linear_artifact WHERE item_id = ${artifact.itemId}
      )`,
      identityHash: sql`coalesce(${identityHash}, identity_hash)`,
    })
    .where(eq(linearArtifact.id, stored.id))
    .run();
  return stored;
}

export function markArtifact(db: Database, id: string, assetUrl: string | null): void {
  orm(db)
    .update(linearArtifact)
    .set({ state: assetUrl === null ? "failed" : "uploaded", assetUrl })
    .where(eq(linearArtifact.id, id))
    .run();
}

export function listArtifacts(db: Database, itemId: string): StoredArtifact[] {
  return orm(db)
    .select(columns)
    .from(linearArtifact)
    .where(eq(linearArtifact.itemId, itemId))
    .all();
}

export function getArtifact(db: Database, id: string): StoredArtifact | null {
  return (
    orm(db).select(columns).from(linearArtifact).where(eq(linearArtifact.id, id)).get() ?? null
  );
}

export function beginArtifactAttempt(db: Database, itemId: string, identityHash: string): number {
  return orm(db)
    .insert(linearArtifactAttempt)
    .values({ itemId, identityHash, version: 1, completedVersion: 0 })
    .onConflictDoUpdate({
      target: [linearArtifactAttempt.itemId, linearArtifactAttempt.identityHash],
      set: { version: sql`${linearArtifactAttempt.version} + 1` },
    })
    .returning({ version: linearArtifactAttempt.version })
    .get().version;
}

export function completeArtifactAttempt(
  db: Database,
  itemId: string,
  identityHash: string,
  version: number,
): void {
  orm(db)
    .update(linearArtifactAttempt)
    .set({ completedVersion: sql`max(${linearArtifactAttempt.completedVersion}, ${version})` })
    .where(attempt(itemId, identityHash))
    .run();
}

export function artifactPublicationReady(db: Database, itemId: string): boolean {
  const attempts = orm(db)
    .select({ pending: count() })
    .from(linearArtifactAttempt)
    .where(
      and(
        eq(linearArtifactAttempt.itemId, itemId),
        sql`${linearArtifactAttempt.completedVersion} < ${linearArtifactAttempt.version}`,
      ),
    )
    .get()!;
  if (attempts.pending !== 0) return false;
  // A correlated NOT EXISTS over the same table under two aliases.
  const [uploads] = orm(db).all<{ pending: number }>(sql`SELECT count(*) AS pending
     FROM linear_artifact AS artifact
     WHERE item_id = ${itemId} AND state != 'uploaded' AND NOT EXISTS (
       SELECT 1 FROM linear_artifact AS newer
       WHERE newer.item_id = artifact.item_id
         AND ((artifact.identity_hash IS NULL AND newer.path = artifact.path)
           OR newer.identity_hash = artifact.identity_hash)
         AND newer.request_version > artifact.request_version
     )`);
  return uploads!.pending === 0;
}

export function requestArtifactAttachment(
  db: Database,
  itemId: string,
  identityHash: string,
): void {
  orm(db)
    .update(linearArtifactAttempt)
    .set({ attachmentRequested: 1 })
    .where(attempt(itemId, identityHash))
    .run();
}

export function artifactAttachmentRequested(
  db: Database,
  itemId: string,
  identityHash: string,
): boolean {
  return (
    orm(db)
      .select({ requested: linearArtifactAttempt.attachmentRequested })
      .from(linearArtifactAttempt)
      .where(attempt(itemId, identityHash))
      .get()?.requested === 1
  );
}

function attempt(itemId: string, identityHash: string) {
  return and(
    eq(linearArtifactAttempt.itemId, itemId),
    eq(linearArtifactAttempt.identityHash, identityHash),
  );
}
