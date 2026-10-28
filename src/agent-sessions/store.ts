import type { Database } from "bun:sqlite";
import { immediate } from "../db";
import { journalCaught } from "../journal";
import type { RunnerWork } from "../runner-work";
import { createRunFileChunks, type RunFileObjects } from "../run-files";
import {
  AgentSessionChunkSchema,
  AgentSessionFinishSchema,
  AGENT_SESSION_MAX_BYTES,
  type AgentSessionChunk,
  type AgentSessionFinish,
} from "./schema";

export class AgentSessionRefusedError extends Error {}

type Access = { runnerId: string; runId: string; token: string };
export type AgentSessionSnapshot = {
  runId: string;
  generation: number;
  itemId: string;
  workspaceId: string;
  runnerId: string;
  ownerUserId: string | null;
  agent: AgentSessionFinish["agent"] | null;
  agentVersion: string | null;
  sessionId: string | null;
  workspacePath: string | null;
  commitSha: string | null;
  turn: number | null;
  sizeBytes: number;
  sealedSize: number | null;
  sha256: string | null;
  status: "uploading" | "sealed" | "discarded";
  createdAt: number;
  sealedAt: number | null;
};

/** Chunks of discarded snapshots deleted per transaction. */
const PRUNE_BATCH = 256;

function refused(): never {
  throw new AgentSessionRefusedError("Agent session request is refused");
}

