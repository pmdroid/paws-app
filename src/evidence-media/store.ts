import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { insertEvidence, type EvidenceRow } from "../db";
import { ulid } from "../intake";
import { isVideo, sniffMediaType, SNIFF_BYTES } from "./sniff";

export type EvidenceLimits = {
  videoBytes: number;
  imageBytes: number;
};

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  videoBytes: 200 * 1024 * 1024,
  imageBytes: 20 * 1024 * 1024,
};

export type SaveEvidence = {
  itemId: string;
  runId: string;
  checkId: string;
  attempt: number;
  displayName: string;
  headCommit: string;
  /** The video or image, read as a stream. */
  file: Bun.BunFile;
};

export type EvidenceRefusal = "type" | "size" | "input";

export class EvidenceRefusedError extends Error {
  constructor(
    readonly reason: EvidenceRefusal,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceRefusedError";
  }
}

export type EvidenceMediaStoreOptions = {
  db: Database;
  /** `~/.paws/evidence`. Tests pass a temporary directory. */
  dir: string;
  limits?: EvidenceLimits;
  now?: () => number;
};

export type EvidenceMediaStore = {
  readonly dir: string;
  /** Write the file (0600, directory 0700) and its `evidence` row. Throws `EvidenceRefusedError`. */
  save(input: SaveEvidence): Promise<EvidenceRow>;
};

const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Stored file for an evidence id, or null when the id is not a ULID. */
export function evidenceFile(dir: string, id: string): string | null {
  return ID.test(id) ? join(dir, id) : null;
}

export function createEvidenceMediaStore(options: EvidenceMediaStoreOptions): EvidenceMediaStore {
  const limits = options.limits ?? DEFAULT_EVIDENCE_LIMITS;
  const now = options.now ?? Date.now;
  const dir = options.dir;

  return {
    dir,
    async save(input) {
      const fields = checkInput(input);
      const size = input.file.size;
      if (size === 0) throw new EvidenceRefusedError("type", "Evidence file is empty.");
      if (size > Math.max(limits.videoBytes, limits.imageBytes))
        throw new EvidenceRefusedError("size", "Evidence file is over the size cap.");
      const head = new Uint8Array(await input.file.slice(0, SNIFF_BYTES).arrayBuffer());
      const mediaType = sniffMediaType(head);
      if (mediaType === null)
        throw new EvidenceRefusedError(
          "type",
          "Evidence must be a WebM or MP4 video or a PNG, JPEG or WebP image.",
        );
      if (size > (isVideo(mediaType) ? limits.videoBytes : limits.imageBytes))
        throw new EvidenceRefusedError("size", "Evidence file is over the size cap.");

      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const createdAt = now();
      const id = ulid(createdAt);
      const target = join(dir, id);
      const partial = join(dir, `.${id}.partial`);
      const hash = createHash("sha256");
      let written = 0;
      try {
        const handle = await open(partial, "wx", 0o600);
        try {
          for await (const chunk of input.file.stream()) {
            hash.update(chunk);
            written += chunk.byteLength;
            await handle.write(chunk);
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (written !== size) throw new Error("Evidence file changed while it was stored.");
        await chmod(partial, 0o600);
        await rename(partial, target);
        const row: EvidenceRow = {
          id,
          ...fields,
          mediaType,
          sizeBytes: written,
          sha256: hash.digest("hex"),
          createdAt,
        };
        insertEvidence(options.db, row);
        return row;
      } catch (error) {
        await rm(partial, { force: true });
        await rm(target, { force: true });
        throw error;
      }
    },
  };
}

function checkInput(
  input: SaveEvidence,
): Omit<EvidenceRow, "id" | "mediaType" | "sizeBytes" | "sha256" | "createdAt"> {
  if (!Number.isInteger(input.attempt) || input.attempt < 1)
    throw new EvidenceRefusedError("input", "Evidence attempt must be a positive integer.");
  if (!HEAD.test(input.headCommit))
    throw new EvidenceRefusedError("input", "Evidence head commit must be a full commit id.");
  for (const value of [input.itemId, input.runId, input.checkId])
    if (value.length === 0 || value.length > 200)
      throw new EvidenceRefusedError("input", "Evidence item, run and check ids are required.");
  const displayName = [...input.displayName]
    .filter((char) => char >= " " && char !== "\u007f")
    .join("")
    .trim()
    .slice(0, 200);
  if (displayName.length === 0)
    throw new EvidenceRefusedError("input", "Evidence display name is required.");
  return {
    itemId: input.itemId,
    runId: input.runId,
    checkId: input.checkId,
    attempt: input.attempt,
    displayName,
    headCommit: input.headCommit,
  };
}
