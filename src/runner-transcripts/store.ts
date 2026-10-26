import { journalCaught } from "../journal";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { immediate } from "../db";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";
import type { RunnerTranscriptObjects } from "./objects";
import {
  RunnerTranscriptChunkSchema,
  RunnerTranscriptFinishSchema,
  RUNNER_TRANSCRIPT_CHUNK_BYTES,
  RUNNER_TRANSCRIPT_MAX_BYTES,
  type RunnerTranscriptChunk,
  type RunnerTranscriptFinish,
} from "./schema";

export class RunnerTranscriptStorageError extends Error {}

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
type Chunk = { offset: number; sizeBytes: number; sha256: string };

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function denied(): never {
  throw new RunnerWorkFencedError("Runner transcript access is denied");
}

export function createRunnerTranscripts(options: {
  db: Database;
  work: RunnerWork;
  objects: RunnerTranscriptObjects;
}) {
  const { db, work, objects } = options;
  async function writeObject(key: string, bytes: Blob | ReadableStream<Uint8Array>) {
    try {
      await objects.write(key, bytes);
    } catch (error) {
      if (error instanceof RunnerWorkFencedError) throw error;
      throw new RunnerTranscriptStorageError("Runner transcript storage is unavailable");
    }
  }
  async function readObject(key: string, size: number, sha256: string) {
    try {
      const bytes = await boundedObject(objects.read(key), size);
      if (hash(bytes) !== sha256)
        throw new RunnerTranscriptStorageError("Runner transcript storage is unavailable");
      return bytes;
    } catch {
      throw new RunnerTranscriptStorageError("Runner transcript storage is unavailable");
    }
  }
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
  function prefix(row: Transcript) {
    return `paws/transcripts/${row.workspaceId}/${row.commandId}/${row.executionId}`;
  }
  function chunkKey(row: Transcript, chunk: Chunk) {
    return `${prefix(row)}/chunks/${chunk.offset}-${chunk.sha256}`;
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
  function existing(runId: string, generation: number, offset: number) {
    return db
      .query<Chunk, [string, number, number]>(
        `SELECT offset,size_bytes AS sizeBytes,sha256 FROM runner_transcript_chunk
        WHERE run_id=? AND generation=? AND offset=?`,
      )
      .get(runId, generation, offset);
  }
  const api = {
    async upload(access: Access, raw: RunnerTranscriptChunk) {
      const chunk = RunnerTranscriptChunkSchema.parse(raw);
      const bytes = Buffer.from(chunk.data, "base64");
      if (
        !bytes.length ||
        bytes.length > RUNNER_TRANSCRIPT_CHUNK_BYTES ||
        bytes.toString("base64") !== chunk.data ||
        hash(bytes) !== chunk.sha256 ||
        chunk.offset % RUNNER_TRANSCRIPT_CHUNK_BYTES !== 0 ||
        chunk.offset + bytes.length > RUNNER_TRANSCRIPT_MAX_BYTES
      )
        denied();
      const check = () => {
        const row = rowFor(access, chunk.generation, chunk.executionId);
        const previous = existing(access.runId, chunk.generation, chunk.offset);
        if (previous) {
          if (previous.sha256 !== chunk.sha256 || previous.sizeBytes !== bytes.length) denied();
        } else if (row.sealedSize !== null || row.sizeBytes !== chunk.offset) denied();
        return { row, previous };
      };
      const initial = immediate(db, check);
      if (initial.previous) return { offset: chunk.offset + bytes.length, duplicate: true };
      await writeObject(
        chunkKey(initial.row, { ...chunk, sizeBytes: bytes.length }),
        new Blob([bytes]),
      );
      return immediate(db, () => {
        const current = check();
        if (!current.previous) {
          db.run("INSERT INTO runner_transcript_chunk VALUES(?,?,?,?,?)", [
            access.runId,
            chunk.generation,
            chunk.offset,
            bytes.length,
            chunk.sha256,
          ]);
          db.run("UPDATE runner_transcript SET size_bytes=? WHERE run_id=? AND generation=?", [
            chunk.offset + bytes.length,
            access.runId,
            chunk.generation,
          ]);
        }
        return { offset: chunk.offset + bytes.length, duplicate: !!current.previous };
      });
    },
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
        return { ...value, sealedSize: finish.sizeBytes, sha256: finish.sha256 };
      });
      if (row.uri) return { uri: row.uri };
      const chunks = db
        .query<Chunk, [string, number]>(
          `SELECT offset,size_bytes AS sizeBytes,sha256 FROM runner_transcript_chunk
          WHERE run_id=? AND generation=? ORDER BY offset`,
        )
        .all(access.runId, finish.generation);
      let index = 0;
      let total = 0;
      const digest = createHash("sha256");
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = chunks[index++];
            if (!chunk) {
              if (total !== finish.sizeBytes || digest.digest("hex") !== finish.sha256) denied();
              controller.close();
              return;
            }
            if (chunk.offset !== total) denied();
            const bytes = await readObject(chunkKey(row, chunk), chunk.sizeBytes, chunk.sha256);
            total += bytes.length;
            digest.update(bytes);
            controller.enqueue(bytes);
          } catch (error) {
            journalCaught(error, "store.pull.digest", null);
            controller.error(error);
          }
        },
      });
      const key = `${prefix(row)}/acp.jsonl`;
      await writeObject(key, stream);
      return immediate(db, () => {
        const value = rowFor(access, finish.generation, finish.executionId);
        if (value.sealedSize !== finish.sizeBytes || value.sha256 !== finish.sha256) denied();
        const uri = objects.uri(key);
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
      return readObject(`${prefix(row)}/acp.jsonl`, row.sealedSize, row.sha256);
    },
  };
  return api;
}
export type RunnerTranscripts = ReturnType<typeof createRunnerTranscripts>;

async function boundedObject(stream: ReadableStream<Uint8Array>, size: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > size || total > RUNNER_TRANSCRIPT_MAX_BYTES) denied();
      chunks.push(part.value);
    }
    if (total !== size) denied();
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch((caughtError1) => {
      journalCaught(caughtError1, "store.boundedObject.cancel", null);
      return undefined;
    });
    reader.releaseLock();
  }
}
