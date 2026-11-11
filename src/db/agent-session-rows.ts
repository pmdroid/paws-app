import type { Database } from "bun:sqlite";
import { and, eq, exists, gt, inArray, ne, not, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { settled, sqliteDb, type Q } from "./db";

export type AgentSessionSnapshotRow = {
  runId: string;
  generation: number;
  itemId: string;
  workspaceId: string;
  runnerId: string;
  ownerUserId: string | null;
  agent: string | null;
  agentVersion: string | null;
  sessionId: string | null;
  workspacePath: string | null;
  commitSha: string | null;
  turn: number | null;
  sizeBytes: number;
  sealedSize: number | null;
  sha256: string | null;
  status: string;
  createdAt: number;
  sealedAt: number | null;
};

export function* agentSessionSnapshotSteps(q: Q, runId: string, generation: number) {
  const s = q.t.agentSessionSnapshot;
  const row = yield* q.one(
    q.orm
      .select({
        runId: s.runId,
        generation: s.generation,
        itemId: s.itemId,
        workspaceId: s.workspaceId,
        runnerId: s.runnerId,
        ownerUserId: s.ownerUserId,
        agent: s.agent,
        agentVersion: s.agentVersion,
        sessionId: s.sessionId,
        workspacePath: s.workspacePath,
        commitSha: s.commitSha,
        turn: s.turn,
        sizeBytes: s.sizeBytes,
        sealedSize: s.sealedSize,
        sha256: s.sha256,
        status: s.status,
        createdAt: s.createdAt,
        sealedAt: s.sealedAt,
      })
      .from(s)
      .where(and(eq(s.runId, runId), eq(s.generation, generation))),
  );
  return (row as AgentSessionSnapshotRow | undefined) ?? null;
}

export function agentSessionSnapshot(
  db: Database,
  runId: string,
  generation: number,
): AgentSessionSnapshotRow | null {
  return settled(sqliteDb(db).run((q) => agentSessionSnapshotSteps(q, runId, generation)));
}

type NewSnapshot = {
  runId: string;
  generation: number;
  itemId: string;
  workspaceId: string;
  runnerId: string;
  createdAt: number;
};

export function* insertAgentSessionSnapshotSteps(q: Q, row: NewSnapshot) {
  yield* q.exec(q.orm.insert(q.t.agentSessionSnapshot).values(row));
}

export function insertAgentSessionSnapshot(db: Database, row: NewSnapshot): void {
  settled(sqliteDb(db).run((q) => insertAgentSessionSnapshotSteps(q, row)));
}

export function* discardStaleAgentSessionsSteps(q: Q) {
  const { agentSessionSnapshot: s, run: r, workItem: w } = q.t;
  const newer = alias(s, "newer");
  const current = alias(w, "current_item");
  yield* q.exec(
    q.orm
      .update(s)
      .set({ status: "discarded" })
      .where(
        and(
          ne(s.status, "discarded"),
          or(
            exists(
              q.orm
                .select({ one: sql`1` })
                .from(newer)
                .where(
                  and(
                    eq(newer.runId, s.runId),
                    gt(newer.generation, s.generation),
                    eq(newer.status, "sealed"),
                  ),
                ),
            ),
            exists(
              q.orm
                .select({ one: sql`1` })
                .from(r)
                .where(
                  and(
                    eq(r.id, s.runId),
                    or(
                      eq(r.status, "lost"),
                      and(
                        eq(r.status, "ended"),
                        not(
                          exists(
                            q.orm
                              .select({ one: sql`1` })
                              .from(current)
                              .where(and(eq(current.id, r.itemId), eq(current.currentRunId, r.id))),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ),
            exists(
              q.orm
                .select({ one: sql`1` })
                .from(w)
                .where(
                  and(
                    eq(w.id, s.itemId),
                    inArray(w.state, ["completed", "merged", "cancelled", "failed"]),
                  ),
                ),
            ),
          ),
        ),
      ),
  );
}

export function discardStaleAgentSessions(db: Database): void {
  settled(sqliteDb(db).transaction((q) => discardStaleAgentSessionsSteps(q)));
}

export function* discardedAgentSessionChunksSteps(q: Q, limit: number) {
  const { agentSessionSnapshotChunk: c, agentSessionSnapshot: s } = q.t;
  return yield* q.all(
    q.orm
      .select({
        runId: c.runId,
        generation: c.generation,
        workspaceId: s.workspaceId,
        offset: c.offset,
        sha256: c.sha256,
      })
      .from(c)
      .innerJoin(s, and(eq(s.runId, c.runId), eq(s.generation, c.generation)))
      .where(eq(s.status, "discarded"))
      .limit(limit),
  );
}

export function discardedAgentSessionChunks(
  db: Database,
  limit: number,
): { runId: string; generation: number; workspaceId: string; offset: number; sha256: string }[] {
  return settled(sqliteDb(db).run((q) => discardedAgentSessionChunksSteps(q, limit)));
}

type ChunkKey = { runId: string; generation: number; offset: number };

export function* deleteAgentSessionChunksSteps(q: Q, chunks: readonly ChunkKey[]) {
  const c = q.t.agentSessionSnapshotChunk;
  for (const chunk of chunks)
    yield* q.exec(
      q.orm
        .delete(c)
        .where(
          and(
            eq(c.runId, chunk.runId),
            eq(c.generation, chunk.generation),
            eq(c.offset, chunk.offset),
          ),
        ),
    );
}

export function deleteAgentSessionChunks(db: Database, chunks: readonly ChunkKey[]): void {
  settled(sqliteDb(db).transaction((q) => deleteAgentSessionChunksSteps(q, chunks)));
}

export type AgentSessionSeal = {
  runId: string;
  generation: number;
  ownerUserId: string;
  agent: string;
  agentVersion: string;
  sessionId: string;
  workspacePath: string;
  commitSha: string | null;
  turn: number;
  sealedSize: number;
  sha256: string;
  sealedAt: number;
};

export function* sealAgentSessionSnapshotSteps(q: Q, seal: AgentSessionSeal) {
  const s = q.t.agentSessionSnapshot;
  const { runId, generation, ...values } = seal;
  yield* q.exec(
    q.orm
      .update(s)
      .set({ ...values, status: "sealed" })
      .where(and(eq(s.runId, runId), eq(s.generation, generation), eq(s.status, "uploading"))),
  );
}

export function sealAgentSessionSnapshot(db: Database, seal: AgentSessionSeal): void {
  settled(sqliteDb(db).run((q) => sealAgentSessionSnapshotSteps(q, seal)));
}
