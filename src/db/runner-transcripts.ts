import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";

export type RunnerTranscriptRow = {
  commandId: string;
  workspaceId: string;
  executionId: string;
  sizeBytes: number;
  sealedSize: number | null;
  sha256: string | null;
  uri: string | null;
};

export function* runnerTranscriptSteps(
  q: Q,
  runId: string,
  generation: number,
): Steps<RunnerTranscriptRow | null> {
  const { runnerTranscript: t } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        commandId: t.commandId,
        workspaceId: t.workspaceId,
        executionId: t.executionId,
        sizeBytes: t.sizeBytes,
        sealedSize: t.sealedSize,
        sha256: t.sha256,
        uri: t.uri,
      })
      .from(t)
      .where(and(eq(t.runId, runId), eq(t.generation, generation))),
  );
  return row ?? null;
}

export function runnerTranscript(
  db: Database,
  runId: string,
  generation: number,
): RunnerTranscriptRow | null {
  return settled(sqliteDb(db).run((q) => runnerTranscriptSteps(q, runId, generation)));
}

export type NewRunnerTranscript = {
  runId: string;
  generation: number;
  commandId: string;
  workspaceId: string;
  executionId: string;
};

export function* insertRunnerTranscriptSteps(q: Q, row: NewRunnerTranscript) {
  yield* q.exec(q.orm.insert(q.t.runnerTranscript).values(row));
}

export function insertRunnerTranscript(db: Database, row: NewRunnerTranscript): void {
  settled(sqliteDb(db).run((q) => insertRunnerTranscriptSteps(q, row)));
}

export function* sealRunnerTranscriptSteps(
  q: Q,
  input: { runId: string; generation: number; sizeBytes: number; sha256: string },
) {
  const { runnerTranscript: t } = q.t;
  yield* q.exec(
    q.orm
      .update(t)
      .set({ sealedSize: input.sizeBytes, sha256: input.sha256 })
      .where(and(eq(t.runId, input.runId), eq(t.generation, input.generation))),
  );
}

export function sealRunnerTranscript(
  db: Database,
  input: { runId: string; generation: number; sizeBytes: number; sha256: string },
): void {
  settled(sqliteDb(db).run((q) => sealRunnerTranscriptSteps(q, input)));
}

export function* setRunnerTranscriptUriSteps(q: Q, runId: string, generation: number, uri: string) {
  const { runnerTranscript: t } = q.t;
  yield* q.exec(
    q.orm
      .update(t)
      .set({ uri })
      .where(and(eq(t.runId, runId), eq(t.generation, generation))),
  );
}

export function setRunnerTranscriptUri(
  db: Database,
  runId: string,
  generation: number,
  uri: string,
): void {
  settled(sqliteDb(db).run((q) => setRunnerTranscriptUriSteps(q, runId, generation, uri)));
}

export type PlaintextTranscriptChunk = {
  runId: string;
  generation: number;
  offset: number;
  sizeBytes: number;
  sha256: string;
  workspaceId: string;
  commandId: string;
  executionId: string;
};

export function* plaintextTranscriptChunksSteps(
  q: Q,
  after: readonly [runId: string, generation: number, offset: number],
  limit: number,
): Steps<PlaintextTranscriptChunk[]> {
  const { runnerTranscript: t, runnerTranscriptChunk: c } = q.t;
  const [runId, generation, offset] = after;
  return yield* q.all(
    q.orm
      .select({
        runId: c.runId,
        generation: c.generation,
        offset: c.offset,
        sizeBytes: c.sizeBytes,
        sha256: c.sha256,
        workspaceId: t.workspaceId,
        commandId: t.commandId,
        executionId: t.executionId,
      })
      .from(c)
      .innerJoin(t, and(eq(t.runId, c.runId), eq(t.generation, c.generation)))
      .where(
        and(
          isNull(c.keyId),
          sql`(${c.runId}, ${c.generation}, ${c.offset}) > (${runId}, ${generation}, ${offset})`,
        ),
      )
      .orderBy(asc(c.runId), asc(c.generation), asc(c.offset))
      .limit(limit),
  );
}

export function plaintextTranscriptChunks(
  db: Database,
  after: readonly [runId: string, generation: number, offset: number],
  limit: number,
): PlaintextTranscriptChunk[] {
  return settled(sqliteDb(db).run((q) => plaintextTranscriptChunksSteps(q, after, limit)));
}
