import assert from "node:assert/strict";
import { test } from "bun:test";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  bindWorkItemRepository,
  claimNextJob,
  enqueueJob,
  getJob,
  insertQueuedItem,
  insertRun,
  openPawsStore,
  setJournalSink,
  type Db,
  type Job,
} from "../src/db";
import { dispatch } from "../src/scheduler";
import { workspaceAdmission, workspaceDispatchPg } from "./fake-workspace";
import { copyMigratedPglite, tempStore } from "./pglite";
import { tempHome } from "./helpers";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };

async function disagreements(run: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    await run();
  } finally {
    restore();
  }
  return lines.filter((line) => line.startsWith("claim gate disagreement"));
}

async function queued(db: Db, id: string, now = 0): Promise<void> {
  await insertQueuedItem(db, { id, now });
  await bindWorkItemRepository(db, id, repository);
}

async function inFlight(
  db: Db,
  id: string,
  event: "turn_ended" | "lease_expired",
): Promise<number> {
  await queued(db, id);
  await applyWorkItemEvent(db, id, "dispatched");
  await applyWorkItemEvent(db, id, event);
  return await enqueueJob(db, {
    queue: event === "turn_ended" ? JOB_KIND.reverify : JOB_KIND.resume,
    payload: { itemId: id },
    now: 0,
  });
}

const admissions = (db: Db) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({ itemId: q.t.schedulerAdmission.itemId, jobId: q.t.schedulerAdmission.jobId })
        .from(q.t.schedulerAdmission),
    ),
  );

const delegationOf = async (db: Db, id: string) =>
  (
    await db.run((q) =>
      q.one(
        q.orm
          .select({ id: q.t.workItem.delegationId })
          .from(q.t.workItem)
          .where(eq(q.t.workItem.id, id)),
      ),
    )
  )?.id;

async function restartable() {
  const dir = join(tempHome(), "pglite");
  await copyMigratedPglite(dir);
  let open: { store: Db; close(): Promise<void> } | undefined;
  const restart = async () => {
    await open?.close();
    open = await openPawsStore({ url: null, pgliteDir: dir });
    return open.store;
  };
  return Object.assign(restart, { close: () => open?.close() });
}

function itemOf(job: Job | null): string | null {
  return (job?.payload as { itemId?: string } | undefined)?.itemId ?? null;
}

test("an unreserved start stays pending without a legacy claim decision", async () => {
  const { db, close } = await tempStore();
  try {
    await queued(db, "solo");
    const id = await enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "solo" },
      now: 0,
    });
    let claimed: Job | null = null;
    const lines = await disagreements(async () => {
      claimed = await claimNextJob(db, { now: 1000 });
    });
    assert.equal(claimed, null);
    assert.equal((await getJob(db, id))?.status, "pending");
    assert.deepEqual(lines, []);
  } finally {
    await close();
  }
});

test("a reserved start is claimed without the legacy gate", async () => {
  const { db, close } = await tempStore();
  try {
    await queued(db, "legacy");
    await applyWorkItemEvent(db, "legacy", "dispatched");
    await insertRun(db, { itemId: "legacy", now: 0, status: "active" });
    await queued(db, "next", 1);
    assert.deepEqual(await workspaceDispatchPg(db, { now: 1000 }), ["next"]);
    const start = (await admissions(db)).find((row) => row.itemId === "next")!.jobId;
    const lines = await disagreements(async () => {
      assert.equal((await claimNextJob(db, { now: 1000 }))?.id, start);
    });
    assert.deepEqual(lines, []);
  } finally {
    await close();
  }
});

test("a queued Reservation survives a restart and both rules claim its start", async () => {
  const restart = await restartable();
  const db = await restart();
  await queued(db, "a");
  await queued(db, "b", 1);
  assert.deepEqual(await workspaceDispatchPg(db, { now: 1000 }), ["a", "b"]);
  const reopened = await restart();
  try {
    let claimed: (string | null)[] = [];
    const lines = await disagreements(async () => {
      assert.deepEqual(await workspaceDispatchPg(reopened, { now: 2000 }), []);
      claimed = [
        await claimNextJob(reopened, { now: 2000 }),
        await claimNextJob(reopened, { now: 2000 }),
      ].map(itemOf);
    });
    assert.deepEqual(claimed, ["a", "b"]);
    assert.deepEqual(lines, []);
  } finally {
    await restart.close();
  }
});

test("work in flight without a Reservation after a restart is reconstructed before its claim", async () => {
  const restart = await restartable();
  const db = await restart();
  await inFlight(db, "a", "turn_ended");
  await inFlight(db, "b", "lease_expired");
  const reopened = await restart();
  try {
    let claimed: (string | null)[] = [];
    const lines = await disagreements(async () => {
      await workspaceDispatchPg(reopened, { now: 1000 });
      claimed = [
        await claimNextJob(reopened, { now: 1000 }),
        await claimNextJob(reopened, { now: 1000 }),
      ].map(itemOf);
    });
    assert.deepEqual(claimed.sort(), ["a", "b"]);
    assert.equal((await admissions(reopened)).length, 2);
    assert.deepEqual(lines, []);
  } finally {
    await restart.close();
  }
});

test("resume and reverify claim against their Reservation and never twice for one item", async () => {
  const { db, close } = await tempStore();
  try {
    await inFlight(db, "verify", "turn_ended");
    await inFlight(db, "recover", "lease_expired");
    let claimed: (string | null)[] = [];
    const lines = await disagreements(async () => {
      await workspaceDispatchPg(db, { now: 1000 });
      claimed = [await claimNextJob(db, { now: 1000 }), await claimNextJob(db, { now: 1000 })].map(
        itemOf,
      );
      await enqueueJob(db, {
        queue: JOB_KIND.resume,
        payload: { itemId: "recover" },
        now: 1000,
      });
      assert.equal(await claimNextJob(db, { now: 1000 }), null);
    });
    assert.deepEqual(claimed.sort(), ["recover", "verify"]);
    assert.deepEqual(lines, []);
  } finally {
    await close();
  }
});

test("a Project pause between dispatch and claim retracts the stale Reservation", async () => {
  const { db, close } = await tempStore();
  try {
    await queued(db, "paused");
    const lines = await disagreements(async () => {
      assert.deepEqual(await workspaceDispatchPg(db, { now: 1000 }), ["paused"]);
      const paused = workspaceAdmission(db, { authority: () => false });
      assert.deepEqual(await dispatch(db, { now: 1001, admission: paused }), []);
      assert.equal(await claimNextJob(db, { now: 1001 }), null);
    });
    assert.deepEqual(await admissions(db), []);
    assert.equal((await getJob(db, 1))!.status, "cancelled");
    assert.deepEqual(lines, []);
  } finally {
    await close();
  }
});

test("an access change between dispatch and claim retracts only that Item's Reservation", async () => {
  const { db, close } = await tempStore();
  try {
    await queued(db, "revoked");
    await queued(db, "kept", 1);
    const revoked = (await delegationOf(db, "revoked"))!;
    let claimed: (string | null)[] = [];
    const lines = await disagreements(async () => {
      assert.deepEqual(await workspaceDispatchPg(db, { now: 1000 }), ["revoked", "kept"]);
      const access = workspaceAdmission(db, { authority: (id) => id !== revoked });
      assert.deepEqual(await dispatch(db, { now: 1001, admission: access }), []);
      claimed = [await claimNextJob(db, { now: 1001 }), await claimNextJob(db, { now: 1001 })].map(
        itemOf,
      );
    });
    assert.deepEqual(claimed, ["kept", null]);
    assert.deepEqual(lines, []);
  } finally {
    await close();
  }
});
