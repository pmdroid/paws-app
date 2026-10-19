import { expect, test } from "bun:test";
import { insertRun, listRunnerOverview, putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import { tempDb } from "./helpers";

test("the runner overview reports used and total slots like placement counts them", () => {
  const db = tempDb();
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "user-linear",
    name: "Owner",
    email: "owner@example.invalid",
  });
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", now]);
  syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "owner",
    active: true,
    teamIds: [],
    now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
    ["runner-1", "ws-1", userId, "Runner", now, now],
  );
  expect(listRunnerOverview(db, "ws-1", now)[0]?.slots).toEqual({ used: 0, total: 1 });
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,3)", ["runner-1"]);
  for (const [index, lease] of [now + 60_000, now - 1].entries()) {
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES(?,?,?,?,?,'running',?,0,?)",
      [
        `item-${index}`,
        `epic-${index}`,
        `issue-${index}`,
        `ENG-${index}`,
        "Task",
        `paws/eng-${index}`,
        now,
      ],
    );
    const run = insertRun(db, { itemId: `item-${index}`, now, status: "active" });
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,?,?,1,0,?,?,0)",
      [run.id, "runner-1", "ws-1", `cmd-${index}`, lease],
    );
  }
  expect(listRunnerOverview(db, "ws-1", now)[0]?.slots).toEqual({ used: 1, total: 3 });
});
