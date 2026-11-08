import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  agentSessionSnapshotRowSteps,
  deleteAgentSessionChunkSteps,
  discardedAgentSessionChunksSteps,
  discardUnusableAgentSessionSnapshotsSteps,
  insertAgentSessionSnapshotSteps,
  sealAgentSessionSnapshotSteps,
  type AgentSessionSnapshotSeal,
  type Db,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

const SEAL: AgentSessionSnapshotSeal = {
  ownerUserId: "owner",
  agent: "claude",
  agentVersion: "1.0",
  sessionId: "session",
  workspacePath: "/work",
  commitSha: "abc",
  turn: 2,
  sealedSize: 0,
  sha256: "a".repeat(64),
  sealedAt: 9,
};

function snapshot(db: Db, runId: string, generation: number, itemId = "item") {
  return db.run((q) =>
    insertAgentSessionSnapshotSteps(q, {
      runId,
      generation,
      itemId,
      workspaceId: "workspace",
      runnerId: "runner",
      createdAt: 1,
    }),
  );
}

function seal(db: Db, runId: string, generation: number, values = SEAL) {
  return db.run((q) => sealAgentSessionSnapshotSteps(q, runId, generation, values));
}

function run(db: Db, id: string, status: string, itemId = "item") {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.run)
      .values({ id, itemId, kind: "agent", agent: "claude", status, createdAt: 0, updatedAt: 0 }),
  );
}

function workItem(db: Db, id: string, state: string, currentRunId: string | null = null) {
  return seed(db, (q) =>
    q.orm.insert(q.t.workItem).values({
      id,
      delegationId: `delegation-${id}`,
      linearIssueId: `issue-${id}`,
      linearIdentifier: id,
      title: id,
      state,
      branchName: `paws/${id}`,
      position: 0,
      createdAt: 0,
      currentRunId,
    }),
  );
}

function snapshotStatus(db: Db, runId: string, generation: number) {
  return db
    .run((q) => agentSessionSnapshotRowSteps(q, runId, generation))
    .then((row) => row?.status);
}

function chunk(db: Db, runId: string, generation: number, offset: number) {
  return seed(db, (q) =>
    q.orm.insert(q.t.agentSessionSnapshotChunk).values({
      runId,
      generation,
      offset,
      sizeBytes: 1,
      sha256: "b".repeat(64),
      keyId: "c".repeat(64),
    }),
  );
}

