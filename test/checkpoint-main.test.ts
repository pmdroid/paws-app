import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  saveCheckpoint,
  sqliteDb,
} from "../src/db";
import { recordRunnerCheckpoint } from "../src/runner-backend";
import { migratedDatabase } from "./helpers";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BASE = "a".repeat(40);
const MAIN = "b".repeat(40);
const FIRST = "c".repeat(40);
const SECOND = "d".repeat(40);

test("a runner checkpoint records the main its run was given, and only for that checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-checkpoint-main-"));
  roots.push(root);
  const db = migratedDatabase(join(root, "paws.db"));
  const item = insertQueuedItem(db, { id: "item", now: 1, branchName: "paws/item" });
  const { run } = await beginImplementRun(sqliteDb(db), item.id, 1);
  await saveCheckpoint(sqliteDb(db), item.id, { phase: "running", baseSha: BASE, wipCommit: BASE });
  const record = (sha: string, mainSha?: string) =>
    recordRunnerCheckpoint(sqliteDb(db), {
      itemId: item.id,
      runId: run.id,
      baseSha: BASE,
      ...(mainSha ? { mainSha } : {}),
      event: { type: "checkpoint", reason: "interval", sha },
      now: 2,
    });

  await record(FIRST, MAIN);
  expect((await getWorkItem(sqliteDb(db), item.id))?.checkpoint).toMatchObject({
    wipCommit: FIRST,
    checkpointMain: { sha: FIRST, main: MAIN },
  });
  await record(SECOND);
  const checkpoint = (await getWorkItem(sqliteDb(db), item.id))?.checkpoint;
  expect(checkpoint?.wipCommit).toBe(SECOND);
  expect(checkpoint?.checkpointMain).toBeUndefined();
  db.close();
});
