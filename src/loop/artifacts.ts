import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ArtifactRejectedError,
  evidenceKind,
  type ArtifactEvidence,
  type ArtifactSnapshot,
  type PublishArtifactHook,
  type PublishArtifactRequest,
  type PublishedArtifact,
} from "../acp";
import {
  beginArtifactAttempt,
  requestArtifactAttachment,
  artifactAttachmentRequested,
  completeArtifactAttempt,
  enqueueOutboxOnce,
  getArtifact,
  immediate,
  markArtifact,
  saveArtifact,
} from "../db";
import { EvidenceRejectedError, type EvidenceStore } from "../evidence";
import type { LinearFileTransfer, PreparedLinearUpload } from "../linear";

export function createLinearArtifactReader(options: { db: Database; secretsDir: string }) {
  return async (
    id: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: string; displayName: string } | null> => {
    signal?.throwIfAborted();
    if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) return null;
    const artifact = getArtifact(options.db, id);
    if (artifact === null) return null;
    const directory = join(options.secretsDir, "linear-artifacts");
    for (const path of [options.secretsDir, directory]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new Error("Artifact storage must be a private directory");
    }
    const bytes = await readPrivate(join(directory, `${artifact.id}.bytes`), 10 * 1024 * 1024);
    signal?.throwIfAborted();
    if (bytes.byteLength !== artifact.sizeBytes || digest(bytes) !== artifact.sha256)
      throw new Error("Artifact snapshot integrity check failed");
    return { bytes, mimeType: artifact.mimeType, displayName: artifact.displayName };
  };
}

