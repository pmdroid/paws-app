import { expect, test } from "bun:test";
import { beginImplementRun, getWorkItem, insertQueuedItem, saveCheckpoint } from "../src/db";
import { recordRunnerCheckpoint } from "../src/runner-backend";
import { tempStore } from "./pglite";

const BASE = "a".repeat(40);
const MAIN = "b".repeat(40);
const FIRST = "c".repeat(40);
const SECOND = "d".repeat(40);

test("a runner checkpoint records the main its run was given, and only for that checkpoint", async () => {
  const { db, close } = await tempStore();
  const item = await insertQueuedItem(db, { id: "item", now: 1, branchName: "paws/item" });
  const { run } = await beginImplementRun(db, item.id, 1);
  await saveCheckpoint(db, item.id, { phase: "running", baseSha: BASE, wipCommit: BASE });
  const record = (sha: string, mainSha?: string) =>
    recordRunnerCheckpoint(db, {
      itemId: item.id,
      runId: run.id,
      baseSha: BASE,
      ...(mainSha ? { mainSha } : {}),
      event: { type: "checkpoint", reason: "interval", sha },
      now: 2,
    });

  await record(FIRST, MAIN);
  expect((await getWorkItem(db, item.id))?.checkpoint).toMatchObject({
    wipCommit: FIRST,
    checkpointMain: { sha: FIRST, main: MAIN },
  });
  await record(SECOND);
  const checkpoint = (await getWorkItem(db, item.id))?.checkpoint;
  expect(checkpoint?.wipCommit).toBe(SECOND);
  expect(checkpoint?.checkpointMain).toBeUndefined();
  await close();
});
