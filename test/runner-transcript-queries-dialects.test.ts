import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  enqueueJobSteps,
  insertRunnerTranscriptSteps,
  jobStatusByKeySteps,
  plaintextTranscriptChunksSteps,
  runnerTranscriptSteps,
  sealRunnerTranscriptSteps,
  setRunnerTranscriptUriSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

forEachDialect((open) => {
  test("a job's status reads by its key", async () => {
    const db = await connect(open);
    expect(await db.run((q) => jobStatusByKeySteps(q, "once"))).toBeNull();
    await db.run(function* (q) {
      const id = yield* enqueueJobSteps(q, { queue: "tick", jobKey: "once", now: 0 });
      expect(yield* jobStatusByKeySteps(q, "once")).toBe("pending");
      yield* q.exec(q.orm.update(q.t.job).set({ status: "done" }).where(eq(q.t.job.id, id)));
    });
    expect(await db.run((q) => jobStatusByKeySteps(q, "once"))).toBe("done");
  });

  test("a transcript row is stored, sealed and given its URI", async () => {
    const db = await connect(open);
    await db.run((q) =>
      insertRunnerTranscriptSteps(q, {
        runId: "r1",
        generation: 1,
        commandId: "c1",
        workspaceId: "acme",
        executionId: "e1",
      }),
    );
    expect(await db.run((q) => runnerTranscriptSteps(q, "r1", 1))).toEqual({
      commandId: "c1",
      workspaceId: "acme",
      executionId: "e1",
      sizeBytes: 0,
      sealedSize: null,
      sha256: null,
      uri: null,
    });
    expect(await db.run((q) => runnerTranscriptSteps(q, "r1", 2))).toBeNull();
    await db.run((q) =>
      sealRunnerTranscriptSteps(q, {
        runId: "r1",
        generation: 1,
        sizeBytes: 0,
        sha256: "a".repeat(64),
      }),
    );
    await db.run((q) => setRunnerTranscriptUriSteps(q, "r1", 1, "paws-run-file:transcript/x"));
    expect(await db.run((q) => runnerTranscriptSteps(q, "r1", 1))).toMatchObject({
      sealedSize: 0,
      sha256: "a".repeat(64),
      uri: "paws-run-file:transcript/x",
    });
  });

  test("plaintext transcript chunks page in key order after the last one", async () => {
    const db = await connect(open);
    const transcript = (runId: string, generation: number) => (q: Q) =>
      q.orm.insert(q.t.runnerTranscript).values({
        runId,
        generation,
        commandId: `c-${runId}-${generation}`,
        workspaceId: "acme",
        executionId: `e-${runId}`,
      });
    const chunk =
      (runId: string, generation: number, offset: number, keyId: string | null = null) =>
      (q: Q) =>
        q.orm.insert(q.t.runnerTranscriptChunk).values({
          runId,
          generation,
          offset,
          sizeBytes: 1,
          sha256: "b".repeat(64),
          keyId,
        });
    await seed(
      db,
      transcript("a", 1),
      transcript("a", 2),
      transcript("b", 1),
      chunk("a", 1, 0),
      chunk("a", 1, 1, "k".repeat(64)),
      chunk("a", 1, 2),
      chunk("a", 2, 0),
      chunk("b", 1, 0),
    );
    const page = async (after: readonly [string, number, number], limit: number) =>
      (await db.run((q) => plaintextTranscriptChunksSteps(q, after, limit))).map(
        (row) => `${row.runId}/${row.generation}/${row.offset}`,
      );
    expect(await page(["", 0, -1], 2)).toEqual(["a/1/0", "a/1/2"]);
    expect(await page(["a", 1, 2], 2)).toEqual(["a/2/0", "b/1/0"]);
    expect(await page(["b", 1, 0], 2)).toEqual([]);
    const [first] = await db.run((q) => plaintextTranscriptChunksSteps(q, ["", 0, -1], 1));
    expect(first).toEqual({
      runId: "a",
      generation: 1,
      offset: 0,
      sizeBytes: 1,
      sha256: "b".repeat(64),
      workspaceId: "acme",
      commandId: "c-a-1",
      executionId: "e-a",
    });
  });
});
