import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";

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

export async function runFileChunk(
  store: Db,
  file: RunFileChunkAddress,
  offset: number,
): Promise<RunFileChunkRow | null> {
  return store.run((q) => runFileChunkSteps(q, file, offset));
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

export async function listRunFileChunks(
  store: Db,
  file: RunFileChunkAddress,
): Promise<RunFileChunkRow[]> {
  return store.run((q) => listRunFileChunksSteps(q, file));
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

export async function recordRunFileChunk(
  store: Db,
  file: RunFileChunkAddress,
  chunk: RunFileChunkRow,
  end: number,
): Promise<void> {
  await store.run((q) => recordRunFileChunkSteps(q, file, chunk, end));
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

export async function setRunFileChunkKey(
  store: Db,
  file: RunFileChunkAddress,
  chunk: { offset: number; sha256: string },
  keyId: string,
): Promise<void> {
  await store.run((q) => setRunFileChunkKeySteps(q, file, chunk, keyId));
}

export async function sealedRunFileChunkObjects(store: Db) {
  return store.run(function* (q) {
    const { runnerTranscript: t, runnerTranscriptChunk: c } = q.t;
    const { agentSessionSnapshot: s, agentSessionSnapshotChunk: a } = q.t;
    const transcript = yield* q.all(
      q.orm
        .select({
          offset: c.offset,
          sha256: c.sha256,
          workspaceId: t.workspaceId,
          commandId: t.commandId,
          executionId: t.executionId,
        })
        .from(c)
        .innerJoin(t, and(eq(t.runId, c.runId), eq(t.generation, c.generation)))
        .where(isNotNull(c.keyId))
        .orderBy(asc(c.runId), asc(c.generation), asc(c.offset)),
    );
    const agentSession = yield* q.all(
      q.orm
        .select({
          offset: a.offset,
          sha256: a.sha256,
          runId: a.runId,
          generation: a.generation,
          workspaceId: s.workspaceId,
        })
        .from(a)
        .innerJoin(s, and(eq(s.runId, a.runId), eq(s.generation, a.generation)))
        .orderBy(asc(a.runId), asc(a.generation), asc(a.offset)),
    );
    return { transcript, agentSession };
  });
}
