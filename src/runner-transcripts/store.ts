import type { Database } from "bun:sqlite";
import { immediate } from "../db";
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
type Transcript = {
  commandId: string;
  workspaceId: string;
  executionId: string;
  sizeBytes: number;
  sealedSize: number | null;
  sha256: string | null;
  uri: string | null;
};

function denied(): never {
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
  const files = createRunFileChunks({
    db,
    kind: "transcript",
    objects: options.objects,
    key: options.key,
    refused: denied,
  });
  function authorize(access: Access, generation: number) {
    const { command } = work.authorize({ ...access, generation });
    if (command.type !== "run" && command.type !== "review" && command.type !== "task") denied();
    return command;
  }
  function read(runId: string, generation: number) {
    return db
      .query<Transcript, [string, number]>(
        `SELECT command_id AS commandId,workspace_id AS workspaceId,execution_id AS executionId,
        size_bytes AS sizeBytes,sealed_size AS sealedSize,sha256,uri FROM runner_transcript
        WHERE run_id=? AND generation=?`,
      )
      .get(runId, generation);
  }
  /** Chunk objects keep the key they had before encryption, so plaintext chunks still read. */
  function file(runId: string, generation: number, row: Transcript) {
    return {
      runId,
      generation,
      prefix: `paws/transcripts/${row.workspaceId}/${row.commandId}/${row.executionId}/chunks`,
    };
  }
  function rowFor(access: Access, generation: number, executionId: string) {
    const command = authorize(access, generation);
    let row = read(access.runId, generation);
    if (!row) {
      db.run(
        `INSERT INTO runner_transcript(run_id,generation,command_id,workspace_id,execution_id)
        VALUES(?,?,?,?,?)`,
        [access.runId, generation, command.id, command.workspaceId, executionId],
      );
      row = read(access.runId, generation)!;
    }
    if (row.commandId !== command.id || row.executionId !== executionId) denied();
    return row;
  }
  return {
    async upload(access: Access, raw: RunnerTranscriptChunk) {
      const chunk = RunnerTranscriptChunkSchema.parse(raw);
      return files.upload(access.runId, chunk, RUNNER_TRANSCRIPT_MAX_BYTES, () => {
        const row = rowFor(access, chunk.generation, chunk.executionId);
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
      const row = immediate(db, () => {
        const value = rowFor(access, finish.generation, finish.executionId);
        if (
          value.sizeBytes !== finish.sizeBytes ||
          (value.sealedSize !== null &&
            (value.sealedSize !== finish.sizeBytes || value.sha256 !== finish.sha256))
        )
          denied();
        db.run(
          "UPDATE runner_transcript SET sealed_size=?,sha256=? WHERE run_id=? AND generation=?",
          [finish.sizeBytes, finish.sha256, access.runId, finish.generation],
        );
        return value;
      });
      if (row.uri) return { uri: row.uri };
      const transcript = file(access.runId, finish.generation, row);
      await files.verify(transcript, finish.sizeBytes, finish.sha256);
      return immediate(db, () => {
        const value = rowFor(access, finish.generation, finish.executionId);
        if (value.sealedSize !== finish.sizeBytes || value.sha256 !== finish.sha256) denied();
        const uri = `paws-run-file:transcript/${transcript.prefix}`;
        db.run("UPDATE runner_transcript SET uri=? WHERE run_id=? AND generation=?", [
          uri,
          access.runId,
          finish.generation,
        ]);
        return { uri };
      });
    },
    read,
    async download(runId: string, generation: number, executionId?: string) {
      const row = read(runId, generation);
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
