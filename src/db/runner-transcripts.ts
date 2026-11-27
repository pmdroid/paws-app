import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";

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

export async function runnerTranscript(
  store: Db,
  runId: string,
  generation: number,
): Promise<RunnerTranscriptRow | null> {
  return store.run((q) => runnerTranscriptSteps(q, runId, generation));
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

export async function insertRunnerTranscript(store: Db, row: NewRunnerTranscript): Promise<void> {
  await store.run((q) => insertRunnerTranscriptSteps(q, row));
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

export async function sealRunnerTranscript(
  store: Db,
  input: { runId: string; generation: number; sizeBytes: number; sha256: string },
): Promise<void> {
  await store.run((q) => sealRunnerTranscriptSteps(q, input));
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

export async function setRunnerTranscriptUri(
  store: Db,
  runId: string,
  generation: number,
  uri: string,
): Promise<void> {
  await store.run((q) => setRunnerTranscriptUriSteps(q, runId, generation, uri));
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

export async function plaintextTranscriptChunks(
  store: Db,
  after: readonly [runId: string, generation: number, offset: number],
  limit: number,
): Promise<PlaintextTranscriptChunk[]> {
  return store.run((q) => plaintextTranscriptChunksSteps(q, after, limit));
}

export type RetroTranscriptRow = {
  runId: string;
  generation: number;
  commandKind: string | null;
  sizeBytes: number;
  sealedSize: number | null;
};

export function* retroTranscriptRowsSteps(
  q: Q,
  workspaceId: string,
  runIds: readonly string[],
): Steps<RetroTranscriptRow[]> {
  if (runIds.length === 0) return [];
  const { runnerTranscript: t, runnerCommand: c } = q.t;
  return yield* q.all(
    q.orm
      .select({
        runId: t.runId,
        generation: t.generation,
        commandKind: c.kind,
        sizeBytes: t.sizeBytes,
        sealedSize: t.sealedSize,
      })
      .from(t)
      .leftJoin(c, eq(c.id, t.commandId))
      .where(and(eq(t.workspaceId, workspaceId), inArray(t.runId, [...runIds])))
      .orderBy(asc(t.runId), asc(t.generation)),
  );
}

export type RetroUntranscribedTurns = {
  helpers: { id: string; itemId: string; purpose: string | null; at: number }[];
  retros: { commandId: string; retroId: string; at: number }[];
};

export function* retroUntranscribedTurnsSteps(
  q: Q,
  input: {
    workspaceId: string;
    retroId: string;
    repositories: readonly string[];
    itemIds: readonly string[];
    from: number;
    to: number;
  },
): Steps<RetroUntranscribedTurns> {
  const { runnerHelper: h, workItem: w, retroDispatch: d, retroRepository: r } = q.t;
  const at = sql<number>`coalesce(${h.endedAt}, ${h.expiresAt})`.mapWith(Number);
  const helpers =
    input.itemIds.length === 0
      ? []
      : yield* q.all(
          q.orm
            .select({ id: h.id, itemId: w.id, purpose: h.purpose, at })
            .from(h)
            .innerJoin(w, eq(w.sessionKey, h.sessionId))
            .where(
              and(
                eq(h.workspaceId, input.workspaceId),
                inArray(w.id, [...input.itemIds]),
                sql`${at} >= ${input.from} AND ${at} < ${input.to}`,
              ),
            )
            .orderBy(asc(at), asc(h.id)),
        );
  const dispatched = yield* q.all(
    q.orm
      .select({ commandId: d.commandId, retroId: d.retroId, at: d.createdAt })
      .from(d)
      .where(
        and(
          eq(d.workspaceId, input.workspaceId),
          ne(d.retroId, input.retroId),
          gte(d.createdAt, input.from),
          lt(d.createdAt, input.to),
        ),
      )
      .orderBy(asc(d.createdAt), asc(d.commandId)),
  );
  const allowed = new Set(input.repositories.map((repository) => repository.toLowerCase()));
  const outside = new Set<string>();
  if (dispatched.length > 0)
    for (const row of yield* q.all(
      q.orm
        .select({ retroId: r.retroId, repository: sql<string>`${r.repository}` })
        .from(r)
        .where(inArray(r.retroId, [...new Set(dispatched.map((entry) => entry.retroId))])),
    ))
      if (!allowed.has(row.repository.toLowerCase())) outside.add(row.retroId);
  return { helpers, retros: dispatched.filter((row) => !outside.has(row.retroId)) };
}
