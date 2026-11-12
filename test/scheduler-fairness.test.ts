import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  getQueuePosition,
  insertQueuedItem,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { workspaceDispatchPg } from "./fake-workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const NOW = 1_000;

async function fixture(capacity: number) {
  const { db, close } = await tempStore();
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws-1", linearOrganizationId: "org-1", name: "Workspace", createdAt: 0 }),
  );
  for (const name of ["ada", "ben"])
    await putWorkspaceUser(db, {
      id: name,
      linearUserId: `${name}-linear`,
      name,
      email: `${name}@example.invalid`,
    });
  await syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId: "ada",
    role: "admin",
    active: true,
    teamIds: [],
    now: 0,
  });
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "box",
        workspaceId: "ws-1",
        ownerUserId: "ada",
        name: "box",
        status: "active",
        createdAt: 0,
        lastSeenAt: NOW,
      }),
    (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: "box", capacity }),
  );
  const queue = async (id: string, owner: string, createdAt: number) => {
    await insertQueuedItem(db, { id, now: createdAt });
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ ownerUserId: owner }).where(eq(q.t.workItem.id, id)),
    );
  };
  return { db, close, queue };
}

test("a second person's single task starts in the first round beside a large batch", async () => {
  const { db, close, queue } = await fixture(2);
  try {
    for (let index = 1; index <= 20; index += 1) await queue(`ada-${index}`, "ada", index);
    await queue("ben-1", "ben", 100);
    expect(await workspaceDispatchPg(db, { now: NOW })).toEqual(["ada-1", "ben-1"]);
    expect(await getQueuePosition(db, "ada-2")).toMatchObject({
      position: 1,
      ownerCap: null,
    });
  } finally {
    await close();
  }
});

test("two owners' tasks take turns", async () => {
  const { db, close, queue } = await fixture(4);
  try {
    for (let index = 1; index <= 3; index += 1) await queue(`ada-${index}`, "ada", index);
    for (let index = 1; index <= 3; index += 1) await queue(`ben-${index}`, "ben", 10 + index);
    expect(await workspaceDispatchPg(db, { now: NOW })).toEqual([
      "ada-1",
      "ben-1",
      "ada-2",
      "ben-2",
    ]);
  } finally {
    await close();
  }
});

test("with a cap of 3 one owner never runs more than 3 tasks while others wait", async () => {
  const { db, close, queue } = await fixture(10);
  try {
    for (let index = 1; index <= 10; index += 1) await queue(`ada-${index}`, "ada", index);
    await queue("ben-1", "ben", 100);
    await queue("ben-2", "ben", 101);
    expect(await workspaceDispatchPg(db, { now: NOW, ownerCap: 3 })).toEqual([
      "ada-1",
      "ben-1",
      "ada-2",
      "ben-2",
      "ada-3",
    ]);
    expect(await workspaceDispatchPg(db, { now: NOW + 1, ownerCap: 3 })).toEqual([]);
    expect(await getQueuePosition(db, "ada-4")).toMatchObject({
      position: 1,
      ownerCap: 3,
    });
  } finally {
    await close();
  }
});

test("without a cap one owner gets every free runner slot", async () => {
  const { db, close, queue } = await fixture(4);
  try {
    for (let index = 1; index <= 6; index += 1) await queue(`ada-${index}`, "ada", index);
    expect(await workspaceDispatchPg(db, { now: NOW })).toEqual([
      "ada-1",
      "ada-2",
      "ada-3",
      "ada-4",
    ]);
  } finally {
    await close();
  }
});
