import { and, count, eq, ne, notExists, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";

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

function columns(q: Q) {
  const { linearArtifact } = q.t;
  return {
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
}

export function* saveArtifactSteps(
  q: Q,
  artifact: StoredArtifact & { identityHash?: string },
  now: number,
) {
  const { linearArtifact } = q.t;
  const identityHash = artifact.identityHash ?? null;
  yield* q.exec(
    q.orm
      .insert(linearArtifact)
      .values({ ...artifact, state: "pending", assetUrl: null, createdAt: now, identityHash })
      .onConflictDoNothing(),
  );
  const stored = (yield* q.one(
    q.orm
      .select(columns(q))
      .from(linearArtifact)
      .where(
        and(
          eq(linearArtifact.itemId, artifact.itemId),
          eq(linearArtifact.path, artifact.path),
          eq(linearArtifact.displayName, artifact.displayName),
          eq(linearArtifact.mimeType, artifact.mimeType),
          eq(linearArtifact.sha256, artifact.sha256),
        ),
      ),
  ))!;
  yield* q.exec(
    q.orm
      .update(linearArtifact)
      .set({
        requestVersion: sql`(
          SELECT COALESCE(max(request_version), 0) + 1 FROM linear_artifact WHERE item_id = ${artifact.itemId}
        )`,
        identityHash: sql`coalesce(${identityHash}, identity_hash)`,
      })
      .where(eq(linearArtifact.id, stored.id)),
  );
  return stored;
}

export async function saveArtifact(
  store: Db,
  artifact: StoredArtifact & { identityHash?: string },
  now: number,
): Promise<StoredArtifact> {
  return store.run((q) => saveArtifactSteps(q, artifact, now));
}

export function* markArtifactSteps(q: Q, id: string, assetUrl: string | null) {
  const { linearArtifact } = q.t;
  yield* q.exec(
    q.orm
      .update(linearArtifact)
      .set({ state: assetUrl === null ? "failed" : "uploaded", assetUrl })
      .where(eq(linearArtifact.id, id)),
  );
}

export async function markArtifact(store: Db, id: string, assetUrl: string | null): Promise<void> {
  await store.run((q) => markArtifactSteps(q, id, assetUrl));
}

export function* listArtifactsSteps(q: Q, itemId: string) {
  const { linearArtifact } = q.t;
  return yield* q.all(
    q.orm.select(columns(q)).from(linearArtifact).where(eq(linearArtifact.itemId, itemId)),
  );
}

export async function listArtifacts(store: Db, itemId: string): Promise<StoredArtifact[]> {
  return store.run((q) => listArtifactsSteps(q, itemId));
}

export function* getArtifactSteps(q: Q, id: string) {
  const { linearArtifact } = q.t;
  const row = yield* q.one(
    q.orm.select(columns(q)).from(linearArtifact).where(eq(linearArtifact.id, id)),
  );
  return row ?? null;
}

export async function getArtifact(store: Db, id: string): Promise<StoredArtifact | null> {
  return store.run((q) => getArtifactSteps(q, id));
}

export function* beginArtifactAttemptSteps(q: Q, itemId: string, identityHash: string) {
  const { linearArtifactAttempt } = q.t;
  const row = yield* q.one(
    q.orm
      .insert(linearArtifactAttempt)
      .values({ itemId, identityHash, version: 1, completedVersion: 0 })
      .onConflictDoUpdate({
        target: [linearArtifactAttempt.itemId, linearArtifactAttempt.identityHash],
        set: { version: sql`${linearArtifactAttempt.version} + 1` },
      })
      .returning({ version: linearArtifactAttempt.version }),
  );
  return row!.version;
}

export async function beginArtifactAttempt(
  store: Db,
  itemId: string,
  identityHash: string,
): Promise<number> {
  return store.run((q) => beginArtifactAttemptSteps(q, itemId, identityHash));
}

export function* completeArtifactAttemptSteps(
  q: Q,
  itemId: string,
  identityHash: string,
  version: number,
) {
  const { linearArtifactAttempt } = q.t;
  const greatest = q.dialect === "postgres" ? sql`GREATEST` : sql`max`;
  yield* q.exec(
    q.orm
      .update(linearArtifactAttempt)
      .set({
        completedVersion: sql`${greatest}(${linearArtifactAttempt.completedVersion}, ${version})`,
      })
      .where(attempt(q, itemId, identityHash)),
  );
}

export async function completeArtifactAttempt(
  store: Db,
  itemId: string,
  identityHash: string,
  version: number,
): Promise<void> {
  await store.run((q) => completeArtifactAttemptSteps(q, itemId, identityHash, version));
}

export function* artifactPublicationReadySteps(q: Q, itemId: string) {
  const { linearArtifact, linearArtifactAttempt } = q.t;
  const attempts = (yield* q.one(
    q.orm
      .select({ pending: count() })
      .from(linearArtifactAttempt)
      .where(
        and(
          eq(linearArtifactAttempt.itemId, itemId),
          sql`${linearArtifactAttempt.completedVersion} < ${linearArtifactAttempt.version}`,
        ),
      ),
  ))!;
  if (attempts.pending !== 0) return false;
  // A correlated NOT EXISTS over the same table under a second alias.
  const uploads = (yield* q.one(
    q.orm
      .select({ pending: count() })
      .from(linearArtifact)
      .where(
        and(
          eq(linearArtifact.itemId, itemId),
          ne(linearArtifact.state, "uploaded"),
          notExists(sql`(SELECT 1 FROM linear_artifact AS newer
            WHERE newer.item_id = ${linearArtifact.itemId}
              AND ((${linearArtifact.identityHash} IS NULL AND newer.path = ${linearArtifact.path})
                OR newer.identity_hash = ${linearArtifact.identityHash})
              AND newer.request_version > ${linearArtifact.requestVersion})`),
        ),
      ),
  ))!;
  return uploads.pending === 0;
}

export async function artifactPublicationReady(store: Db, itemId: string): Promise<boolean> {
  return store.run((q) => artifactPublicationReadySteps(q, itemId));
}

export function* requestArtifactAttachmentSteps(q: Q, itemId: string, identityHash: string) {
  const { linearArtifactAttempt } = q.t;
  yield* q.exec(
    q.orm
      .update(linearArtifactAttempt)
      .set({ attachmentRequested: 1 })
      .where(attempt(q, itemId, identityHash)),
  );
}

export async function requestArtifactAttachment(
  store: Db,
  itemId: string,
  identityHash: string,
): Promise<void> {
  await store.run((q) => requestArtifactAttachmentSteps(q, itemId, identityHash));
}

export function* artifactAttachmentRequestedSteps(q: Q, itemId: string, identityHash: string) {
  const { linearArtifactAttempt } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ requested: linearArtifactAttempt.attachmentRequested })
      .from(linearArtifactAttempt)
      .where(attempt(q, itemId, identityHash)),
  );
  return row?.requested === 1;
}

export async function artifactAttachmentRequested(
  store: Db,
  itemId: string,
  identityHash: string,
): Promise<boolean> {
  return store.run((q) => artifactAttachmentRequestedSteps(q, itemId, identityHash));
}

function attempt(q: Q, itemId: string, identityHash: string) {
  const { linearArtifactAttempt } = q.t;
  return and(
    eq(linearArtifactAttempt.itemId, itemId),
    eq(linearArtifactAttempt.identityHash, identityHash),
  );
}
