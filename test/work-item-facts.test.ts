import { expect, test } from "bun:test";
import {
  insertQueuedItem,
  listWorkItemFacts,
  putWorkspaceUser,
  saveWorkItemLinearProject,
  sqliteDb,
} from "../src/db";
import { tempDb } from "./helpers";

test("lists each item's owner, Linear project, and creation time", async () => {
  const db = tempDb();
  const older = await insertQueuedItem(db, { id: "older", title: "Older", now: 10 });
  const newer = await insertQueuedItem(db, { id: "newer", title: "Newer", now: 20 });
  const solo = await insertQueuedItem(db, { id: "solo", title: "Solo", now: 30 });
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Workspace',0)",
  );
  const userId = await putWorkspaceUser(sqliteDb(db), {
    id: "user",
    linearUserId: "linear-user",
    name: "Ada Owner",
    email: "ada@example.test",
  });
  db.run("UPDATE work_item SET owner_user_id = ? WHERE id = ?", [userId, newer.id]);
  await saveWorkItemLinearProject(sqliteDb(db), newer.id, {
    id: "linear-project",
    name: "Exports",
  });
  db.run("UPDATE work_item SET owner_user_id = ? WHERE id = ?", [userId, older.id]);

  expect(await listWorkItemFacts(sqliteDb(db))).toEqual([
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
  db.close();
});
