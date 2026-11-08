import { expect, test } from "bun:test";
import {
  listRunFileChunksSteps,
  recordRunFileChunkSteps,
  runFileChunkSteps,
  setRunFileChunkKeySteps,
  type Db,
  type Q,
  type RunFileChunkKind,
} from "../src/db";
import { forEachDialect, withoutForeignKeys, type DialectDb } from "./dialects";

const SHA = "a".repeat(64);
const KEY = "b".repeat(64);
const CHUNK_BYTES = 524_288;

function* seedParents(q: Q) {
  yield* q.exec(
    q.orm.insert(q.t.runnerTranscript).values({
      runId: "run",
      generation: 1,
      commandId: "command",
      workspaceId: "acme",
      executionId: "execution",
    }),
  );
  yield* q.exec(
    q.orm.insert(q.t.agentSessionSnapshot).values({
      runId: "run",
      generation: 1,
      itemId: "item",
      workspaceId: "acme",
      runnerId: "box",
      createdAt: 0,
    }),
  );
}

function* parentSize(q: Q, kind: RunFileChunkKind) {
  const table = kind === "transcript" ? q.t.runnerTranscript : q.t.agentSessionSnapshot;
  const row = yield* q.one(q.orm.select({ size: table.sizeBytes }).from(table));
  return row?.size;
}

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened: DialectDb = await open();
    try {
      await withoutForeignKeys(opened.db);
      await opened.db.run(seedParents);
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  for (const kind of ["transcript", "agent_session"] as const) {
    const file = { kind, runId: "run", generation: 1 };

    test(`${kind}: a recorded chunk reads back and moves the file size`, () =>
      withDb(async (db) => {
        expect(await db.run((q) => runFileChunkSteps(q, file, 0))).toBeNull();
        const second = { offset: CHUNK_BYTES, sizeBytes: 5, sha256: SHA, keyId: KEY };
        const first = { offset: 0, sizeBytes: CHUNK_BYTES, sha256: SHA, keyId: KEY };
        await db.run((q) => recordRunFileChunkSteps(q, file, second, CHUNK_BYTES + 5));
        await db.run((q) => recordRunFileChunkSteps(q, file, first, CHUNK_BYTES));
        expect(await db.run((q) => runFileChunkSteps(q, file, 0))).toEqual(first);
        expect(await db.run((q) => listRunFileChunksSteps(q, file))).toEqual([first, second]);
        expect(await db.run((q) => parentSize(q, kind))).toBe(CHUNK_BYTES);
      }));
  }

  test("a chunk's key is recorded only while it has none and its hash still matches", () =>
    withDb(async (db) => {
      const file = { kind: "transcript" as const, runId: "run", generation: 1 };
      const chunk = { offset: 0, sizeBytes: 5, sha256: SHA, keyId: null };
      await db.run((q) => recordRunFileChunkSteps(q, file, chunk, 5));
      await db.run((q) =>
        setRunFileChunkKeySteps(q, file, { offset: 0, sha256: "c".repeat(64) }, KEY),
      );
      expect((await db.run((q) => runFileChunkSteps(q, file, 0)))?.keyId).toBeNull();
      await db.run((q) => setRunFileChunkKeySteps(q, file, chunk, KEY));
      expect((await db.run((q) => runFileChunkSteps(q, file, 0)))?.keyId).toBe(KEY);
      await db.run((q) => setRunFileChunkKeySteps(q, file, chunk, "d".repeat(64)));
      expect((await db.run((q) => runFileChunkSteps(q, file, 0)))?.keyId).toBe(KEY);
    }));
});
