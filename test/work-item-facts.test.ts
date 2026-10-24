import { expect, test } from "bun:test";
import {
  insertQueuedItem,
  listWorkItemFacts,
  putWorkspaceUser,
  saveWorkItemLinearProject,
} from "../src/db";
import { tempDb } from "./helpers";

test("lists each item's owner, Linear project, and creation time", () => {
  const db = tempDb();
  const older = insertQueuedItem(db, { id: "older", title: "Older", now: 10 });
  const newer = insertQueuedItem(db, { id: "newer", title: "Newer", now: 20 });
  const solo = insertQueuedItem(db, { id: "solo", title: "Solo", now: 30 });
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Workspace',0)",
  );
  const userId = putWorkspaceUser(db, {
    id: "user",
    linearUserId: "linear-user",
    name: "Ada Owner",
    email: "ada@example.test",
  });
  db.run(
    `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at)
     VALUES('approval','ws','proj',?,?,'g1',?,0,1)`,
    [userId, userId, JSON.stringify({ name: "Wrong", project: { name: "Exports" } })],
  );
  db.run("UPDATE work_item SET owner_user_id = ? WHERE id = ?", [userId, newer.id]);
  saveWorkItemLinearProject(db, newer.id, { id: "linear-project", name: "Exports" });
  // A Paws project start is not the issue's Linear project.
  db.run("UPDATE work_item SET owner_user_id = ?, project_approval_id = ? WHERE id = ?", [
    userId,
    "approval",
    older.id,
  ]);

  expect(listWorkItemFacts(db)).toEqual([
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