export function createLinearArtifactPublisher(options: {
  db: Database;
  files: LinearFileTransfer;
  secretsDir: string;
  itemId: string;
  issueId?: string;
  sessionId: string;
  /** Closeout videos and screenshots stay in Paws and Linear gets `<publicUrl>/evidence/<id>`. */
  evidence?: { store: EvidenceStore; publicUrl: string };
  now?: () => number;
}): PublishArtifactHook {
  const now = options.now ?? Date.now;
  const generation =
    options.db
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM outbox_session_fence WHERE target = 'linear' AND ordering_key = ?",
      )
      .get(options.sessionId)?.generation ?? 0;
  const inflight = new Map<string, Promise<PublishedArtifact>>();
  return {
    begin(request, context) {
      context.signal.throwIfAborted();
      // Evidence is not a requested deliverable, so a refused file must not hold the run.
      if (evidenceKind(request) !== null) return { complete() {} };
      const identityHash = publicationIdentity(request);
      if (request.attachToIssue === true && !options.issueId)
        throw new Error("Issue attachment is unavailable");
      const version = immediate(options.db, () => {
        const nextVersion = beginArtifactAttempt(options.db, options.itemId, identityHash);
        if (request.attachToIssue === true)
          requestArtifactAttachment(options.db, options.itemId, identityHash);
        return nextVersion;
      });
      return {
        complete() {
          completeArtifactAttempt(options.db, options.itemId, identityHash, version);
        },
      };
    },
    publish(artifact, context) {
      if (artifact.evidence)
        return publishEvidence(artifact, artifact.evidence, context.runId, context.signal);
      const key = JSON.stringify([
        artifact.path,
        artifact.displayName,
        artifact.mimeType,
        artifact.sha256,
      ]);
      const existing = inflight.get(key);
      if (existing) return existing;
      const pending = publish(
        artifact,
        context.runId,
        context.signal,
        publicationIdentity(context.request ?? { path: artifact.path }),
      ).finally(() => inflight.delete(key));
      inflight.set(key, pending);
      return pending;
    },
  };

  async function publishEvidence(
    artifact: ArtifactSnapshot,
    evidence: ArtifactEvidence,
    runId: string,
    signal: AbortSignal,
  ): Promise<PublishedArtifact> {
    signal.throwIfAborted();
    if (!options.evidence)
      throw new ArtifactRejectedError(
        "Paws cannot keep Closeout evidence without a public URL. Publish the file without checkId.",
      );
    let stored;
    try {
      stored = await options.evidence.store.save({
        itemId: options.itemId,
        runId,
        checkId: evidence.checkId,
        attempt: evidence.attempt,
        displayName: artifact.displayName,
        headCommit: evidence.headCommit,
        source: artifact.bytes,
      });
    } catch (error) {
      if (error instanceof EvidenceRejectedError) throw new ArtifactRejectedError(error.message);
      throw error;
    }
    if (stored.sha256 !== artifact.sha256 || stored.sizeBytes !== artifact.sizeBytes)
      throw new Error("Artifact snapshot integrity check failed");
    signal.throwIfAborted();
    const url = `${options.evidence.publicUrl.replace(/\/+$/, "")}/evidence/${stored.id}`;
    const label = stored.displayName.replace(/[\\[\]]/g, "\\$&");
    const check = evidence.checkId.replace(/`/g, "'");
    const kind = stored.mediaType.startsWith("video/") ? "Video" : "Screenshot";
    enqueueOutboxOnce(options.db, {
      target: "linear",
      op: "activity",
      delivery: "ordered",
      priority: 0,
      orderingKey: options.sessionId,
      idempotencyKey: `evidence:${options.sessionId}:${generation}:${stored.id}`,
      generation,
      now: now(),
      payload: {
        id: randomUUID(),
        sessionId: options.sessionId,
        kind: "thought",
        body: `${kind} for Closeout check \`${check}\`, attempt ${stored.attempt}: [${label}](<${url}>)`,
      },
    });
    return { url, displayName: stored.displayName };
  }

  async function publish(
    artifact: ArtifactSnapshot,
    runId: string,
    signal: AbortSignal,
    identityHash: string,
  ): Promise<PublishedArtifact> {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await artifact.bytes.arrayBuffer());
    if (
      bytes.byteLength > 10 * 1024 * 1024 ||
      bytes.byteLength !== artifact.sizeBytes ||
      digest(bytes) !== artifact.sha256
    ) {
      throw new Error("Artifact snapshot is invalid");
    }
    await guardDirectory(options.secretsDir);
    const directory = join(options.secretsDir, "linear-artifacts");
    await guardDirectory(directory);
    const row = saveArtifact(
      options.db,
      {
        id: randomUUID(),
        identityHash,
        itemId: options.itemId,
        runId,
        path: artifact.path,
        displayName: artifact.displayName,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        state: "pending",
        assetUrl: null,
      },
      now(),
    );
    const snapshotPath = join(directory, `${row.id}.bytes`);
    try {
      await readPrivate(snapshotPath, 10 * 1024 * 1024);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await writeAtomic(snapshotPath, bytes);
    }
    const persisted = await readPrivate(snapshotPath, 10 * 1024 * 1024);
    if (digest(persisted) !== row.sha256 || persisted.byteLength !== row.sizeBytes) {
      throw new Error("Artifact snapshot integrity check failed");
    }
    const manifestPath = join(directory, `${row.id}.upload`);
    let assetUrl = row.assetUrl;
    if (assetUrl === null) {
      try {
        let upload: PreparedLinearUpload | null = null;
        try {
          upload = JSON.parse(new TextDecoder().decode(await readPrivate(manifestPath, 64 * 1024)));
        } catch (error) {
          if (!isMissing(error))
            throw new Error("Artifact upload state is invalid", { cause: error });
        }
        let remoteMissing = false;
        if (upload !== null) {
          if (
            upload.filename !== row.displayName ||
            upload.contentType !== row.mimeType ||
            upload.size !== row.sizeBytes
          ) {
            throw new Error("Artifact upload state does not match the snapshot");
          }
          try {
            const remote = await options.files.download({ url: upload.assetUrl, signal });
            if (digest(remote.bytes) === row.sha256) assetUrl = upload.assetUrl;
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error;
            remoteMissing = true;
          }
        }
        if (assetUrl === null) {
          if (upload === null) {
            upload = await options.files.prepareUpload({
              filename: row.displayName,
              contentType: row.mimeType,
              size: row.sizeBytes,
              signal,
            });
            await writeManifest(manifestPath, upload);
          }
          try {
            assetUrl = (await options.files.uploadPrepared({ upload, bytes: persisted, signal }))
              .assetUrl;
          } catch (error) {
            signal.throwIfAborted();
            if (!remoteMissing || !(error instanceof Error) || !error.message.includes("HTTP 403"))
              throw error;
            upload = await options.files.prepareUpload({
              filename: row.displayName,
              contentType: row.mimeType,
              size: row.sizeBytes,
              signal,
            });
            await writeManifest(manifestPath, upload);
            assetUrl = (await options.files.uploadPrepared({ upload, bytes: persisted, signal }))
              .assetUrl;
          }
        }
        const url = new URL(assetUrl);
        if (
          url.origin !== "https://uploads.linear.app" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          throw new Error("Artifact upload returned an invalid asset URL");
        }
      } catch (error) {
        markArtifact(options.db, row.id, null);
        throw error;
      }
    }
    signal.throwIfAborted();
    const label = row.displayName.replace(/[\\[\]]/g, "\\$&");
    const body = `${row.mimeType.startsWith("image/") ? "!" : ""}[${label}](<${assetUrl}>)`;
    immediate(options.db, () => {
      markArtifact(options.db, row.id, assetUrl);
      if (artifactAttachmentRequested(options.db, options.itemId, identityHash)) {
        if (!options.issueId) throw new Error("Issue attachment is unavailable");
        enqueueOutboxOnce(options.db, {
          target: "linear",
          op: "linear.attachment",
          delivery: "ordered",
          priority: 0,
          orderingKey: options.sessionId,
          idempotencyKey: `artifact-card:${options.sessionId}:${generation}:${row.id}`,
          generation,
          now: now(),
          payload: {
            id: row.id,
            itemId: options.itemId,
            issueId: options.issueId,
            title: row.displayName,
            url: assetUrl,
          },
        });
      }
      enqueueOutboxOnce(options.db, {
        target: "linear",
        op: "activity",
        delivery: "ordered",
        priority: 0,
        orderingKey: options.sessionId,
        idempotencyKey: `artifact:${options.sessionId}:${generation}:${row.id}`,
        generation,
        now: now(),
        payload: { id: row.id, sessionId: options.sessionId, kind: "thought", body },
      });
    });
    return { url: assetUrl, displayName: row.displayName };
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function guardDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Artifact storage must be a private directory");
  await chmod(path, 0o700);
}

async function writeSnapshot(path: string, bytes: Uint8Array): Promise<void> {
  let file;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return;
    throw error;
  }
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readPrivate(path: string, limit: number): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > limit)
      throw new Error("Artifact storage file is invalid");
    return new Uint8Array(await file.readFile());
  } finally {
    await file.close();
  }
}

async function writeManifest(path: string, upload: PreparedLinearUpload): Promise<void> {
  await writeAtomic(path, new TextEncoder().encode(JSON.stringify(upload)));
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeSnapshot(temporary, bytes);
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function publicationIdentity(request: PublishArtifactRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        request.displayName === undefined
          ? ["path", request.path]
          : ["displayName", request.displayName],
      ),
    )
    .digest("hex");
}
