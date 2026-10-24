import { z } from "zod";

export const RUNNER_TRANSCRIPT_CHUNK_BYTES = 524_288;
export const RUNNER_TRANSCRIPT_MAX_BYTES = 16_777_216;
/**
 * Paws seals a handed-over transcript only until this long after the handover deadline. The
 * seal is the point where a handover commits: before it, the runner may still keep the session.
 */
export const RUNNER_HANDOVER_SEAL_GRACE_MS = 15_000;
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
    /** The transcript ends a handover; the seal commits it. */
    handedOver: z.literal(true).optional(),
    /**
     * The last partial chunk, stored only together with the seal. A refused seal then leaves
     * nothing but whole chunks, so a session that continues can still append to its transcript.
     */
    tail: RunnerTranscriptChunkSchema.pick({ offset: true, sha256: true, data: true }).optional(),
  },
);
export type RunnerTranscriptChunk = z.infer<typeof RunnerTranscriptChunkSchema>;
export type RunnerTranscriptFinish = z.infer<typeof RunnerTranscriptFinishSchema>;
