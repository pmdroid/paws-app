import { expect, test } from "bun:test";
import {
  applyWorkItemEvent,
  getWorkItem,
  insertQueuedItem,
  insertRun,
  joinMergeQueue,
  putWorkspaceUser,
  restart,
  syncSteps,
  syncWorkspaceMember,
  type Db,
  type Q,
} from "../src/db";
import { sql, type SQL } from "drizzle-orm";
import { workspaceDispatchPg as workspaceDispatch } from "./fake-workspace";
import { tempStore } from "./pglite";

const NOW = 1_000_000;

const exec = (db: Db, query: SQL) => db.run((q) => q.exec(q.orm.execute(query)));

async function fixture(options: { fixSlots?: number; returnRunners?: string[] } = {}) {
  const { db, close } = await tempStore();
  await exec(db, sql`INSERT INTO workspace VALUES('ws-1','org-1','Workspace',0)`);
  for (const id of ["owner", "other"]) {
    await putWorkspaceUser(db, {
      id,
      linearUserId: `linear-${id}`,
      name: id,
      email: `${id}@x.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: "ws-1",
      userId: id,
      role: "admin",
      active: true,
      teamIds: [],
      now: 0,
    });
  }
  const work = (runId: string, ended: number | null) =>
    exec(
      db,
      sql`INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at,teardown_confirmed_at) VALUES(${runId},'A','ws-1',1,0,${`cmd-${runId}`},${NOW + 60_000},${ended},${ended})`,
    );
  await exec(
    db,
    sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at,fix_slots) VALUES('A','ws-1','owner','A','active',0,${NOW},${options.fixSlots ?? 1})`,
  );
  await exec(db, sql`INSERT INTO runner_capacity(runner_id,capacity) VALUES('A',2)`);
  await insertQueuedItem(db, { id: "busy", now: 0 });
  await applyWorkItemEvent(db, "busy", "dispatched");
  const busy = (await insertRun(db, { itemId: "busy", now: 0, status: "active" })).id;
  await work(busy, null);
  await insertQueuedItem(db, { id: "N", now: 1 });
  await exec(db, sql`UPDATE work_item SET owner_user_id='other' WHERE id='N'`);
  await exec(db, sql`UPDATE work_item SET owner_user_id='owner' WHERE id='busy'`);

  const mergeReturn = async () => {
    await insertQueuedItem(db, { id: "M", now: 2 });
    await exec(db, sql`UPDATE work_item SET owner_user_id='owner' WHERE id='M'`);
    await applyWorkItemEvent(db, "M", "dispatched");
    const runId = (await insertRun(db, { itemId: "M", now: 2, status: "ended" })).id;
    await exec(db, sql`UPDATE work_item SET current_run_id=${runId} WHERE id='M'`);
    await work(runId, NOW - 1);
    await applyWorkItemEvent(db, "M", "turn_ended");
    await applyWorkItemEvent(db, "M", "closeout_accepted");
    await joinMergeQueue(db, { itemId: "M", repository: "acme/app", now: NOW - 60_000 });
    await restart(db, (await getWorkItem(db, "M"))!, {
      reason: "conflict",
      body: "Resolve conflicts",
      now: NOW,
    });
  };
  const pass = (now: number) =>
    workspaceDispatch(db, {
      now,
      ownerCap: 1,
      itemRunners: (_q: Q, itemId: string) =>
        syncSteps(() => ({
          repository: "acme/app",
          agent: "claude",
          runners: ["A"].map((id) => ({
            id,
            name: id,
            rejection:
              itemId === "M" && !(options.returnRunners ?? ["A"]).includes(id) ? "pinned" : null,
            hostConfig: null,
          })),
        })),
    });
  const free = async () => {
    await exec(
      db,
      sql`UPDATE runner_work SET ended_at=${NOW + 1},teardown_confirmed_at=${NOW + 1} WHERE run_id=${busy}`,
    );
    await exec(db, sql`UPDATE run SET status='ended' WHERE id=${busy}`);
    await exec(db, sql`UPDATE work_item SET state='completed' WHERE id='busy'`);
  };
  return { db, close, mergeReturn, pass, free };
}

test("a waiting merge-queue return keeps the runner's fix slot from new work, then takes it", async () => {
  const { close, mergeReturn, pass, free } = await fixture();
  try {
    await mergeReturn();
    expect(await pass(NOW + 1)).toEqual([]);
    await free();
    expect(await pass(NOW + 2)).toEqual(["M", "N"]);
  } finally {
    await close();
  }
});

test("with no merge-queue return waiting, new work takes the fix slot", async () => {
  const { close, pass } = await fixture();
  try {
    expect(await pass(NOW + 1)).toEqual(["N"]);
  } finally {
    await close();
  }
});

test("fix slots 0 keeps no slot back", async () => {
  const { close, mergeReturn, pass } = await fixture({ fixSlots: 0 });
  try {
    await mergeReturn();
    expect(await pass(NOW + 1)).toEqual(["N"]);
  } finally {
    await close();
  }
});

test("a return that cannot use this runner keeps no slot back on it", async () => {
  const { close, mergeReturn, pass } = await fixture({ returnRunners: ["B"] });
  try {
    await mergeReturn();
    expect(await pass(NOW + 1)).toEqual(["N"]);
  } finally {
    await close();
  }
});
