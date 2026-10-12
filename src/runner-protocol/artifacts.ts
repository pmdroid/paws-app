import { z } from "zod";

export const RunnerArtifactSchema = z.strictObject({
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
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(10 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  attachToIssue: z.boolean(),
});
export const RunnerArtifactChunkSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifact: RunnerArtifactSchema,
  index: z.number().int().nonnegative().max(19),
  data: z.string().max(699052),
});
export type RunnerArtifact = z.infer<typeof RunnerArtifactSchema>;
export type RunnerArtifactChunk = z.infer<typeof RunnerArtifactChunkSchema>;