forEachDialect((connect) => {
  test("a new snapshot starts uploading and empty", async () => {
    const db = await connected(connect);
    await snapshot(db, "run", 1);

    expect(await db.run((q) => agentSessionSnapshotRowSteps(q, "run", 1))).toEqual({
      runId: "run",
      generation: 1,
      itemId: "item",
      workspaceId: "workspace",
      runnerId: "runner",
      ownerUserId: null,
      agent: null,
      agentVersion: null,
      sessionId: null,
      workspacePath: null,
      commitSha: null,
      turn: null,
      sizeBytes: 0,
      sealedSize: null,
      sha256: null,
      status: "uploading",
      createdAt: 1,
      sealedAt: null,
    });
    expect(await db.run((q) => agentSessionSnapshotRowSteps(q, "run", 2))).toBeNull();
  });

  test("sealing writes the finish once and leaves other generations alone", async () => {
    const db = await connected(connect);
    await snapshot(db, "run", 1);
    await snapshot(db, "run", 2);

    await seal(db, "run", 1);
    await seal(db, "run", 1, { ...SEAL, turn: 7 });

    expect(await db.run((q) => agentSessionSnapshotRowSteps(q, "run", 1))).toMatchObject({
      ...SEAL,
      status: "sealed",
    });
    expect(await snapshotStatus(db, "run", 2)).toBe("uploading");
  });

  test("a sealed newer generation discards the older ones of its run only", async () => {
    const db = await connected(connect);
    await run(db, "run", "active");
    await run(db, "other", "active");
    await workItem(db, "item", "running", "run");
    await snapshot(db, "run", 1);
    await snapshot(db, "run", 2);
    await snapshot(db, "run", 3);
    await snapshot(db, "other", 1);
    await seal(db, "run", 2);

    await db.run((q) => discardUnusableAgentSessionSnapshotsSteps(q));

    expect(await snapshotStatus(db, "run", 1)).toBe("discarded");
    expect(await snapshotStatus(db, "run", 2)).toBe("sealed");
    expect(await snapshotStatus(db, "run", 3)).toBe("uploading");
    expect(await snapshotStatus(db, "other", 1)).toBe("uploading");
  });

  test("a lost run or a replaced ended run loses its snapshots", async () => {
    const db = await connected(connect);
    await workItem(db, "item", "running", "current");
    await run(db, "lost", "lost");
    await run(db, "replaced", "ended");
    await run(db, "current", "ended");
    await run(db, "active", "active");
    await snapshot(db, "lost", 1);
    await snapshot(db, "replaced", 1);
    await snapshot(db, "current", 1);
    await snapshot(db, "active", 1);

    await db.run((q) => discardUnusableAgentSessionSnapshotsSteps(q));

    expect(await snapshotStatus(db, "lost", 1)).toBe("discarded");
    expect(await snapshotStatus(db, "replaced", 1)).toBe("discarded");
    expect(await snapshotStatus(db, "current", 1)).toBe("uploading");
    expect(await snapshotStatus(db, "active", 1)).toBe("uploading");
  });

  test("a finished work item loses its snapshots", async () => {
    const db = await connected(connect);
    for (const state of ["completed", "merged", "cancelled", "failed", "running"]) {
      await workItem(db, state, state);
      await run(db, `run-${state}`, "active", state);
      await snapshot(db, `run-${state}`, 1, state);
    }

    await db.run((q) => discardUnusableAgentSessionSnapshotsSteps(q));

    for (const state of ["completed", "merged", "cancelled", "failed"])
      expect(await snapshotStatus(db, `run-${state}`, 1)).toBe("discarded");
    expect(await snapshotStatus(db, "run-running", 1)).toBe("uploading");
  });

  test("only chunks of discarded snapshots are listed, up to the limit", async () => {
    const db = await connected(connect);
    await snapshot(db, "gone", 1);
    await snapshot(db, "kept", 1);
    await chunk(db, "gone", 1, 0);
    await chunk(db, "gone", 1, 524288);
    await chunk(db, "kept", 1, 0);
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.agentSessionSnapshot)
          .set({ status: "discarded" })
          .where(eq(q.t.agentSessionSnapshot.runId, "gone")),
      ),
    );

    const listed = await db.run((q) => discardedAgentSessionChunksSteps(q, 10));
    expect(listed.toSorted((a, b) => a.offset - b.offset)).toEqual([
      {
        runId: "gone",
        generation: 1,
        workspaceId: "workspace",
        offset: 0,
        sha256: "b".repeat(64),
      },
      {
        runId: "gone",
        generation: 1,
        workspaceId: "workspace",
        offset: 524288,
        sha256: "b".repeat(64),
      },
    ]);
    expect(await db.run((q) => discardedAgentSessionChunksSteps(q, 1))).toHaveLength(1);
  });

  test("deleting a chunk removes that offset only", async () => {
    const db = await connected(connect);
    await snapshot(db, "gone", 1);
    await chunk(db, "gone", 1, 0);
    await chunk(db, "gone", 1, 524288);
    await db.run((q) =>
      q.exec(q.orm.update(q.t.agentSessionSnapshot).set({ status: "discarded" })),
    );

    await db.run((q) =>
      deleteAgentSessionChunkSteps(q, { runId: "gone", generation: 1, offset: 0 }),
    );

    const left = await db.run((q) => discardedAgentSessionChunksSteps(q, 10));
    expect(left.map((row) => row.offset)).toEqual([524288]);
  });
});
