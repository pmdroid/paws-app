import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ArtifactSnapshot,
  PublishArtifactHook,
  PublishArtifactRequest,
  PublishedArtifact,
} from "../acp";
import {
  beginArtifactAttempt,
  requestArtifactAttachment,
  artifactAttachmentRequested,
  completeArtifactAttempt,
  enqueueOutboxOnce,
  getArtifact,
  getEvidence,
  immediate,
  latestEvidence,
  listEvidence,
  markArtifact,
  saveArtifact,
} from "../db";
import type { LinearFileTransfer, PreparedLinearUpload } from "../linear";
import type { PublishedEvidence } from "../closeout";
import { canReportProgress } from "./activity-policy";
import { rejectedEvidenceIds } from "../questions";

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

export function publishedEvidence(db: Database, itemId: string): PublishedEvidence[] {
  const rejected = rejectedEvidenceIds(db, itemId);
  return latestEvidence(listEvidence(db, itemId))
    .filter((row) => !rejected.has(row.id))
    .map((row) => ({
      id: row.id,
      checkId: row.checkId,
      media: row.mediaType.startsWith("video/") ? "video" : "image",
      commit: row.headCommit,
    }));
}

/** Where Closeout videos and screenshots go. `src/index.ts` passes the evidence store. */
export type EvidenceSink = {
  save(input: {
    itemId: string;
    runId: string;
    checkId: string;
    attempt: number;
    displayName: string;
    headCommit: string;
    source: Blob;
  }): Promise<{ id: string }>;
};

const MB = 1024 * 1024;

/** The largest evidence files Paws uploads to Linear. Larger ones keep only the Paws link. */
export const EVIDENCE_INLINE_LIMITS = { image: 10 * MB, video: 50 * MB };

/**
 * The Linear activity for one Closeout video or screenshot: the embedded upload when there is
 * one, then the Paws link, then an optional note.
 */
export function evidenceActivityBody(input: {
  checkId: string;
  displayName: string;
  link: string;
  assetUrl?: string;
  note?: string;
}): string {
  const label = input.displayName.replace(/[\\[\]]/g, "\\$&");
  const heading = `Closeout evidence for check \`${input.checkId}\``;
  const lines =
    input.assetUrl === undefined
      ? [`${heading}: [${label}](<${input.link}>)`]
      : [`${heading}:`, `![${label}](<${input.assetUrl}>)`, `In Paws: [${label}](<${input.link}>)`];
  return [...lines, ...(input.note === undefined ? [] : [input.note])].join("\n\n");
}

/**
 * Keeps a video or screenshot published with a Closeout check id in the evidence store and
 * posts it to Linear. With `uploads`, files within `EVIDENCE_INLINE_LIMITS` go out as a
 * `linear.evidence` outbox row that uploads the file and embeds it; others get the Paws link.
 * Every other artifact goes to `linear`, unchanged.
 */
