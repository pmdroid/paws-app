import { expect, test } from "bun:test";
import {
  getQueuePosition,
  insertQueuedItem,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

const NOW = 1_000;

function fixture(capacity: number) {
  const db = tempDb();
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", 0]);
  for (const name of ["ada", "ben"])
    putWorkspaceUser(db, {
      id: name,
      linearUserId: `${name}-linear`,
      name,
      email: `${name}@example.invalid`,
    });
  syncWorkspaceMember(db, {
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
  const queue = (id: string, owner: string, createdAt: number) => {
    insertQueuedItem(db, { id, now: createdAt });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [owner, id]);
  };
  return { db, queue };
}

test("a second person's single task starts in the first round beside a large batch", () => {
  const { db, queue } = fixture(2);
  try {
    for (let index = 1; index <= 20; index += 1) queue(`ada-${index}`, "ada", index);
    queue("ben-1", "ben", 100);
    expect(workspaceDispatch(db, { now: NOW })).toEqual(["ada-1", "ben-1"]);
    expect(getQueuePosition(db, "ada-2")).toMatchObject({ position: 1, ownerCap: null });
  } finally {
    db.close();
  }
});

test("two owners' tasks take turns", () => {
  const { db, queue } = fixture(4);
  try {
    for (let index = 1; index <= 3; index += 1) queue(`ada-${index}`, "ada", index);
    for (let index = 1; index <= 3; index += 1) queue(`ben-${index}`, "ben", 10 + index);
    expect(workspaceDispatch(db, { now: NOW })).toEqual(["ada-1", "ben-1", "ada-2", "ben-2"]);
  } finally {
    db.close();
  }
});

test("with a cap of 3 one owner never runs more than 3 tasks while others wait", () => {
  const { db, queue } = fixture(10);
  try {
    for (let index = 1; index <= 10; index += 1) queue(`ada-${index}`, "ada", index);
    queue("ben-1", "ben", 100);
    queue("ben-2", "ben", 101);
    expect(workspaceDispatch(db, { now: NOW, ownerCap: 3 })).toEqual([
      "ada-1",
      "ben-1",
      "ada-2",
      "ben-2",
      "ada-3",
    ]);
    expect(workspaceDispatch(db, { now: NOW + 1, ownerCap: 3 })).toEqual([]);
    expect(getQueuePosition(db, "ada-4")).toMatchObject({ position: 1, ownerCap: 3 });
  } finally {
    db.close();
  }
});

test("without a cap one owner gets every free runner slot", () => {
  const { db, queue } = fixture(4);
  try {
    for (let index = 1; index <= 6; index += 1) queue(`ada-${index}`, "ada", index);
    expect(workspaceDispatch(db, { now: NOW })).toEqual(["ada-1", "ada-2", "ada-3", "ada-4"]);
  } finally {
    db.close();
  }
});
