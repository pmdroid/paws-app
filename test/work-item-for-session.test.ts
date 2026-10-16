import { expect, test } from "bun:test";
import { workItemForSession } from "../src/db";
import { tempDb } from "./helpers";

test("workItemForSession prefers the in-flight item over a newer queued or failed sibling", () => {
  const db = tempDb();
  try {
    for (const id of ["queue-epic", "fail-epic"]) {
      db.run(
        "INSERT INTO epic(id,linear_issue_id,linear_identifier,title,state,created_at) VALUES(?,?,?,?,?,?)",
        [id, id, id, id, "running", 1],
      );
    }
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('older-running','queue-epic','older-running','QR','Running','running','paws/older-running',0,1,'queue-session')",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('newer-queued','queue-epic','newer-queued','QQ','Queued','queued','paws/newer-queued',1,2,'queue-session')",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('older-live','fail-epic','older-live','FR','Running','running','paws/older-live',0,1,'fail-session')",
    );
    db.run(
      "INSERT INTO work_item(id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES('newer-failed','fail-epic','newer-failed','FF','Failed','failed','paws/newer-failed',1,2,'fail-session')",
    );
    expect(workItemForSession(db, "queue-session")?.id).toBe("older-running");
    expect(workItemForSession(db, "fail-session")?.id).toBe("older-live");
  } finally {
    db.close();
  }
});
