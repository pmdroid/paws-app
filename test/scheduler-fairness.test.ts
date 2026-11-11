import { expect, test } from "bun:test";
import {
  getQueuePosition,
  insertQueuedItem,
  putWorkspaceUser,
  syncWorkspaceMember,
  sqliteDb,
} from "../src/db";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

const NOW = 1_000;

async function fixture(capacity: number) {
  const db = tempDb();
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", 0]);
  for (const name of ["ada", "ben"])
    await putWorkspaceUser(sqliteDb(db), {
      id: name,
      linearUserId: `${name}-linear`,
      name,
      email: `${name}@example.invalid`,
    });
  await syncWorkspaceMember(sqliteDb(db), {
    workspaceId: "ws-1",
    userId: "ada",
    role: "admin",
    active: true,
    teamIds: [],
    now: 0,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('box','ws-1','ada','box','active',0,?)",
    [NOW],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES('box',?)", [capacity]);
  const queue = async (id: string, owner: string, createdAt: number) => {
    await insertQueuedItem(db, { id, now: createdAt });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [owner, id]);
  };
  return { db, queue };
}

test("a second person's single task starts in the first round beside a large batch", async () => {
  const { db, queue } = await fixture(2);
  try {
    for (let index = 1; index <= 20; index += 1) await queue(`ada-${index}`, "ada", index);
    await queue("ben-1", "ben", 100);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["ada-1", "ben-1"]);
    expect(await getQueuePosition(sqliteDb(db), "ada-2")).toMatchObject({
      position: 1,
      ownerCap: null,
    });
  } finally {
    db.close();
  }
});

test("two owners' tasks take turns", async () => {
  const { db, queue } = await fixture(4);
  try {
    for (let index = 1; index <= 3; index += 1) await queue(`ada-${index}`, "ada", index);
    for (let index = 1; index <= 3; index += 1) await queue(`ben-${index}`, "ben", 10 + index);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["ada-1", "ben-1", "ada-2", "ben-2"]);
  } finally {
    db.close();
  }
});

test("with a cap of 3 one owner never runs more than 3 tasks while others wait", async () => {
  const { db, queue } = await fixture(10);
  try {
    for (let index = 1; index <= 10; index += 1) await queue(`ada-${index}`, "ada", index);
    await queue("ben-1", "ben", 100);
    await queue("ben-2", "ben", 101);
    expect(await workspaceDispatch(db, { now: NOW, ownerCap: 3 })).toEqual([
      "ada-1",
      "ben-1",
      "ada-2",
      "ben-2",
      "ada-3",
    ]);
    expect(await workspaceDispatch(db, { now: NOW + 1, ownerCap: 3 })).toEqual([]);
    expect(await getQueuePosition(sqliteDb(db), "ada-4")).toMatchObject({
      position: 1,
      ownerCap: 3,
    });
  } finally {
    db.close();
  }
});

test("without a cap one owner gets every free runner slot", async () => {
  const { db, queue } = await fixture(4);
  try {
    for (let index = 1; index <= 6; index += 1) await queue(`ada-${index}`, "ada", index);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["ada-1", "ada-2", "ada-3", "ada-4"]);
  } finally {
    db.close();
  }
});
