import assert from "node:assert/strict";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";
import { recordLinearInstallation, saveTaskMode } from "../src/db";
import { createAdmission } from "../src/scheduler";
import { tempDb } from "./helpers";

function item(
  db: Database,
  input: { id: string; delegationId?: string; state?: string; position?: number; session?: string },
) {
  db.run(
    `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key)
     VALUES(?,?,?,?,?,?,?,?,0,?)`,
    [
      input.id,
      input.delegationId ?? "delegation",
      `issue-${input.id}`,
      input.id,
      input.id,
      input.state ?? "queued",
      `paws/${input.id}`,
      input.position ?? 0,
      input.session ?? null,
    ],
  );
}

function block(db: Database, blocker: string, blocked: string) {
  db.run("INSERT INTO task_block VALUES(?,?)", [`issue-${blocker}`, `issue-${blocked}`]);
}

function setState(db: Database, id: string, state: string) {
  db.run("UPDATE work_item SET state=? WHERE id=?", [state, id]);
}

test("an Item without a workspace starts once its blocker in the delegation merged", () => {
  const db = tempDb();
  try {
    item(db, { id: "blocker", state: "running" });
    item(db, { id: "blocked", position: 1 });
    block(db, "blocker", "blocked");
    const admission = createAdmission({ db });
    assert.deepEqual(admission.canStart("blocked"), { ok: false, held: "blocked" });
    setState(db, "blocker", "merged");
    assert.deepEqual(admission.canStart("blocked"), { ok: true });
  } finally {
    db.close();
  }
});

test("a completed blocker satisfies the Block only for answer and artifact work", () => {
  const db = tempDb();
  try {
    item(db, { id: "blocker", state: "completed" });
    item(db, { id: "blocked", position: 1 });
    block(db, "blocker", "blocked");
    const admission = createAdmission({ db });
    assert.deepEqual(admission.canStart("blocked"), { ok: false, held: "blocked" });
    saveTaskMode(db, "blocker", "answer");
    assert.deepEqual(admission.canStart("blocked"), { ok: true });
  } finally {
    db.close();
  }
});

test("a merge waits for an unmerged blocker and passes once it merged", () => {
  const db = tempDb();
  try {
    item(db, { id: "blocker", state: "verifying" });
    item(db, { id: "blocked", state: "merge_queue", position: 1 });
    block(db, "blocker", "blocked");
    const admission = createAdmission({ db });
    assert.deepEqual(admission.canMerge("blocked"), { ok: false, held: "blocked" });
    setState(db, "blocker", "merged");
    assert.deepEqual(admission.canMerge("blocked"), { ok: true });
  } finally {
    db.close();
  }
});

test("project authority holds start and merge before readiness is read", () => {
  const db = tempDb();
  try {
    item(db, { id: "held", state: "merge_queue" });
    const admission = createAdmission({ db, authority: (id) => id !== "delegation" });
    assert.deepEqual(admission.canStart("held"), { ok: false, held: "project" });
    assert.deepEqual(admission.canMerge("held"), { ok: false, held: "project" });
    assert.equal(admission.canDispatchDelegation("delegation"), false);
    assert.equal(admission.canDispatchDelegation("other"), true);
  } finally {
    db.close();
  }
});

test("missing and cancel requested Items are held", () => {
  const db = tempDb();
  try {
    item(db, { id: "stopping" });
    db.run("UPDATE work_item SET cancel_requested=1 WHERE id='stopping'");
    const admission = createAdmission({ db });
    assert.deepEqual(admission.canStart("absent"), { ok: false, held: "missing" });
    assert.deepEqual(admission.canStart("stopping"), { ok: false, held: "cancelled" });
    assert.deepEqual(admission.canMerge("stopping"), { ok: false, held: "cancelled" });
  } finally {
    db.close();
  }
});

test("managed admission holds a delegation until its snapshots exist and changes are applied", () => {
  const db = tempDb();
  try {
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',0)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 0,
    });
    item(db, { id: "work", session: "session" });
    const managed = createAdmission({ db, managed: true });
    assert.deepEqual(managed.canStart("work"), { ok: false, held: "snapshot" });
    assert.equal(managed.canDispatchDelegation("delegation"), false);
    db.run("INSERT INTO item_reconciliation_request VALUES('work','workspace','token')");
    assert.deepEqual(managed.canStart("work"), { ok: false, held: "reconciling" });
    assert.equal(createAdmission({ db }).canDispatchDelegation("delegation"), true);
    assert.deepEqual(createAdmission({ db }).canStart("work"), { ok: false, held: "blocked" });
  } finally {
    db.close();
  }
});
