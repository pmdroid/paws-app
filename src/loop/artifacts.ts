import { journalCaught } from "../journal";
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
  linearSessionGenerationSteps,
  beginArtifactAttemptSteps,
  requestArtifactAttachmentSteps,
  artifactAttachmentRequestedSteps,
  completeArtifactAttemptSteps,
  enqueueOutboxOnceSteps,
  getArtifactSteps,
  getEvidenceSteps,
  latestEvidence,
  listEvidenceSteps,
  markArtifactSteps,
  saveArtifactSteps,
  settled,
  sqliteDb,
  type Db,
  type Q,
  type Steps,
} from "../db";
import type { StoredEvidence, WorkItemRecord } from "../db";
import type { LinearFileTransfer, PreparedLinearUpload } from "../linear";
import type { PublishedEvidence } from "../closeout";
import { pawsIssueUrl } from "./open-findings";
import { rejectedEvidenceIdsSteps } from "../questions";

export function createLinearArtifactReader(options: { db: Database; secretsDir: string }) {
  const store = sqliteDb(options.db);
  return async (
    id: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mimeType: string; displayName: string } | null> => {
    signal?.throwIfAborted();
    if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) return null;
    const artifact = await store.run((q) => getArtifactSteps(q, id));
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
  return settled(sqliteDb(db).run((q) => publishedEvidenceSteps(q, itemId)));
}

export function* publishedEvidenceSteps(q: Q, itemId: string): Steps<PublishedEvidence[]> {
  const rejected = yield* rejectedEvidenceIdsSteps(q, itemId);
  return latestEvidence(yield* listEvidenceSteps(q, itemId))
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
 * The files Closeout counts for each check: the latest per display name, without rejected ones.
 * Pull request screenshots pick their files the same way.
 */
function* evidenceFilesSteps(q: Q, itemId: string): Steps<StoredEvidence[]> {
  const rejected = yield* rejectedEvidenceIdsSteps(q, itemId);
  const latest = new Map<string, StoredEvidence>();
  for (const row of yield* listEvidenceSteps(q, itemId))
    latest.set(JSON.stringify([row.checkId, row.displayName]), row);
  return [...latest.values()].filter((row) => !rejected.has(row.id));
}

/** "16 screenshots" or "1 video and 2 screenshots". */
function evidenceCount(rows: readonly StoredEvidence[]): string {
  const videos = rows.filter((row) => row.mediaType.startsWith("video/")).length;
  const screenshots = rows.length - videos;
  return [
    ...(videos ? [`${videos} video${videos === 1 ? "" : "s"}`] : []),
    ...(screenshots ? [`${screenshots} screenshot${screenshots === 1 ? "" : "s"}`] : []),
  ].join(" and ");
}

/** The item page's evidence gallery in Paws. */
export function evidenceSectionUrl(publicUrl: string, item: WorkItemRecord): string | null {
  const page = pawsIssueUrl(publicUrl, item);
  return page && `${page}#evidence-gallery`;
}

/**
 * One thought per evidence check at `head`: "Closeout evidence for `visual-proof`: 16
 * screenshots. See them in Paws: <link>". A check without files gets none. The key names the
 * check and the head, so a later round at the same head posts nothing new. The images stay in
 * Paws and on the pull request.
 */
export async function evidenceThoughts(
  store: Db,
  input: { itemId: string; checkIds: readonly string[]; head: string; link: string },
): Promise<{ key: string; body: string }[]> {
  const files = await store.run((q) => evidenceFilesSteps(q, input.itemId));
  return input.checkIds.flatMap((checkId) => {
    const rows = files.filter((row) => row.checkId === checkId);
    if (rows.length === 0) return [];
    return [
      {
        key: `${input.itemId}:evidence:${checkId}:${input.head}`,
        body: `Closeout evidence for \`${checkId}\`: ${evidenceCount(rows)}. See them in Paws: ${input.link}`,
      },
    ];
  });
}

/**
 * The one "Closeout evidence" card on the issue, linking to the item's evidence in Paws. One row
 * per head: Linear updates the attachment with the same URL on the same issue, so a new head
 * changes the subtitle ("16 screenshots at b7c55c8") and adds no card.
 */
export async function enqueueEvidenceCard(
  store: Db,
  input: {
    sessionId: string;
    generation: number;
    item: WorkItemRecord;
    link: string;
    head: string;
    now: number;
  },
): Promise<void> {
  await store.transaction(function* (q) {
    const rows = yield* evidenceFilesSteps(q, input.item.id);
    if (rows.length === 0) return;
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "linear.attachment",
      delivery: "ordered",
      priority: 0,
      orderingKey: input.sessionId,
      generation: input.generation,
      idempotencyKey: `evidence-card:${input.sessionId}:${input.generation}:${input.head}`,
      payload: {
        id: randomUUID(),
        itemId: input.item.id,
        issueId: input.item.linearIssueId,
        title: "Closeout evidence",
        subtitle: `${evidenceCount(rows)} at ${input.head.slice(0, 7)}`,
        url: input.link,
        evidence: true,
      },
      now: input.now,
    });
  });
}

