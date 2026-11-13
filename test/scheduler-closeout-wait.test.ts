import { expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  enqueueJob,
  insertQueuedItem,
  insertRun,
  pinnedSlotsReserved,
  putWorkspaceUser,
  runnerHasCapacity,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { eq, sql, type SQL } from "drizzle-orm";
import { saveSchedulingContextSteps } from "../src/scheduler";
import { workspaceDispatchPg as workspaceDispatch } from "./fake-workspace";
import { tempStore } from "./pglite";

const NOW = 10_000_000;
const BACKOFF = NOW + 4 * 60_000;

const exec = (db: Db, query: SQL) => db.run((q) => q.exec(q.orm.execute(query)));

async function fixture(waits: { id: string; since: number }[]) {
  const { db, close } = await tempStore();
  const userId = await putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "user-linear",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await exec(db, sql`INSERT INTO workspace VALUES('ws-1','org-1','Workspace',0)`);
  await syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now: 0,
  });
  await exec(
    db,
    sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('A','ws-1',${userId},'A','active',0,${NOW})`,
  );
  await exec(db, sql`INSERT INTO runner_capacity(runner_id,capacity) VALUES('A',1)`);

  await insertQueuedItem(db, { id: "busy", now: 0 });
  await applyWorkItemEvent(db, "busy", "dispatched");
  const busy = (await insertRun(db, { itemId: "busy", now: 0, status: "active" })).id;
  await exec(
    db,
    sql`INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(${busy},'A','ws-1',1,0,${`cmd-${busy}`},${NOW + 60_000})`,
  );

  const jobs = new Map<string, number>();
  for (const [index, wait] of waits.entries()) {
    await insertQueuedItem(db, { id: wait.id, now: 1 + index });
    await db.run((q) => saveSchedulingContextSteps(q, { itemId: wait.id, priority: 4 }));
    const run = (await insertRun(db, { itemId: wait.id, now: 1, status: "active" })).id;
    await exec(
      db,
      sql`UPDATE work_item SET state='verifying',current_run_id=${run} WHERE id=${wait.id}`,
    );
    jobs.set(
      wait.id,
      await enqueueJob(db, {
        queue: JOB_KIND.reverify,
        payload: {
          itemId: wait.id,
          runId: run,
          reason: "transient_failure",
          retry: 0,
          capacityWait: { since: wait.since, attempt: 2, runnerIds: ["A"] },
        },
        runAt: BACKOFF,
        now: wait.since,
      }),
    );
  }

  await insertQueuedItem(db, { id: "Y", now: 100 });
  await db.run((q) => saveSchedulingContextSteps(q, { itemId: "Y", priority: 1 }));

  const runAt = async (itemId: string) =>
    (await db.run((q) =>
      q.one(
        q.orm
          .select({ runAt: q.t.job.runAt })
          .from(q.t.job)
          .where(eq(q.t.job.id, jobs.get(itemId)!)),
      ),
    ))!.runAt;
  const free = async (at: number) => {
    await exec(
      db,
      sql`UPDATE runner_work SET ended_at=${at},teardown_confirmed_at=${at} WHERE run_id=${busy}`,
    );
    await exec(db, sql`UPDATE run SET status='ended' WHERE id=${busy}`);
  };
  return { db, close, runAt, free };
}

test("a freed slot goes to the Closeout waiting for a review slot, not to a queued item", async () => {
  const { db, close, runAt, free } = await fixture([{ id: "X", since: NOW - 60_000 }]);
  try {
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(await pinnedSlotsReserved(db, "A", "Y", NOW)).toBe(1);
    await free(NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(await runAt("X")).toBe(NOW + 2);
    const reserved = await pinnedSlotsReserved(db, "A", "Y", NOW + 2);
    expect(await runnerHasCapacity(db, "A", NOW + 2, "", reserved)).toBe(false);
    expect(await pinnedSlotsReserved(db, "A", "X", NOW + 2)).toBe(0);
    expect(await runnerHasCapacity(db, "A", NOW + 2, "", 0)).toBe(true);
  } finally {
    await close();
  }
});

test("of two Closeouts waiting on one free slot, the older wait is placed first", async () => {
  const { db, close, runAt, free } = await fixture([
    { id: "X1", since: NOW - 60_000 },
    { id: "X2", since: NOW - 120_000 },
  ]);
  try {
    await free(NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(await runAt("X2")).toBe(NOW + 2);
    expect(await runAt("X1")).toBe(BACKOFF);
    expect(await pinnedSlotsReserved(db, "A", "X2", NOW + 2)).toBe(0);
    expect(await pinnedSlotsReserved(db, "A", "X1", NOW + 2)).toBe(1);
  } finally {
    await close();
  }
});

test("a Closeout waiting longer than 30 minutes competes with queued work again", async () => {
  const { db, close, runAt, free } = await fixture([{ id: "X", since: NOW - 31 * 60_000 }]);
  try {
    await free(NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["Y"]);
    expect(await runAt("X")).toBe(BACKOFF);
  } finally {
    await close();
  }
});
