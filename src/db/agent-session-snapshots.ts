import type { Database } from "bun:sqlite";
import { aliasedTable, and, eq, exists, gt, inArray, ne, not, or, sql } from "drizzle-orm";
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

export function* agentSessionSnapshotRowSteps(q: Q, runId: string, generation: number) {
  const { agentSessionSnapshot: snapshot } = q.t;
  const row: AgentSessionSnapshotRow | undefined = yield* q.one(
    q.orm
      .select({
        runId: snapshot.runId,
        generation: snapshot.generation,
        itemId: snapshot.itemId,
        workspaceId: snapshot.workspaceId,
        runnerId: snapshot.runnerId,
        ownerUserId: snapshot.ownerUserId,
        agent: snapshot.agent,
        agentVersion: snapshot.agentVersion,
        sessionId: snapshot.sessionId,
        workspacePath: snapshot.workspacePath,
        commitSha: snapshot.commitSha,
        turn: snapshot.turn,
        sizeBytes: snapshot.sizeBytes,
        sealedSize: snapshot.sealedSize,
        sha256: snapshot.sha256,
        status: snapshot.status,
        createdAt: snapshot.createdAt,
        sealedAt: snapshot.sealedAt,
      })
      .from(snapshot)
      .where(and(eq(snapshot.runId, runId), eq(snapshot.generation, generation))),
  );
  return row ?? null;
}

export function agentSessionSnapshotRow(
  db: Database,
  runId: string,
  generation: number,
): AgentSessionSnapshotRow | null {
  return settled(sqliteDb(db).run((q) => agentSessionSnapshotRowSteps(q, runId, generation)));
}

export type NewAgentSessionSnapshot = {
  runId: string;
  generation: number;
  itemId: string;
  workspaceId: string;
  runnerId: string;
  createdAt: number;
};

export function* insertAgentSessionSnapshotSteps(q: Q, input: NewAgentSessionSnapshot) {
  yield* q.exec(q.orm.insert(q.t.agentSessionSnapshot).values(input));
}

export function insertAgentSessionSnapshot(db: Database, input: NewAgentSessionSnapshot): void {
  settled(sqliteDb(db).run((q) => insertAgentSessionSnapshotSteps(q, input)));
}

export type AgentSessionSnapshotSeal = {
  ownerUserId: string;
  agent: string;
  agentVersion: string;
  sessionId: string;
  workspacePath: string;
  commitSha: string;
  turn: number;
  sealedSize: number;
  sha256: string;
  sealedAt: number;
};

export function* sealAgentSessionSnapshotSteps(
  q: Q,
  runId: string,
  generation: number,
  seal: AgentSessionSnapshotSeal,
) {
  const { agentSessionSnapshot: snapshot } = q.t;
  yield* q.exec(
    q.orm
      .update(snapshot)
      .set({ ...seal, status: "sealed" })
      .where(
        and(
          eq(snapshot.runId, runId),
          eq(snapshot.generation, generation),
          eq(snapshot.status, "uploading"),
        ),
      ),
  );
}

export function sealAgentSessionSnapshot(
  db: Database,
  runId: string,
  generation: number,
  seal: AgentSessionSnapshotSeal,
): void {
  settled(sqliteDb(db).run((q) => sealAgentSessionSnapshotSteps(q, runId, generation, seal)));
}

export function* discardUnusableAgentSessionSnapshotsSteps(q: Q) {
  const { agentSessionSnapshot: snapshot, run, workItem } = q.t;
  const newer = aliasedTable(snapshot, "newer");
  const one = { one: sql`1` };
  yield* q.exec(
    q.orm
      .update(snapshot)
      .set({ status: "discarded" })
      .where(
        and(
          ne(snapshot.status, "discarded"),
          or(
            exists(
              q.orm
                .select(one)
                .from(newer)
                .where(
                  and(
                    eq(newer.runId, snapshot.runId),
                    gt(newer.generation, snapshot.generation),
                    eq(newer.status, "sealed"),
                  ),
                ),
            ),
            exists(
              q.orm
                .select(one)
                .from(run)
                .where(
                  and(
                    eq(run.id, snapshot.runId),
                    or(
                      eq(run.status, "lost"),
                      and(
                        eq(run.status, "ended"),
                        not(
                          exists(
                            q.orm
                              .select(one)
                              .from(workItem)
                              .where(
                                and(eq(workItem.id, run.itemId), eq(workItem.currentRunId, run.id)),
                              ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ),
            exists(
              q.orm
                .select(one)
                .from(workItem)
                .where(
                  and(
                    eq(workItem.id, snapshot.itemId),
                    inArray(workItem.state, ["completed", "merged", "cancelled", "failed"]),
                  ),
                ),
            ),
          ),
        ),
      ),
  );
}

export function discardUnusableAgentSessionSnapshots(db: Database): void {
  settled(sqliteDb(db).run((q) => discardUnusableAgentSessionSnapshotsSteps(q)));
}

export type DiscardedAgentSessionChunk = {
  runId: string;
  generation: number;
  workspaceId: string;
  offset: number;
  sha256: string;
};

export function* discardedAgentSessionChunksSteps(q: Q, limit: number) {
  const { agentSessionSnapshot: snapshot, agentSessionSnapshotChunk: chunk } = q.t;
  const rows: DiscardedAgentSessionChunk[] = yield* q.all(
    q.orm
      .select({
        runId: chunk.runId,
        generation: chunk.generation,
        workspaceId: snapshot.workspaceId,
        offset: chunk.offset,
        sha256: chunk.sha256,
      })
      .from(chunk)
      .innerJoin(
        snapshot,
        and(eq(snapshot.runId, chunk.runId), eq(snapshot.generation, chunk.generation)),
      )
      .where(eq(snapshot.status, "discarded"))
      .limit(limit),
  );
  return rows;
}

export function discardedAgentSessionChunks(
  db: Database,
  limit: number,
): DiscardedAgentSessionChunk[] {
  return settled(sqliteDb(db).run((q) => discardedAgentSessionChunksSteps(q, limit)));
}

export function* deleteAgentSessionChunkSteps(
  q: Q,
  key: { runId: string; generation: number; offset: number },
) {
  const { agentSessionSnapshotChunk: chunk } = q.t;
  yield* q.exec(
    q.orm
      .delete(chunk)
      .where(
        and(
          eq(chunk.runId, key.runId),
          eq(chunk.generation, key.generation),
          eq(chunk.offset, key.offset),
        ),
      ),
  );
}

export function deleteAgentSessionChunk(
  db: Database,
  key: { runId: string; generation: number; offset: number },
): void {
  settled(sqliteDb(db).run((q) => deleteAgentSessionChunkSteps(q, key)));
}
