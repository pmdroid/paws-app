import {
  createFakeRunFileObjects,
  createLocalRunFileObjects,
  createS3RunFileObjects,
  loadRunFileKey,
  RUN_FILE_KINDS,
  runFileObjectKey,
  type RunFileObjects,
} from "../run-files";

export {
  RunnerTranscriptChunkSchema,
  RunnerTranscriptFinishSchema,
  RUNNER_TRANSCRIPT_CHUNK_BYTES,
  RUNNER_TRANSCRIPT_MAX_BYTES,
  type RunnerTranscriptChunk,
  type RunnerTranscriptFinish,
} from "./schema";
import { transcriptPrefix } from "./store";
export {
  createRunnerTranscripts,
  runnerTranscriptsEncrypted,
  RUNNER_TRANSCRIPT_ENCRYPT_JOB,
  type RunnerTranscripts,
} from "./store";
export { encryptRunnerTranscripts } from "./encrypt";
export { createRunnerTranscriptsHttp } from "./http";
export { withLocalRunFileFallback as withLocalRunnerTranscriptFallback } from "../run-files";

// Transcripts are the `transcript` kind of run file; these name its key and objects.
export type RunnerTranscriptObjects = RunFileObjects;
export const RUNNER_TRANSCRIPT_KEY_FILE = RUN_FILE_KINDS.transcript.keyFile;
export const loadRunnerTranscriptKey = (path: string) => loadRunFileKey("transcript", path);
export const createLocalRunnerTranscriptObjects = (root: string) =>
  createLocalRunFileObjects("transcript", root);
export const createS3RunnerTranscriptObjects = (
  options: Parameters<typeof createS3RunFileObjects>[1],
) => createS3RunFileObjects("transcript", options);
export const createFakeRunnerTranscriptObjects = createFakeRunFileObjects;
export const runnerTranscriptObjectKey = (
  chunk: Parameters<typeof transcriptPrefix>[0] & { offset: number; sha256: string },
) => runFileObjectKey(transcriptPrefix(chunk), chunk);
