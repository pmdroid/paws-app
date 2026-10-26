import { z } from "zod";

/** Caps for remote artifacts. Evidence mirrors `EVIDENCE_LIMITS` in `src/evidence`. */
export const RUNNER_ARTIFACT_LIMITS = {
  file: 10 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  image: 20 * 1024 * 1024,
} as const;
/** How many artifacts one runner command may publish. */
export const RUNNER_ARTIFACT_COUNT_LIMIT = 20;
const EVIDENCE_TYPES = new Set([
  "video/webm",
  "video/mp4",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export function runnerArtifactLimit(artifact: { mimeType: string; evidence?: unknown }): number {
  if (artifact.evidence === undefined || !EVIDENCE_TYPES.has(artifact.mimeType))
    return RUNNER_ARTIFACT_LIMITS.file;
  return artifact.mimeType.startsWith("video/")
    ? RUNNER_ARTIFACT_LIMITS.video
    : RUNNER_ARTIFACT_LIMITS.image;
}

export const RunnerArtifactSchema = z
  .strictObject({
    id: z.uuid(),
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !value.includes("\0") &&
          value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
          value.split("/")[0] !== ".git",
      ),
    displayName: z
      .string()
      .min(1)
      .max(256)
      .refine((value) =>
        [...value].every(
          (character) =>
            character.charCodeAt(0) >= 32 &&
            character.charCodeAt(0) !== 127 &&
            !"/\\".includes(character),
        ),
      ),
    mimeType: z
      .string()
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)
      .max(128),
    sizeBytes: z.number().int().nonnegative().max(RUNNER_ARTIFACT_LIMITS.video),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    attachToIssue: z.boolean(),
    evidence: z
      .strictObject({
        checkId: z.string().regex(/^[A-Za-z0-9][\w.-]{0,127}$/),
        attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        headCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      })
      .optional(),
  })
  .refine((artifact) => artifact.sizeBytes <= runnerArtifactLimit(artifact), {
    message: "Runner artifact exceeds its size limit",
    path: ["sizeBytes"],
  });
export const RunnerArtifactChunkSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifact: RunnerArtifactSchema,
  index: z.number().int().nonnegative().max(399),
  data: z.string().max(699052),
});
export type RunnerArtifact = z.infer<typeof RunnerArtifactSchema>;
export type RunnerArtifactChunk = z.infer<typeof RunnerArtifactChunkSchema>;
