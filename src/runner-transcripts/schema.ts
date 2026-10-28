import { z } from "zod";
import { RUN_FILE_CHUNK_BYTES } from "../run-files";

export const RUNNER_TRANSCRIPT_CHUNK_BYTES = RUN_FILE_CHUNK_BYTES;
export const RUNNER_TRANSCRIPT_MAX_BYTES = 16_777_216;
export const RunnerTranscriptChunkSchema = z.strictObject({
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  executionId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  offset: z.number().int().nonnegative().max(RUNNER_TRANSCRIPT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: z.string().max(Math.ceil(RUNNER_TRANSCRIPT_CHUNK_BYTES / 3) * 4),
});
export const RunnerTranscriptFinishSchema = RunnerTranscriptChunkSchema.omit({ data: true }).extend(
  {
    sizeBytes: z.number().int().nonnegative().max(RUNNER_TRANSCRIPT_MAX_BYTES),
  },
);
export type RunnerTranscriptChunk = z.infer<typeof RunnerTranscriptChunkSchema>;
export type RunnerTranscriptFinish = z.infer<typeof RunnerTranscriptFinishSchema>;