export function createAgentSessions(options: {
  db: Database;
  work: RunnerWork;
  objects: RunFileObjects;
  /** The 32-byte key from `loadAgentSessionKey`. */
  key: Buffer;
  now?: () => number;
  /** A lower cap than `AGENT_SESSION_MAX_BYTES`, for tests. */
  maxBytes?: number;
}) {
  const { db, work, objects } = options;
  const files = createRunFileChunks({
    db,
    kind: "agent_session",
    objects,
    key: options.key,
    refused,
  });
  const now = options.now ?? Date.now;
  const maxBytes = Math.min(options.maxBytes ?? AGENT_SESSION_MAX_BYTES, AGENT_SESSION_MAX_BYTES);

  function authorize(access: Access, generation: number) {
    const { command } = work.authorize({ ...access, generation });
    if (command.type !== "run") refused();
    return command;
  }
  function snapshot(runId: string, generation: number) {
    return db
      .query<AgentSessionSnapshot, [string, number]>(
        `SELECT run_id AS runId,generation,item_id AS itemId,workspace_id AS workspaceId,
        runner_id AS runnerId,owner_user_id AS ownerUserId,agent,agent_version AS agentVersion,
        session_id AS sessionId,workspace_path AS workspacePath,commit_sha AS commitSha,turn,
        size_bytes AS sizeBytes,sealed_size AS sealedSize,sha256,status,created_at AS createdAt,
        sealed_at AS sealedAt FROM agent_session_snapshot WHERE run_id=? AND generation=?`,
      )
      .get(runId, generation);
  }
  function file(row: Pick<AgentSessionSnapshot, "workspaceId" | "runId" | "generation">) {
    return {
      runId: row.runId,
      generation: row.generation,
      prefix: `paws/agent-sessions/${row.workspaceId}/${row.runId}/${row.generation}`,
    };
  }
  /** The writer's row for its own generation, created on first contact. */
  function rowFor(access: Access, generation: number) {
    const command = authorize(access, generation);
    let row = snapshot(access.runId, generation);
    if (!row) {
      db.run(
        `INSERT INTO agent_session_snapshot(run_id,generation,item_id,workspace_id,runner_id,created_at)
        VALUES(?,?,?,?,?,?)`,
        [access.runId, generation, command.itemId, command.workspaceId, access.runnerId, now()],
      );
      row = snapshot(access.runId, generation)!;
    }
    if (
      row.runnerId !== access.runnerId ||
      row.workspaceId !== command.workspaceId ||
      row.itemId !== command.itemId ||
      row.status === "discarded"
    )
      refused();
    return row;
  }
  function sameFinish(row: AgentSessionSnapshot, finish: AgentSessionFinish) {
    return (
      row.sealedSize === finish.sizeBytes &&
      row.sha256 === finish.sha256 &&
      row.agent === finish.agent &&
      row.agentVersion === finish.agentVersion &&
      row.sessionId === finish.sessionId &&
      row.workspacePath === finish.workspacePath &&
      row.commitSha === finish.commitSha &&
      row.turn === finish.turn
    );
  }
  function receipt(row: AgentSessionSnapshot) {
    return { generation: row.generation, sizeBytes: row.sealedSize!, sha256: row.sha256! };
  }
  /** The run's current runner, owned by the member who produced the snapshot. */
  function readable(access: Access & { generation: number }, generation: number) {
    authorize(access, access.generation);
    const row = snapshot(access.runId, generation);
    if (
      !row ||
      row.status !== "sealed" ||
      generation > access.generation ||
      work.identity(access.runnerId).userId !== row.ownerUserId
    )
      refused();
    return row;
  }

  /**
   * Marks snapshots a move can no longer use as `discarded` in one transaction, then deletes the
   * objects of every discarded snapshot outside it. A run keeps only its latest sealed snapshot,
   * and loses that once the run is lost, replaced by another run, or its work item is completed,
   * merged, cancelled or failed. Rows stay `discarded` so a generation is never written again.
   * Concurrent calls share one pass and run it again afterwards.
   */
  let pruning: Promise<void> | undefined;
  let pruneAgain = false;
  async function prunePass() {
    immediate(db, () =>
      db.run(
        `UPDATE agent_session_snapshot SET status='discarded' WHERE status<>'discarded' AND (
          EXISTS(SELECT 1 FROM agent_session_snapshot newer
            WHERE newer.run_id=agent_session_snapshot.run_id
              AND newer.generation>agent_session_snapshot.generation AND newer.status='sealed')
          OR EXISTS(SELECT 1 FROM run r WHERE r.id=agent_session_snapshot.run_id AND (
            r.status='lost' OR (r.status='ended' AND NOT EXISTS(
              SELECT 1 FROM work_item w WHERE w.id=r.item_id AND w.current_run_id=r.id))))
          OR EXISTS(SELECT 1 FROM work_item w WHERE w.id=agent_session_snapshot.item_id
            AND w.state IN ('completed','merged','cancelled','failed')))`,
      ),
    );
    for (;;) {
      const chunks = db
        .query<
          {
            runId: string;
            generation: number;
            workspaceId: string;
            offset: number;
            sha256: string;
          },
          [number]
        >(
          `SELECT c.run_id AS runId,c.generation,s.workspace_id AS workspaceId,c.offset,c.sha256
          FROM agent_session_snapshot_chunk c JOIN agent_session_snapshot s
            ON s.run_id=c.run_id AND s.generation=c.generation
          WHERE s.status='discarded' LIMIT ?`,
        )
        .all(PRUNE_BATCH);
      if (!chunks.length) return;
      for (const chunk of chunks) await objects.delete(files.objectKey(file(chunk).prefix, chunk));
      immediate(db, () => {
        for (const chunk of chunks)
          db.run(
            "DELETE FROM agent_session_snapshot_chunk WHERE run_id=? AND generation=? AND offset=?",
            [chunk.runId, chunk.generation, chunk.offset],
          );
      });
    }
  }
  async function prune(): Promise<void> {
    if (pruning) {
      pruneAgain = true;
      return pruning;
    }
    pruning = (async () => {
      try {
        do {
          pruneAgain = false;
          await prunePass();
        } while (pruneAgain);
      } finally {
        pruning = undefined;
      }
    })();
    return pruning;
  }

  return {
    snapshot,
    async upload(access: Access, raw: AgentSessionChunk) {
      const chunk = AgentSessionChunkSchema.parse(raw);
      return files.upload(
        access.runId,
        chunk,
        maxBytes,
        () => {
          const row = rowFor(access, chunk.generation);
          return { ...file(row), sizeBytes: row.sizeBytes, open: row.status === "uploading" };
        },
        // A prune discarded the snapshot while the chunk was being written; nothing references it.
        () => snapshot(access.runId, chunk.generation)?.status === "discarded",
      );
    },
    async finish(access: Access, raw: AgentSessionFinish) {
      const finish = AgentSessionFinishSchema.parse(raw);
      if (finish.sizeBytes > maxBytes) refused();
      const check = () => {
        const row = rowFor(access, finish.generation);
        if (row.status === "sealed") {
          if (!sameFinish(row, finish)) refused();
        } else if (row.sizeBytes !== finish.sizeBytes) refused();
        return row;
      };
      const initial = immediate(db, check);
      if (initial.status === "sealed") return receipt(initial);
      await files.verify(file(initial), finish.sizeBytes, finish.sha256);
      const sealed = immediate(db, () => {
        const row = check();
        if (row.status === "sealed") return receipt(row);
        db.run(
          `UPDATE agent_session_snapshot SET owner_user_id=?,agent=?,agent_version=?,session_id=?,
          workspace_path=?,commit_sha=?,turn=?,sealed_size=?,sha256=?,status='sealed',sealed_at=?
          WHERE run_id=? AND generation=? AND status='uploading'`,
          [
            work.identity(access.runnerId).userId,
            finish.agent,
            finish.agentVersion,
            finish.sessionId,
            finish.workspacePath,
            finish.commitSha,
            finish.turn,
            finish.sizeBytes,
            finish.sha256,
            now(),
            access.runId,
            finish.generation,
          ],
        );
        return receipt(snapshot(access.runId, finish.generation)!);
      });
      // The seal stands even if the prune fails; the coordinator's sweep retries it.
      await prune().catch((error: unknown) =>
        journalCaught(error, "agent-sessions.finish.prune", null),
      );
      return sealed;
    },
    prune,
    /**
     * Decrypted chunks of a sealed snapshot for the runner that holds the run's current grant
     * (`access.generation`). Access is checked before the first chunk and again before each one.
     */
    read(access: Access & { generation: number }, generation: number): AsyncGenerator<Uint8Array> {
      const row = readable(access, generation);
      return files.read(file(row), row.sealedSize!, row.sha256!, () =>
        readable(access, generation),
      );
    },
  };
}
export type AgentSessions = ReturnType<typeof createAgentSessions>;
