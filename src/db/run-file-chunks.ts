import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";

export type RunFileChunkKind = "transcript" | "agent_session";

export type RunFileChunkRow = {
  offset: number;
  sizeBytes: number;
  sha256: string;
  keyId: string | null;
};

type RunFileChunkAddress = { kind: RunFileChunkKind; runId: string; generation: number };

/** Both kinds store the same chunk columns; only the agent session key ID is declared required. */
function chunkTable(q: Q, kind: RunFileChunkKind) {
  return (
    kind === "transcript" ? q.t.runnerTranscriptChunk : q.t.agentSessionSnapshotChunk
  ) as typeof q.t.runnerTranscriptChunk;
}

function fileTable(q: Q, kind: RunFileChunkKind) {
  return (
    kind === "transcript" ? q.t.runnerTranscript : q.t.agentSessionSnapshot
  ) as typeof q.t.runnerTranscript;
}

function chunkColumns(table: ReturnType<typeof chunkTable>) {
  return {
    offset: table.offset,
    sizeBytes: table.sizeBytes,
    sha256: table.sha256,
    keyId: table.keyId,
  };
}

function ofFile(table: ReturnType<typeof chunkTable>, file: RunFileChunkAddress) {
  return and(eq(table.runId, file.runId), eq(table.generation, file.generation));
}

export function* runFileChunkSteps(
  q: Q,
  file: RunFileChunkAddress,
  offset: number,
): Steps<RunFileChunkRow | null> {
  const table = chunkTable(q, file.kind);
  const row = yield* q.one(
    q.orm
      .select(chunkColumns(table))
      .from(table)
      .where(and(ofFile(table, file), eq(table.offset, offset))),
  );
  return row ?? null;
}

export function runFileChunk(
  db: Database,
  file: RunFileChunkAddress,
  offset: number,
): RunFileChunkRow | null {
  return settled(sqliteDb(db).run((q) => runFileChunkSteps(q, file, offset)));
}

export function* listRunFileChunksSteps(q: Q, file: RunFileChunkAddress): Steps<RunFileChunkRow[]> {
  const table = chunkTable(q, file.kind);
  return yield* q.all(
    q.orm
      .select(chunkColumns(table))
      .from(table)
      .where(ofFile(table, file))
      .orderBy(asc(table.offset)),
  );
}

export function listRunFileChunks(db: Database, file: RunFileChunkAddress): RunFileChunkRow[] {
  return settled(sqliteDb(db).run((q) => listRunFileChunksSteps(q, file)));
}

/** Records a stored chunk and moves the file's size to `end`; the caller holds the transaction. */
export function* recordRunFileChunkSteps(
  q: Q,
  file: RunFileChunkAddress,
  chunk: RunFileChunkRow,
  end: number,
): Steps<void> {
  const parent = fileTable(q, file.kind);
  yield* q.exec(
    q.orm
      .insert(chunkTable(q, file.kind))
      .values({ runId: file.runId, generation: file.generation, ...chunk }),
  );
  yield* q.exec(
    q.orm
      .update(parent)
      .set({ sizeBytes: end })
      .where(and(eq(parent.runId, file.runId), eq(parent.generation, file.generation))),
  );
}

export function recordRunFileChunk(
  db: Database,
  file: RunFileChunkAddress,
  chunk: RunFileChunkRow,
  end: number,
): void {
  settled(sqliteDb(db).run((q) => recordRunFileChunkSteps(q, file, chunk, end)));
}

/** Records the key of a chunk stored before encryption, once it is sealed in place. */
export function* setRunFileChunkKeySteps(
  q: Q,
  file: RunFileChunkAddress,
  chunk: { offset: number; sha256: string },
  keyId: string,
): Steps<void> {
  const table = chunkTable(q, file.kind);
  yield* q.exec(
    q.orm
      .update(table)
      .set({ keyId })
      .where(
        and(
          ofFile(table, file),
          eq(table.offset, chunk.offset),
          eq(table.sha256, chunk.sha256),
          isNull(table.keyId),
        ),
      ),
  );
}

export function setRunFileChunkKey(
  db: Database,
  file: RunFileChunkAddress,
  chunk: { offset: number; sha256: string },
  keyId: string,
): void {
  settled(sqliteDb(db).run((q) => setRunFileChunkKeySteps(q, file, chunk, keyId)));
}
