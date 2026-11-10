import assert from "node:assert/strict";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";
import { applyWorkItemEvent } from "../src/db";
import { hasPendingDelegationChanges } from "../src/intake";
import { tempDb } from "./helpers";

function item(db: Database, id: string, state: string) {
  db.run(
    `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
     VALUES(?,'delegation',?,?,?,?,?,0,0)`,
    [id, `issue-${id}`, id, id, state, `paws/${id}`],
  );
}

function reconciliationRows(db: Database, id: string) {
  return {
    requests: db.query("SELECT 1 FROM item_reconciliation_request WHERE item_id=?").all(id).length,
    effects: db.query("SELECT 1 FROM item_reconciliation_effect WHERE item_id=?").all(id).length,
  };
}

function seed(db: Database) {
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',0)");
  item(db, "cancelled", "running");
  item(db, "live", "queued");
  for (const id of ["cancelled", "live"])
    db.run("INSERT INTO item_reconciliation_request VALUES(?,'workspace','token')", [id]);
}

test("cancelling an item with a pending request leaves no reconciliation rows for it", () => {
  const db = tempDb();
  try {
    seed(db);
    applyWorkItemEvent(db, "cancelled", "cancel");
    assert.deepEqual(reconciliationRows(db, "cancelled"), { requests: 0, effects: 0 });
    assert.deepEqual(reconciliationRows(db, "live"), { requests: 1, effects: 0 });
  } finally {
    db.close();
  }
});

test("the delegation of a cancelled item is no longer held as reconciling", async () => {
  const db = tempDb();
  try {
    seed(db);
    db.run("DELETE FROM item_reconciliation_request WHERE item_id='live'");
    assert.equal(await hasPendingDelegationChanges(db, "delegation"), true);
    applyWorkItemEvent(db, "cancelled", "cancel");
    assert.equal(await hasPendingDelegationChanges(db, "delegation"), false);
  } finally {
    db.close();
  }
});

test("cancelling an item keeps the effects a running reconcile still publishes", () => {
  const db = tempDb();
  try {
    seed(db);
    for (const kind of ["spec", "removed", "canceled"])
      db.run("INSERT INTO item_reconciliation_effect VALUES('cancelled',?,'token')", [kind]);
    applyWorkItemEvent(db, "cancelled", "cancel");
    assert.deepEqual(reconciliationRows(db, "cancelled"), { requests: 0, effects: 3 });
  } finally {
    db.close();
  }
});
