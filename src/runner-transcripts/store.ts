import type { Database } from "bun:sqlite";
import {
  insertRunnerTranscriptSteps,
  jobStatusByKey,
  runnerTranscriptSteps,
  sealRunnerTranscriptSteps,
  setRunnerTranscriptUriSteps,
  settled,
  sqliteDb,
  type Q,
  type RunnerTranscriptRow,
  type Steps,
} from "../db";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";
import { createRunFileChunks, type RunFileObjects } from "../run-files";
import {
  RunnerTranscriptChunkSchema,
  RunnerTranscriptFinishSchema,
  RUNNER_TRANSCRIPT_MAX_BYTES,
  type RunnerTranscriptChunk,
  type RunnerTranscriptFinish,
} from "./schema";

type Access = { runnerId: string; runId: string; token: string };

/** The one-time job, enqueued by a migration, that seals chunks stored before encryption. */
export const RUNNER_TRANSCRIPT_ENCRYPT_JOB = "runner-transcripts.encrypt";

/**
 * True once the job is done, or when the migration found nothing to convert. From then on a chunk
 * without a key ID is refused instead of read as plaintext.
 */
export function runnerTranscriptsEncrypted(db: Database) {
  const status = jobStatusByKey(db, RUNNER_TRANSCRIPT_ENCRYPT_JOB);
  return status === null || status === "done";
}

/** Where a transcript's chunk objects live. Chunks stored before encryption keep this key. */
export function transcriptPrefix(row: {
  workspaceId: string;
  commandId: string;
  executionId: string;
}) {
  return `paws/transcripts/${row.workspaceId}/${row.commandId}/${row.executionId}/chunks`;
}

export function denied(): never {
  throw new RunnerWorkFencedError("Runner transcript access is denied");
}

export function createRunnerTranscripts(options: {
  db: Database;
  work: RunnerWork;
  objects: RunFileObjects;
  /** The 32-byte key from `loadRunnerTranscriptKey`. */
  key: Buffer;
}) {
  const { db, work } = options;
  const store = sqliteDb(db);
  const files = createRunFileChunks({
    db,
    kind: "transcript",
    objects: options.objects,
    key: options.key,
    refused: denied,
    plaintext: () => !runnerTranscriptsEncrypted(db),
  });
  function* authorizeSteps(q: Q, access: Access, generation: number) {
    const { command } = yield* work.authorizeSteps(q, { ...access, generation });
    if (command.type !== "run" && command.type !== "review" && command.type !== "task") denied();
    return command;
  }
  function read(runId: string, generation: number) {
    return settled(store.run((q) => runnerTranscriptSteps(q, runId, generation)));
  }
  function file(runId: string, generation: number, row: RunnerTranscriptRow) {
    return { runId, generation, prefix: transcriptPrefix(row) };
  }
  function* rowForSteps(
    q: Q,
    access: Access,
    generation: number,
    executionId: string,
  ): Steps<RunnerTranscriptRow> {
    const command = yield* authorizeSteps(q, access, generation);
    let row = yield* runnerTranscriptSteps(q, access.runId, generation);
    if (!row) {
      yield* insertRunnerTranscriptSteps(q, {
        runId: access.runId,
        generation,
        commandId: command.id,
        workspaceId: command.workspaceId,
        executionId,
      });
      row = (yield* runnerTranscriptSteps(q, access.runId, generation))!;
    }
    if (row.commandId !== command.id || row.executionId !== executionId) denied();
    return row;
  }
  return {
    async upload(access: Access, raw: RunnerTranscriptChunk) {
      const chunk = RunnerTranscriptChunkSchema.parse(raw);
      return files.upload(access.runId, chunk, RUNNER_TRANSCRIPT_MAX_BYTES, () => {
        const row = settled(
          store.run((q) => rowForSteps(q, access, chunk.generation, chunk.executionId)),
        );
        return {
          ...file(access.runId, chunk.generation, row),
          sizeBytes: row.sizeBytes,
          open: row.sealedSize === null,
        };
      });
    },
    /**
     * Seals the transcript once its chunks add up to the finish. The URI names where its chunks
     * live; the runner only checks that one is returned.
     */
    async finish(access: Access, raw: RunnerTranscriptFinish) {
      const finish = RunnerTranscriptFinishSchema.parse(raw);
      if (finish.offset !== finish.sizeBytes) denied();
      const row = await store.transaction(function* (q) {
        const value = yield* rowForSteps(q, access, finish.generation, finish.executionId);
        if (
          value.sizeBytes !== finish.sizeBytes ||
          (value.sealedSize !== null &&
            (value.sealedSize !== finish.sizeBytes || value.sha256 !== finish.sha256))
        )
          denied();
        yield* sealRunnerTranscriptSteps(q, {
          runId: access.runId,
          generation: finish.generation,
          sizeBytes: finish.sizeBytes,
          sha256: finish.sha256,
        });
        return value;
      });
      if (row.uri) return { uri: row.uri };
      const transcript = file(access.runId, finish.generation, row);
      await files.verify(transcript, finish.sizeBytes, finish.sha256);
      return store.transaction(function* (q) {
        const value = yield* rowForSteps(q, access, finish.generation, finish.executionId);
        if (value.sealedSize !== finish.sizeBytes || value.sha256 !== finish.sha256) denied();
        const uri = `paws-run-file:transcript/${transcript.prefix}`;
        yield* setRunnerTranscriptUriSteps(q, access.runId, finish.generation, uri);
        return { uri };
      });
    },
    read,
    async download(runId: string, generation: number, executionId?: string) {
      const row = await store.run((q) => runnerTranscriptSteps(q, runId, generation));
      if (!row?.uri || row.sealedSize === null || !row.sha256)
        throw new Error("Runner transcript is not complete");
      if (executionId && row.executionId !== executionId)
        throw new Error("Runner transcript execution changed");
      const parts: Uint8Array[] = [];
      for await (const part of files.read(file(runId, generation, row), row.sealedSize, row.sha256))
        parts.push(part);
      return Buffer.concat(parts);
    },
  };
}
export type RunnerTranscripts = ReturnType<typeof createRunnerTranscripts>;
