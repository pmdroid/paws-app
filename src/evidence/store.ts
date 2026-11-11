import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { saveEvidenceObjectSteps, saveEvidenceSteps, type StoredEvidence, type Db } from "../db";
import { mediaKind, sniffMedia, SNIFF_BYTES } from "./media";
import {
  evidenceObjectPrefix,
  removeEvidenceChunks,
  writeEvidenceChunks,
  type EvidenceObjects,
} from "./objects";
import { ulid } from "./ulid";

export type EvidenceLimits = { video: number; image: number };

export const EVIDENCE_LIMITS: EvidenceLimits = {
  video: 200 * 1024 * 1024,
  image: 20 * 1024 * 1024,
};

export type EvidenceInput = {
  itemId: string;
  runId: string;
  checkId: string;
  attempt: number;
  displayName: string;
  headCommit: string;
  source: Blob;
};

export type EvidenceStoreOptions = {
  store: Db;
  root: string;
  objects?: EvidenceObjects;
  limits?: EvidenceLimits;
  now?: () => number;
};

export type EvidenceStore = {
  readonly root: string;
  save(input: EvidenceInput): Promise<StoredEvidence>;
};

export class EvidenceRejectedError extends Error {
  constructor(
    readonly reason: "type" | "size" | "input",
    message: string,
  ) {
    super(message);
    this.name = "EvidenceRejectedError";
  }
}

export function evidencePath(root: string, id: string): string {
  return join(root, id);
}

export function createEvidenceStore(options: EvidenceStoreOptions): EvidenceStore {
  const store = options.store;
  const limits = options.limits ?? EVIDENCE_LIMITS;
  const now = options.now ?? Date.now;
  const largest = Math.max(limits.video, limits.image);
  return {
    root: options.root,
    async save(input) {
      checkInput(input);
      if (input.source.size === 0) throw new EvidenceRejectedError("type", "The file is empty.");
      if (input.source.size > largest) throw tooLarge(largest);
      const createdAt = now();
      const id = ulid(createdAt);
      const hash = createHash("sha256");
      const head = new Uint8Array(SNIFF_BYTES);
      let headLength = 0;
      let size = 0;
      async function* checked() {
        for await (const chunk of input.source.stream()) {
          size += chunk.byteLength;
          if (size > largest) throw tooLarge(largest);
          if (headLength < SNIFF_BYTES) {
            const take = chunk.subarray(0, SNIFF_BYTES - headLength);
            head.set(take, headLength);
            headLength += take.byteLength;
          }
          hash.update(chunk);
          yield chunk;
        }
      }
      const verified = (): StoredEvidence => {
        const mediaType = sniffMedia(head.subarray(0, headLength));
        if (mediaType === null)
          throw new EvidenceRejectedError(
            "type",
            "Only WebM and MP4 videos and PNG, JPEG and WebP images are accepted.",
          );
        if (size === 0) throw new EvidenceRejectedError("type", "The file is empty.");
        if (size > limits[mediaKind(mediaType)]) throw tooLarge(limits[mediaKind(mediaType)]);
        return {
          id,
          itemId: input.itemId,
          runId: input.runId,
          checkId: input.checkId,
          attempt: input.attempt,
          mediaType,
          sizeBytes: size,
          sha256: hash.digest("hex"),
          displayName: input.displayName,
          headCommit: input.headCommit.toLowerCase(),
          createdAt,
        };
      };
      const objects = options.objects?.();
      if (objects) {
        const prefix = evidenceObjectPrefix(input, id);
        const sizeBytes = await writeEvidenceChunks(objects, prefix, checked());
        try {
          const evidence = verified();
          await store.transaction(function* (q) {
            yield* saveEvidenceSteps(q, evidence);
            yield* saveEvidenceObjectSteps(q, { id, prefix, sizeBytes, storedAt: createdAt });
          });
          return evidence;
        } catch (error) {
          await removeEvidenceChunks(objects, prefix, sizeBytes);
          throw error;
        }
      }
      await mkdir(options.root, { recursive: true, mode: 0o700 });
      await chmod(options.root, 0o700);
      const partial = join(options.root, `.${id}.part`);
      const target = evidencePath(options.root, id);
      const file = await open(partial, "wx", 0o600);
      try {
        try {
          for await (const chunk of checked()) await file.write(chunk);
          await file.sync();
        } finally {
          await file.close();
        }
        const evidence = verified();
        await chmod(partial, 0o600);
        await rename(partial, target);
        try {
          await store.run((q) => saveEvidenceSteps(q, evidence));
        } catch (error) {
          await rm(target, { force: true });
          throw error;
        }
        return evidence;
      } finally {
        await rm(partial, { force: true });
      }
    },
  };
}

function checkInput(input: EvidenceInput): void {
  if (input.itemId.length === 0 || input.runId.length === 0 || input.checkId.length === 0)
    throw new EvidenceRejectedError("input", "Evidence needs a work item, run and check.");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
    throw new EvidenceRejectedError("input", "The attempt must be a positive integer.");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(input.headCommit))
    throw new EvidenceRejectedError("input", "The head commit must be a full commit hash.");
  if (
    input.displayName.length === 0 ||
    input.displayName.length > 255 ||
    [...input.displayName].some((char) => char.charCodeAt(0) < 0x20 || char === "\x7f")
  )
    throw new EvidenceRejectedError(
      "input",
      "The display name must be 1 to 255 printable characters.",
    );
}

function tooLarge(limit: number): EvidenceRejectedError {
  return new EvidenceRejectedError(
    "size",
    `The file is larger than ${Math.floor(limit / (1024 * 1024))} MB.`,
  );
}
