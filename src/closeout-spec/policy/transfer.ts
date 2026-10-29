import { journalCaught } from "../../journal";
import { z } from "zod";
import type { PolicyFilesLoad } from "./load";
import { POLICY_MAX_BYTES } from "./resolve";
import type { PublishedEvidence } from "../types";

const MAX_FILES = 128;
/** Base64 bytes of one policy file. A whole SKILL.md can pass a few hundred KB. */
const MAX_FILE_BASE64 = 4 * 1024 * 1024;
const MAX_PUBLISHED = 200;

const Transfer = z.union([
  z.strictObject({ absent: z.literal(true) }),
  z.strictObject({ error: z.string().min(1).max(4096) }),
  z.strictObject({
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    files: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(1024),
          data: z.string().max(MAX_FILE_BASE64),
        }),
      )
      .min(1)
      .max(MAX_FILES),
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

export function encodePolicyFiles(load: PolicyFilesLoad): string {
  if (!load.ok)
    return JSON.stringify({ error: load.message.slice(0, 4096) || "policy unavailable" });
  if (load.absent) return JSON.stringify({ absent: true });
  const size = [...load.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0);
  if (load.files.size > MAX_FILES || size > POLICY_MAX_BYTES)
    return JSON.stringify({ error: "The Closeout policy is too large to send to the runner" });
  return JSON.stringify({
    digest: load.digest,
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
    ...(published ? { published } : {}),
  };
}
