import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { immediate } from "../db";
import type { RunnerWork } from "../runner-work";
import { agentSessionKeyId, openAgentSessionChunk, sealAgentSessionChunk } from "./key";
import type { AgentSessionObjects } from "./objects";
import {
  AgentSessionChunkSchema,
  AgentSessionFinishSchema,
  AGENT_SESSION_CHUNK_BYTES,
  AGENT_SESSION_MAX_BYTES,
  type AgentSessionChunk,
  type AgentSessionFinish,
} from "./schema";

export class AgentSessionStorageError extends Error {}
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
type Chunk = { offset: number; sizeBytes: number; sha256: string; keyId: string };

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function refused(): never {
  throw new AgentSessionRefusedError("Agent session request is refused");
}
function unavailable(): never {
  throw new AgentSessionStorageError("Agent session storage is unavailable");
}

export function createAgentSessions(options: {
  db: Database;
  work: RunnerWork;
  objects: AgentSessionObjects;
  /** The 32-byte key from `loadAgentSessionKey`. */
  key: Buffer;
  now?: () => number;
  /** A lower cap than `AGENT_SESSION_MAX_BYTES`, for tests. */
  maxBytes?: number;
}) {
  const { db, work, objects, key } = options;
  if (key.length !== 32) throw new Error("Agent session key is invalid.");
  const keyId = agentSessionKeyId(key);
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
  function objectKey(row: AgentSessionSnapshot, chunk: { offset: number; sha256: string }) {
    return `paws/agent-sessions/${row.workspaceId}/${row.runId}/${row.generation}/${chunk.offset}-${chunk.sha256}`;
  }
  function existing(runId: string, generation: number, offset: number) {
    return db
      .query<Chunk, [string, number, number]>(
        `SELECT offset,size_bytes AS sizeBytes,sha256,key_id AS keyId FROM agent_session_snapshot_chunk
        WHERE run_id=? AND generation=? AND offset=?`,
      )
      .get(runId, generation, offset);
  }
  /** Decrypted chunks in order, each checked against its recorded size and sha256. */
  async function* decrypted(row: AgentSessionSnapshot, before?: () => void) {
    const chunks = db
      .query<Chunk, [string, number]>(
        `SELECT offset,size_bytes AS sizeBytes,sha256,key_id AS keyId FROM agent_session_snapshot_chunk
        WHERE run_id=? AND generation=? ORDER BY offset`,
      )
      .all(row.runId, row.generation);
    let total = 0;
    for (const chunk of chunks) {
      before?.();
      if (chunk.offset !== total || chunk.keyId !== keyId) unavailable();
      let bytes: Buffer;
      try {
        const sealed = await objects.read(objectKey(row, chunk));
        bytes = openAgentSessionChunk(
          key,
          {
            runId: row.runId,
            generation: row.generation,
            offset: chunk.offset,
            sha256: chunk.sha256,
          },
          sealed,
        );
      } catch {
        unavailable();
      }
      if (bytes.length !== chunk.sizeBytes || hash(bytes) !== chunk.sha256) unavailable();
      total += bytes.length;
      yield bytes;
    }
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

  return {
    snapshot,
    async upload(access: Access, raw: AgentSessionChunk) {
      const chunk = AgentSessionChunkSchema.parse(raw);
      const bytes = Buffer.from(chunk.data, "base64");
      if (
        !bytes.length ||
        bytes.length > AGENT_SESSION_CHUNK_BYTES ||
        bytes.toString("base64") !== chunk.data ||
        hash(bytes) !== chunk.sha256 ||
        chunk.offset % AGENT_SESSION_CHUNK_BYTES !== 0 ||
        chunk.offset + bytes.length > maxBytes
      )
        refused();
      const check = () => {
        const row = rowFor(access, chunk.generation);
        const previous = existing(access.runId, chunk.generation, chunk.offset);
        if (previous) {
          if (previous.sha256 !== chunk.sha256 || previous.sizeBytes !== bytes.length) refused();
        } else if (row.status !== "uploading" || row.sizeBytes !== chunk.offset) refused();
        return { row, previous };
      };
      const initial = immediate(db, check);
      if (initial.previous) return { offset: chunk.offset + bytes.length, duplicate: true };
      const sealed = sealAgentSessionChunk(
        key,
        {
          runId: access.runId,
          generation: chunk.generation,
          offset: chunk.offset,
          sha256: chunk.sha256,
        },
        bytes,
      );
      try {
        await objects.write(objectKey(initial.row, chunk), sealed);
      } catch {
        unavailable();
      }
      return immediate(db, () => {
        const current = check();
        if (!current.previous) {
          db.run("INSERT INTO agent_session_snapshot_chunk VALUES(?,?,?,?,?,?)", [
            access.runId,
            chunk.generation,
            chunk.offset,
            bytes.length,
            chunk.sha256,
            keyId,
          ]);
          db.run("UPDATE agent_session_snapshot SET size_bytes=? WHERE run_id=? AND generation=?", [
            chunk.offset + bytes.length,
            access.runId,
            chunk.generation,
          ]);
        }
        return { offset: chunk.offset + bytes.length, duplicate: !!current.previous };
      });
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
      const digest = createHash("sha256");
      let total = 0;
      for await (const bytes of decrypted(initial)) {
        digest.update(bytes);
        total += bytes.length;
      }
      if (total !== finish.sizeBytes || digest.digest("hex") !== finish.sha256) refused();
      return immediate(db, () => {
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
    },
    /**
     * Decrypted chunks of a sealed snapshot for the runner that holds the run's current grant
     * (`access.generation`). Access is checked before the first chunk and again before each one.
     */
    read(access: Access & { generation: number }, generation: number): AsyncGenerator<Uint8Array> {
      const row = readable(access, generation);
      return (async function* () {
        const digest = createHash("sha256");
        let total = 0;
        for await (const bytes of decrypted(row, () => readable(access, generation))) {
          digest.update(bytes);
          total += bytes.length;
          yield bytes;
        }
        if (total !== row.sealedSize || digest.digest("hex") !== row.sha256) unavailable();
      })();
    },
  };
}
export type AgentSessions = ReturnType<typeof createAgentSessions>;