export function createEvidenceArtifactPublisher(options: {
  db: Database;
  evidence: EvidenceSink;
  publicUrl: string;
  itemId: string;
  sessionId: string;
  /** Upload evidence to Linear. The outbox handler needs the Linear file transfer. */
  uploads?: boolean;
  reviewed?: (checkId: string) => boolean;
  linear?: PublishArtifactHook;
  now?: () => number;
}): PublishArtifactHook {
  const now = options.now ?? Date.now;
  const generation = sessionGeneration(options.db, options.sessionId);
  const inflight = new Map<string, Promise<PublishedArtifact>>();
  return {
    begin(request, context) {
      if (context.evidence) return { complete() {} };
      if (!options.linear) throw new Error("Linear file uploads are unavailable");
      return options.linear.begin?.(request, context) ?? { complete() {} };
    },
    publish(artifact, context) {
      const evidence = context.evidence;
      if (!evidence)
        return options.linear
          ? options.linear.publish(artifact, context)
          : Promise.reject(new Error("Linear file uploads are unavailable"));
      const key = JSON.stringify([
        context.runId,
        evidence.checkId,
        evidence.attempt,
        evidence.headCommit,
        artifact.displayName,
        artifact.sha256,
      ]);
      const existing = inflight.get(key);
      if (existing) return existing;
      const pending = (async (): Promise<PublishedArtifact> => {
        context.signal.throwIfAborted();
        const stored =
          listEvidence(options.db, options.itemId).find(
            (row) =>
              row.runId === context.runId &&
              row.checkId === evidence.checkId &&
              row.attempt === evidence.attempt &&
              row.headCommit === evidence.headCommit &&
              row.displayName === artifact.displayName &&
              row.sha256 === artifact.sha256,
          ) ??
          (await options.evidence.save({
            itemId: options.itemId,
            runId: context.runId,
            checkId: evidence.checkId,
            attempt: evidence.attempt,
            displayName: artifact.displayName,
            headCommit: evidence.headCommit,
            source: artifact.bytes,
          }));
        const url = `${options.publicUrl.replace(/\/+$/, "")}/evidence/${encodeURIComponent(stored.id)}`;
        const row = getEvidence(options.db, stored.id);
        const kind = row?.mediaType.startsWith("video/") ? "video" : "image";
        const inline = row !== null && row.sizeBytes <= EVIDENCE_INLINE_LIMITS[kind];
        const activity = {
          id: randomUUID(),
          sessionId: options.sessionId,
          kind: "thought",
        };
        const upload = inline && options.uploads;
        const reviewed = options.reviewed?.(evidence.checkId) ?? false;
        const quiet = !canReportProgress(options.db, options.sessionId, generation);
        if (upload || (!reviewed && !quiet))
          enqueueOutboxOnce(options.db, {
            target: "linear",
            op: upload ? "linear.evidence" : "activity",
            delivery: "ordered",
            priority: 0,
            orderingKey: options.sessionId,
            idempotencyKey: `evidence:${options.sessionId}:${generation}:${stored.id}`,
            generation,
            now: now(),
            payload: upload
              ? {
                  ...activity,
                  evidenceId: stored.id,
                  checkId: evidence.checkId,
                  link: url,
                  ...(reviewed || quiet ? { uploadOnly: true } : {}),
                }
              : {
                  ...activity,
                  body: evidenceActivityBody({
                    checkId: evidence.checkId,
                    displayName: artifact.displayName,
                    link: url,
                    ...(row !== null && !inline
                      ? {
                          note: `This ${kind} is larger than ${EVIDENCE_INLINE_LIMITS[kind] / MB} MB, so it is only in Paws.`,
                        }
                      : {}),
                  }),
                },
          });
        if (quiet)
          enqueueEvidenceAttachment(options.db, {
            sessionId: options.sessionId,
            generation,
            itemId: options.itemId,
            evidenceId: stored.id,
            title: artifact.displayName,
            url,
            headCommit: evidence.headCommit,
            now: now(),
          });
        return { url, displayName: artifact.displayName };
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
      return pending;
    },
  };
}

/** A stable outbox key lets delivery adopt evidence queued before the PR gate was installed. */
export function enqueueEvidenceAttachment(
  db: Database,
  input: {
    sessionId: string;
    generation: number;
    itemId: string;
    evidenceId: string;
    title: string;
    url: string;
    headCommit: string;
    now: number;
  },
): void {
  const item = db
    .query<{ issueId: string }, [string]>(
      "SELECT linear_issue_id AS issueId FROM work_item WHERE id=?",
    )
    .get(input.itemId);
  if (!item) throw new Error("Evidence has no work item");
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "linear.attachment",
    delivery: "ordered",
    priority: 0,
    orderingKey: input.sessionId,
    generation: input.generation,
    idempotencyKey: `evidence-card:${input.sessionId}:${input.generation}:${input.evidenceId}`,
    payload: {
      id: randomUUID(),
      itemId: input.itemId,
      issueId: item.issueId,
      title: input.title,
      url: input.url,
      evidenceId: input.evidenceId,
      headCommit: input.headCommit,
    },
    now: input.now,
  });
}

function sessionGeneration(db: Database, sessionId: string): number {
  return (
    db
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM outbox_session_fence WHERE target = 'linear' AND ordering_key = ?",
      )
      .get(sessionId)?.generation ?? 0
  );
}

export function createLinearArtifactPublisher(options: {
  db: Database;
  files: LinearFileTransfer;
  secretsDir: string;
  itemId: string;
  issueId?: string;
  sessionId: string;
  now?: () => number;
}): PublishArtifactHook {
  const now = options.now ?? Date.now;
  const generation = sessionGeneration(options.db, options.sessionId);
  const inflight = new Map<string, Promise<PublishedArtifact>>();
  return {
    begin(request, context) {
      context.signal.throwIfAborted();
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
