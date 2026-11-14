import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { handleStatusRequest } from "../src/dashboard";
import {
  beginImplementRun,
  legacyCloseoutOutputsSteps,
  clearCloseoutOutputSteps,
  pointCloseoutOutputSteps,
  enterMergeQueue,
  getEvidenceObject,
  listAgentCloseout,
  recordAgentCloseout,
  insertQueuedItem,
  saveCloseoutLogRetentionDays,
  type CloseoutStepWrite,
  type Db,
} from "../src/db";
import {
  closeoutLogStorage,
  removeEvidenceFile,
  withCloseoutOutput,
  uploadLocalCloseoutLogs,
  storeCloseoutOutput,
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
  for (const undo of cleanup.splice(0).reverse()) await undo();
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
  let hydrated = 0;
  const detail = await handleStatusRequest(new Request("http://127.0.0.1/api/issues/ENG-1"), {
    store: db,
    sessionIds: ["ses_1"],
    closeoutOutput: async (record) => {
      const output = await withCloseoutOutput(db, storage, record);
      if (output.stderr === "1 fail ✗\n") hydrated++;
      return output;
    },
  });
  expect(detail?.status).toBe(200);
  expect(hydrated).toBeGreaterThan(0);
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
  expect(await pruneCloseoutLogs({ store: db, storage, now: NOW + 365 * DAY, remove })).toBe(0);
  expect((await keys()).filter((key) => key !== null)).toHaveLength(3);

  await saveCloseoutLogRetentionDays(db, 14, NOW);
  expect(await pruneCloseoutLogs({ store: db, storage, now: NOW, remove })).toBe(1);
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
  expect(await pruneCloseoutLogs({ store: db, storage, now: NOW, remove })).toBe(0);
});

test("retention preserves both pointers after failed deletion and retries", async () => {
  const { db, objects, storage } = await setup();
  await endedItem(db, storage, "old", "merged", NOW - 15 * DAY);
  const key = (await stepRows(db))[0]!.key!;
  const metadata = await getEvidenceObject(db, key);
  const remove = (id: string) => removeEvidenceFile(db, storage, id);
  const deleting = objects.delete;
  objects.delete = async () => {
    throw new Error("S3 unavailable");
  };
  await expect(pruneCloseoutLogs({ store: db, storage, now: NOW, remove })).rejects.toThrow(
    "S3 unavailable",
  );
  expect((await stepRows(db))[0]!.key).toBe(key);
  expect(await getEvidenceObject(db, key)).toEqual(metadata);
  objects.delete = deleting;
  expect(await pruneCloseoutLogs({ store: db, storage, now: NOW, remove })).toBe(1);
  expect(await getEvidenceObject(db, key)).toBeNull();
  expect((await stepRows(db))[0]!.key).toBeNull();
  expect(objects.objects.size).toBe(0);
});

test("local step and agent logs upload when object storage is enabled", async () => {
  const { db, objects, storage } = await setup();
  const local = { root: storage.root };
  await endedItem(db, local, "old", "merged", NOW - 15 * DAY);
  const location = { itemId: "old", headCommit: HEAD, checkId: "unit" };
  const output = await storeCloseoutOutput(
    db,
    local,
    location,
    { stdout: "agent output", stderr: "" },
    NOW,
  );
  await recordAgentCloseout(
    db,
    "run",
    "old",
    {
      type: "finished",
      head: HEAD,
      id: "unit",
      kind: "command",
      command: "bun test",
      attempt: 1,
      maxAttempts: null,
      state: "failed",
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      stdout: "",
      stderr: "",
      truncated: false,
      output,
    },
    NOW,
  );
  expect(await uploadLocalCloseoutLogs(db, storage)).toBe(2);
  expect(await uploadLocalCloseoutLogs(db, storage)).toBe(0);
  const event = (await listAgentCloseout(db, ["run"]))[0]!;
  if (event.progress.type !== "finished") throw new Error("Expected finished event");
  expect(await withCloseoutOutput(db, storage, event.progress)).toMatchObject({
    stdout: "agent output",
  });
  const key = (await stepRows(db))[0]!.key!;
  const metadata = await getEvidenceObject(db, key);
  expect(metadata).not.toBeNull();
  expect(objects.objects.size).toBe(2);
  const stepPointer = await db.run((q) => q.one(q.orm.select().from(q.t.closeoutStep)));
  expect(
    await withCloseoutOutput(db, storage, {
      stdout: "",
      stderr: "",
      output: {
        key,
        bytes: stepPointer!.outputBytes!,
        sha256: stepPointer!.outputSha256!,
      },
    }),
  ).toMatchObject({ stdout: "old out" });
});

async function legacyRows(db: Db, count: number, at = NOW) {
  await insertWorkItem(db, "legacy");
  const progress = createDbCloseoutProgress(db, "legacy", () => at);
  for (let i = 0; i < count; i++) {
    const id = String(i);
    await progress.step(identity("legacy"), { ...step("running"), id });
    await progress.output(identity("legacy"), id, "stdout", `out ${i}`, false);
    await progress.output(identity("legacy"), id, "stderr", `err ${i}`, false);
    await progress.step(identity("legacy"), { ...step("failed"), id });
  }
}

async function legacyEvent(db: Db, at = NOW) {
  await recordAgentCloseout(
    db,
    "run",
    "legacy",
    {
      type: "finished",
      head: HEAD,
      id: "unit",
      kind: "command",
      command: "bun test",
      attempt: 1,
      maxAttempts: null,
      state: "failed",
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      stdout: "agent out",
      stderr: "agent err",
      truncated: false,
    },
    at,
  );
}

