import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { handleStatusRequest } from "../src/dashboard";
import {
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  saveCloseoutLogRetentionDays,
  type CloseoutStepWrite,
  type Db,
} from "../src/db";
import {
  closeoutLogStorage,
  removeEvidenceFile,
  withCloseoutOutput,
  type EvidenceStorage,
} from "../src/evidence";
import { createDbCloseoutProgress } from "../src/loop/closeout-progress";
import { createFakeRunFileObjects } from "../src/run-files";
import { pruneCloseoutLogs } from "../src/runner-work";
import { insertWorkItem } from "./dialects";
import { tempStore } from "./pglite";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const HEAD = "c".repeat(40);
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
  const { db, close } = await tempStore();
  const home = mkdtempSync(join(tmpdir(), "paws-closeout-logs-"));
  cleanup.push(close, () => rmSync(home, { recursive: true, force: true }));
  const objects = createFakeRunFileObjects();
  return { db, objects, storage: closeoutLogStorage(home, () => objects) };
}

const identity = (taskId: string) => ({
  taskId,
  base: "d".repeat(40),
  head: HEAD,
  policyDigest: "sha256:policy",
  policyPath: null,
});

function step(state: CloseoutStepWrite["state"]): CloseoutStepWrite {
  return {
    id: "unit",
    kind: "command",
    state,
    command: "bun test",
    detail: null,
    attempt: 1,
    timeoutSeconds: null,
    startedAt: NOW,
    finishedAt: state === "running" ? null : NOW,
    exitCode: state === "running" ? null : 1,
    timedOut: false,
    timeoutReason: null,
    truncated: false,
    logPath: null,
    evidencePath: null,
    findings: null,
    ordinal: 0,
  };
}

function stepRows(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          stdout: q.t.closeoutStep.stdout,
          stderr: q.t.closeoutStep.stderr,
          key: q.t.closeoutStep.outputKey,
        })
        .from(q.t.closeoutStep),
    ),
  );
}

async function seedFailedCheck(db: Db, id: string) {
  const item = await insertQueuedItem(db, { id, sessionKey: "ses_1", now: NOW });
  await beginImplementRun(db, item.id, NOW);
  await enterMergeQueue(db, item.id, {
    phase: "merge_queue",
    baseSha: "d".repeat(40),
    wipCommit: HEAD,
  });
  return item;
}

test("a new Closeout run's log reads back through the check-log route from the store", async () => {
  const { db, objects, storage } = await setup();
  const item = await seedFailedCheck(db, "ENG-1");
  const progress = createDbCloseoutProgress(db, item.id, () => NOW, storage);
  await progress.begin(identity(item.id));
  await progress.step(identity(item.id), step("running"));
  await progress.output(identity(item.id), "unit", "stdout", "1 pass\n", false);
  await progress.output(identity(item.id), "unit", "stderr", "1 fail ✗\n", false);
  await progress.step(identity(item.id), step("failed"));
  await progress.finish(identity(item.id), "rejected");

  const [row] = await stepRows(db);
  expect(row).toMatchObject({ stdout: "", stderr: "" });
  expect(row!.key).not.toBeNull();
  expect(objects.writes).toHaveLength(1);

  const response = await handleStatusRequest(
    new Request("http://127.0.0.1/api/issues/ENG-1/attempts/1/checks/unit/log"),
    {
      store: db,
      sessionIds: ["ses_1"],
      closeoutOutput: (record) => withCloseoutOutput(db, storage, record),
    },
  );
  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject({
    stdout: "1 pass\n",
    stderr: "1 fail ✗\n",
    truncated: false,
  });
});

async function endedItem(
  db: Db,
  storage: EvidenceStorage,
  id: string,
  state: string,
  endedAt: number,
) {
  await insertWorkItem(db, id);
  await db.run(function* (q) {
    yield* q.exec(q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, id)));
    yield* q.exec(
      q.orm.insert(q.t.workItemEvent).values({
        itemId: id,
        version: 1,
        at: endedAt,
        fromState: "merge_queue",
        toState: state,
        event: "merged",
      }),
    );
  });
  const progress = createDbCloseoutProgress(db, id, () => endedAt, storage);
  await progress.step(identity(id), step("running"));
  await progress.output(identity(id), "unit", "stdout", `${id} out`, false);
  await progress.step(identity(id), step("failed"));
}

test("retention deletes the output of items that ended more than the setting's days ago", async () => {
  const { db, objects, storage } = await setup();
  await endedItem(db, storage, "old", "merged", NOW - 15 * DAY);
  await endedItem(db, storage, "recent", "merged", NOW - 13 * DAY);
  await endedItem(db, storage, "open", "running", NOW - 30 * DAY);
  expect(objects.objects.size).toBe(3);
  const remove = (key: string) => removeEvidenceFile(db, storage, key);
  const keys = async () => (await stepRows(db)).map((row) => row.key);

  await saveCloseoutLogRetentionDays(db, 0, NOW);
  expect(await pruneCloseoutLogs({ store: db, now: NOW + 365 * DAY, remove })).toBe(0);
  expect((await keys()).filter((key) => key !== null)).toHaveLength(3);

  await saveCloseoutLogRetentionDays(db, 14, NOW);
  expect(await pruneCloseoutLogs({ store: db, now: NOW, remove })).toBe(1);
  expect(objects.objects.size).toBe(2);
  const rows = await db.run((q) =>
    q.all(
      q.orm
        .select({ itemId: q.t.closeoutProgress.itemId, key: q.t.closeoutStep.outputKey })
        .from(q.t.closeoutStep)
        .innerJoin(q.t.closeoutProgress, eq(q.t.closeoutProgress.id, q.t.closeoutStep.progressId)),
    ),
  );
  expect(rows.filter((row) => row.key === null).map((row) => row.itemId)).toEqual(["old"]);
  expect(await pruneCloseoutLogs({ store: db, now: NOW, remove })).toBe(0);
});