/**
 * Keeps a video or screenshot published with a Closeout check id in the evidence store. Nothing
 * is posted per file: Closeout posts one thought per check, and one card after the PR response.
 * With `uploads`, a file of a visual review check within `EVIDENCE_INLINE_LIMITS` is uploaded to
 * Linear (`linear.evidence`) so the review question can embed it.
 * Every other artifact goes to `linear`, unchanged.
 */
export async function createEvidenceArtifactPublisher(options: {
  store: Db;
  evidence: EvidenceSink;
  publicUrl: string;
  itemId: string;
  sessionId: string;
  /** Upload evidence to Linear. The outbox handler needs the Linear file transfer. */
  uploads?: boolean;
  reviewed?: (checkId: string) => boolean;
  linear?: PublishArtifactHook;
  now?: () => number;
}): Promise<PublishArtifactHook> {
  const now = options.now ?? Date.now;
  const store = options.store;
  const generation = await store.run((q) => linearSessionGenerationSteps(q, options.sessionId));
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
          (await store.run((q) => listEvidenceSteps(q, options.itemId))).find(
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
        const row = await store.run((q) => getEvidenceSteps(q, stored.id));
        const kind = row?.mediaType.startsWith("video/") ? "video" : "image";
        const inline = row !== null && row.sizeBytes <= EVIDENCE_INLINE_LIMITS[kind];
        if (inline && options.uploads && (options.reviewed?.(evidence.checkId) ?? false))
          await store.transaction((q) =>
            enqueueOutboxOnceSteps(q, {
              target: "linear",
              op: "linear.evidence",
              delivery: "ordered",
              priority: 0,
              orderingKey: options.sessionId,
              idempotencyKey: `evidence:${options.sessionId}:${generation}:${stored.id}`,
              generation,
              now: now(),
              payload: { evidenceId: stored.id, checkId: evidence.checkId, link: url },
            }),
          );
        return { url, displayName: artifact.displayName };
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
      return pending;
    },
  };
}

export async function createLinearArtifactPublisher(options: {
  store: Db;
  files: LinearFileTransfer;
  secretsDir: string;
  itemId: string;
  issueId?: string;
  sessionId: string;
  now?: () => number;
}): Promise<PublishArtifactHook> {
  const now = options.now ?? Date.now;
  const store = options.store;
  const generation = await store.run((q) => linearSessionGenerationSteps(q, options.sessionId));
  const inflight = new Map<string, Promise<PublishedArtifact>>();
  return {
    begin(request, context) {
      context.signal.throwIfAborted();
      const identityHash = publicationIdentity(request);
      if (request.attachToIssue === true && !options.issueId)
        throw new Error("Issue attachment is unavailable");
      const version = settled(
        store.transaction(function* (q) {
          const nextVersion = yield* beginArtifactAttemptSteps(q, options.itemId, identityHash);
          if (request.attachToIssue === true)
            yield* requestArtifactAttachmentSteps(q, options.itemId, identityHash);
          return nextVersion;
        }),
      );
      return {
        complete() {
          settled(
            store.run((q) =>
              completeArtifactAttemptSteps(q, options.itemId, identityHash, version),
            ),
          );
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
    const row = await store.run((q) =>
      saveArtifactSteps(
        q,
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
      ),
    );
    const snapshotPath = join(directory, `${row.id}.bytes`);
    try {
      await readPrivate(snapshotPath, 10 * 1024 * 1024);
    } catch (error) {
      if (!isMissing(error)) throw error;
      journalCaught(
        error,
        "artifacts.publish.readPrivate",
        options.itemId,
        "optional file may be absent",
      );
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
          journalCaught(
            error,
            "artifacts.publish.parse",
            options.itemId,
            "optional file may be absent",
          );
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
            journalCaught(error, "artifacts.publish.download", options.itemId);
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
            journalCaught(error, "artifacts.publish.uploadPrepared", options.itemId);
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
        await store.run((q) => markArtifactSteps(q, row.id, null));
        throw error;
      }
    }
    signal.throwIfAborted();
    const label = row.displayName.replace(/[\\[\]]/g, "\\$&");
    const body = `${row.mimeType.startsWith("image/") ? "!" : ""}[${label}](<${assetUrl}>)`;
    const uploaded = assetUrl;
    await store.transaction(function* (q) {
      yield* markArtifactSteps(q, row.id, uploaded);
      if (yield* artifactAttachmentRequestedSteps(q, options.itemId, identityHash)) {
        if (!options.issueId) throw new Error("Issue attachment is unavailable");
        yield* enqueueOutboxOnceSteps(q, {
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
            url: uploaded,
          },
        });
      }
      yield* enqueueOutboxOnceSteps(q, {
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
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      journalCaught(error, "artifacts.writeSnapshot.open", null, "path may already exist");
      return;
    }
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
    await unlink(temporary).catch((caughtError1) => {
      journalCaught(
        caughtError1,
        "artifacts.writeAtomic.unlink",
        null,
        "optional file may be absent",
      );
    });
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