test("maintenance moves three legacy outputs across both tables and hydrates them", async () => {
  const { db, storage, objects } = await setup();
  await legacyRows(db, 2);
  await legacyEvent(db);
  await pruneCloseoutLogs({ store: db, storage, now: NOW, remove: async () => {} });
  expect(objects.writes).toHaveLength(3);
  const rows = await db.run((q) => q.all(q.orm.select().from(q.t.closeoutStep)));
  for (const row of rows) {
    expect(row).toMatchObject({ stdout: "", stderr: "" });
    expect(
      await withCloseoutOutput(db, storage, {
        ...row,
        output: { key: row.outputKey!, bytes: row.outputBytes!, sha256: row.outputSha256! },
      }),
    ).toMatchObject({ stdout: `out ${row.stepId}`, stderr: `err ${row.stepId}` });
  }
  const event = (await listAgentCloseout(db, ["run"]))[0]!;
  expect(event.progress).toMatchObject({ stdout: "", stderr: "" });
  if (event.progress.type !== "finished") throw new Error("Expected finished event");
  expect(await withCloseoutOutput(db, storage, event.progress)).toMatchObject({
    stdout: "agent out",
    stderr: "agent err",
  });
});

test("expired legacy output is cleared without storing it", async () => {
  const { db, storage, objects } = await setup();
  await legacyRows(db, 1, NOW - 15 * DAY);
  await legacyEvent(db, NOW - 15 * DAY);
  await pruneCloseoutLogs({ store: db, storage, now: NOW, remove: async () => {} });
  expect(objects.writes).toHaveLength(0);
  expect(await stepRows(db)).toEqual([{ stdout: "", stderr: "", key: null }]);
  expect((await listAgentCloseout(db, ["run"]))[0]!.progress).toMatchObject({
    stdout: "",
    stderr: "",
  });
});

test("failed legacy moves preserve columns, continue the batch and retry next run", async () => {
  const { db, storage, objects } = await setup();
  await legacyRows(db, 3);
  const write = objects.write;
  let failed = false;
  objects.write = async (...args) => {
    if (!failed) {
      failed = true;
      throw new Error("storage unavailable");
    }
    return write(...args);
  };
  await pruneCloseoutLogs({ store: db, storage, now: NOW, remove: async () => {} });
  expect((await stepRows(db)).filter((row) => row.key === null)).toEqual([
    { stdout: "out 0", stderr: "err 0", key: null },
  ]);
  objects.write = write;
  await pruneCloseoutLogs({ store: db, storage, now: NOW, remove: async () => {} });
  expect(
    (await stepRows(db)).every((row) => row.key !== null && row.stdout === "" && row.stderr === ""),
  ).toBe(true);
});

test("maintenance processes only the oldest 200 legacy rows across both tables", async () => {
  const { db, storage, objects } = await setup();
  await legacyRows(db, 200);
  await legacyEvent(db, NOW - DAY);
  await pruneCloseoutLogs({ store: db, storage, now: NOW, remove: async () => {} });
  expect(objects.writes).toHaveLength(200);
  expect((await stepRows(db)).filter((row) => row.key === null)).toHaveLength(1);
  expect((await listAgentCloseout(db, ["run"]))[0]!.progress).toMatchObject({
    stdout: "",
    stderr: "",
    output: { key: expect.any(String) },
  });
});

test("maintenance leaves running output appendable until the check finishes", async () => {
  const { db, storage, objects } = await setup();
  await insertWorkItem(db, "active");
  const progress = createDbCloseoutProgress(db, "active", () => NOW);
  await progress.step(identity("active"), step("running"));
  await progress.output(identity("active"), "unit", "stdout", "first", false);
  await pruneCloseoutLogs({ store: db, storage, now: NOW, remove: async () => {} });
  await progress.output(identity("active"), "unit", "stdout", "second", false);
  expect(await stepRows(db)).toEqual([{ stdout: "firstsecond", stderr: "", key: null }]);
  expect(objects.writes).toHaveLength(0);
  await progress.step(identity("active"), step("failed"));
  await pruneCloseoutLogs({ store: db, storage, now: NOW, remove: async () => {} });
  expect(objects.writes).toHaveLength(1);
});

test("expired legacy clearing preserves changed columns and newly installed pointers", async () => {
  const { db } = await setup();
  await legacyRows(db, 1, NOW - 15 * DAY);
  await legacyEvent(db, NOW - 15 * DAY);
  const rows = await db.run((q) => legacyCloseoutOutputsSteps(q, 200));
  for (const row of rows) {
    const table = row.ref.table === "closeout_step" ? "closeoutStep" : "agentCloseoutEvent";
    await db.run((q) => q.exec(q.orm.update(q.t[table]).set({ stdout: "new output" })));
    await db.transaction((q) => clearCloseoutOutputSteps(q, row.ref, row));
    const current = await db.run((q) => q.one(q.orm.select().from(q.t[table])));
    expect(current!.stdout).toBe("new output");
    const pointer = { key: "installed", bytes: 10, sha256: "hash" };
    await db.transaction((q) =>
      pointCloseoutOutputSteps(q, { ...row, stdout: "new output" }, pointer),
    );
    await db.transaction((q) => clearCloseoutOutputSteps(q, row.ref, { stdout: "", stderr: "" }));
    const moved = await db.run((q) => q.one(q.orm.select().from(q.t[table])));
    expect(moved!.outputKey).toBe("installed");
  }
});
