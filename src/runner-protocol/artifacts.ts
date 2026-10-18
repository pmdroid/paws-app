import { z } from "zod";

export const RUNNER_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
/** Closeout videos are larger than other artifacts. The host evidence store applies its own caps. */
export const RUNNER_EVIDENCE_MAX_BYTES = 200 * 1024 * 1024;

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
    sizeBytes: z.number().int().nonnegative().max(RUNNER_EVIDENCE_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    attachToIssue: z.boolean(),
    evidence: z
      .strictObject({
        checkId: z
          .string()
          .min(1)
          .max(128)
          .refine((value) =>
            [...value].every(
              (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
            ),
          ),
        attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        headCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      })
      .optional(),
  })
  .refine((value) => value.evidence !== undefined || value.sizeBytes <= RUNNER_ARTIFACT_MAX_BYTES, {
    message: "Runner artifact exceeds limit",
  });
export const RunnerArtifactChunkSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifact: RunnerArtifactSchema,
  index: z.number().int().nonnegative().max(399),
  data: z.string().max(699052),
});
export type RunnerArtifact = z.infer<typeof RunnerArtifactSchema>;
export type RunnerArtifactChunk = z.infer<typeof RunnerArtifactChunkSchema>;
