import { expect, test } from "bun:test";
import {
  insertQueuedItem,
  listWorkItemFacts,
  putWorkspaceUser,
  saveWorkItemLinearProject,
  type Db,
} from "../src/db";
import { eq } from "drizzle-orm";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

function owner(db: Db, userId: string, id: string): Promise<void> {
  return seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ ownerUserId: userId }).where(eq(q.t.workItem.id, id)),
  );
}

test("lists each item's owner, Linear project, and creation time", async () => {
  const { db, close } = await tempStore();
  const older = await insertQueuedItem(db, { id: "older", title: "Older", now: 10 });
  const newer = await insertQueuedItem(db, { id: "newer", title: "Newer", now: 20 });
  const solo = await insertQueuedItem(db, { id: "solo", title: "Solo", now: 30 });
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
  );
  const userId = await putWorkspaceUser(db, {
    id: "user",
    linearUserId: "linear-user",
    name: "Ada Owner",
    email: "ada@example.test",
  });
  await owner(db, userId, newer.id);
  await saveWorkItemLinearProject(db, newer.id, {
    id: "linear-project",
    name: "Exports",
  });
  await owner(db, userId, older.id);

  expect(await listWorkItemFacts(db)).toEqual([
    {
      itemId: solo.id,
      owner: null,
      projectId: null,
      projectName: null,
      createdAt: 30,
    },
    {
      itemId: newer.id,
      owner: "Ada Owner",
      projectId: "linear-project",
      projectName: "Exports",
      createdAt: 20,
    },
    {
      itemId: older.id,
      owner: "Ada Owner",
      projectId: null,
      projectName: null,
      createdAt: 10,
    },
  ]);
  await close();
});
