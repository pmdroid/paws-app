import { journalCaught } from "../../journal";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { PolicyFilesLoad } from "./load";
import { POLICY_MAX_BYTES } from "./resolve";
import type { PublishedEvidence } from "../types";

const MAX_FILES = 128;
const MAX_PUBLISHED = 200;
const MAX_TRANSFER = 8 * 1024 * 1024;
// The answer contains JSON inside JSON, so leave room for escaping as well as metadata.
const CHUNK_SIZE = 24_000;

const Transfer = z.union([
  z.strictObject({ absent: z.literal(true) }),
  z.strictObject({ error: z.string().min(1).max(4096) }),
  z.strictObject({
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    files: z
      .array(
        z.strictObject({ path: z.string().min(1).max(1024), data: z.string().max(MAX_TRANSFER) }),
      )
      .min(1)
      .max(MAX_FILES),
    acceptedPreviews: z
      .array(
        z.strictObject({
          checkId: z.string().min(1).max(256),
          commit: z.string().regex(/^[a-f0-9]{40}$/),
        }),
      )
      .max(MAX_PUBLISHED)
      .optional(),
    published: z
      .array(
        z.strictObject({
          checkId: z.string().min(1).max(256),
          media: z.enum(["image", "video"]),
          commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        }),
      )
      .max(MAX_PUBLISHED)
      .optional(),
  }),
]);

export function encodePolicyFiles(load: PolicyFilesLoad, chunked = false): string {
  if (!load.ok)
    return JSON.stringify({ error: load.message.slice(0, 4096) || "policy unavailable" });
  if (load.absent) return JSON.stringify({ absent: true });
  const size = [...load.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
  if (load.files.size > MAX_FILES || size > (chunked ? MAX_TRANSFER / 2 : POLICY_MAX_BYTES))
    return JSON.stringify({ error: "The Closeout policy is too large to send to the runner" });
  return JSON.stringify({
    digest: load.digest,
    ...(load.acceptedPreviews?.length
      ? { acceptedPreviews: load.acceptedPreviews.slice(-MAX_PUBLISHED) }
      : {}),
    files: [...load.files].map(([path, bytes]) => ({
      path,
      data: Buffer.from(bytes).toString("base64"),
    })),
    ...(load.published
      ? {
          published: load.published
            .slice(-MAX_PUBLISHED)
            .map(({ checkId, media, commit }) => ({ checkId, media, commit })),
        }
      : {}),
  });
}

export function decodePolicyFiles(text: string): PolicyFilesLoad {
  if (text.length > MAX_TRANSFER)
    return { ok: false, message: "Paws sent an invalid Closeout policy" };
  let parsed: z.infer<typeof Transfer>;
  try {
    parsed = Transfer.parse(JSON.parse(text));
  } catch (caughtError1) {
    journalCaught(caughtError1, "transfer.decodePolicyFiles.parse", null);
    return { ok: false, message: "Paws sent an invalid Closeout policy" };
  }
  if ("absent" in parsed) return { ok: true, absent: true };
  if ("error" in parsed) return { ok: false, message: parsed.error };
  const files = new Map(
    parsed.files.map((file) => [file.path, new Uint8Array(Buffer.from(file.data, "base64"))]),
  );
  if (files.size !== parsed.files.length)
    return { ok: false, message: "Paws sent an invalid Closeout policy" };
  const published: PublishedEvidence[] | undefined = parsed.published;
  return {
    ok: true,
    absent: false,
    digest: parsed.digest,
    files,
    ...(parsed.acceptedPreviews ? { acceptedPreviews: parsed.acceptedPreviews } : {}),
    ...(published ? { published } : {}),
  };
}

/** One bounded answer from a stable serialized policy; legacy requests use encodePolicyFiles. */
export function encodePolicyChunk(
  load: PolicyFilesLoad,
  offset: number,
  expected?: string,
): string {
  const text = encodePolicyFiles(load, true);
  const hash = createHash("sha256").update(text).digest("hex");
  if ((expected !== undefined && expected !== hash) || offset > text.length)
    return JSON.stringify({ error: "Closeout policy changed during transfer" });
  return JSON.stringify({
    hash,
    offset,
    total: text.length,
    data: text.slice(offset, offset + CHUNK_SIZE),
  });
}

export function decodePolicyChunk(
  text: string,
): { hash: string; offset: number; total: number; data: string } | null {
  try {
    return z
      .strictObject({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        offset: z.number().int().min(0).max(MAX_TRANSFER),
        total: z.number().int().min(1).max(MAX_TRANSFER),
        data: z.string().min(1).max(CHUNK_SIZE),
      })
      .parse(JSON.parse(text));
  } catch {
    return null;
  }
}
