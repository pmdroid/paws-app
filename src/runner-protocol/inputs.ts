import { z } from "zod";

export const RUNNER_PROMPT_CONTEXT_MAX_BYTES = 64 * 1024 * 1024;
export const RunnerPromptContextSchema = z.strictObject({
  sizeBytes: z.number().int().min(0).max(RUNNER_PROMPT_CONTEXT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RunnerPromptContext = z.infer<typeof RunnerPromptContextSchema>;

export const RUNNER_INPUT_MAX_BYTES = 20 * 1024 * 1024;
export const RUNNER_INPUT_CHUNK_BYTES = 524288;
export const RunnerInputFileSchema = z.strictObject({
  id: z.number().int().min(0).max(19),
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        Buffer.from(value, "utf8").toString("utf8") === value &&
        !value.includes("\\") &&
        [...value].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ) &&
        !value.startsWith("/") &&
        value
          .split("/")
          .every(
            (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
          ),
    ),
  mimeType: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  sizeBytes: z.number().int().min(0).max(RUNNER_INPUT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const RunnerInputFilesSchema = z
  .array(RunnerInputFileSchema)
  .max(20)
  .refine(
    (files) =>
      files.reduce((total, file) => total + file.sizeBytes, 0) <= RUNNER_INPUT_MAX_BYTES &&
      files.every(
        (file, index) =>
          file.id === index &&
          files.every(
            (other, otherIndex) =>
              index === otherIndex ||
              (file.path !== other.path && !file.path.startsWith(`${other.path}/`)),
          ),
      ),
  );
export type RunnerInputFile = z.infer<typeof RunnerInputFileSchema>;
