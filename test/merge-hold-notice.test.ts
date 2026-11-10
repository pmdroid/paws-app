import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  enqueueOutbox,
  getWorkItem,
  listOutbox,
  recordRebaseReturn,
  restart,
  saveCandidatePaths,
} from "../src/db";
import { joinFakeWorkspace, workspaceDispatch } from "./fake-workspace";
import { tempDb } from "./helpers";

const NOW = 30 * 24 * 60 * 60 * 1000;
const TOOLKIT = "libs/acme/toolkit.py";
const PROJECT = "pyproject.toml";

function item(db: Database, id: string, state: string, position: number, paths: string[]): void {
  db.run(
    `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
     VALUES(?,?,?,?,?,?,?,?,0)`,
    [id, id, `issue-${id}`, id, id, state, `paws/${id}`, position],
  );
  db.run(
    "INSERT INTO work_item_repository(item_id,owner,repo,remote_url) VALUES(?,'acme','app','https://github.com/acme/app.git')",
    [id],
  );
  joinFakeWorkspace(db, id);
  saveCandidatePaths(db, { itemId: id, head: `head-${id}`, paths, recordedAt: 1 });
}

/** A file that caused a merge-queue conflict lately, so the overlap gate holds work on it. */
function hot(db: Database, files: string[]): void {
  db.run(
    `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
     VALUES('earlier','earlier','issue-earlier','earlier','earlier','merged','paws/earlier',0,0)`,
  );
  db.run(
    "INSERT INTO work_item_repository(item_id,owner,repo,remote_url) VALUES('earlier','acme','app','https://github.com/acme/app.git')",
  );
  recordRebaseReturn(db, {
    itemId: "earlier",
    jobId: 9000,
    candidate: "head-earlier",
    reason: "merge",
    files,
    recordedAt: NOW - 60_000,
  });
}

function respond(db: Database, id: string): void {
  enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: `session-${id}`,
    delivery: "ordered",
    idempotencyKey: `pull-request-ready:${id}:0`,
    payload: { sessionId: `session-${id}`, kind: "response", body: "Opened #7." },
  });
}

function sendBack(db: Database, id: string, reason: "conflict" | "ci"): void {
  restart(db, getWorkItem(db, id)!, {
    reason,
    body: "Rebase.",
    jobKey: `${reason}:${id}`,
    now: NOW,
  });
}

function holds(db: Database, id: string) {
  return listOutbox(db, `session-${id}`)
    .filter((row) => row.idempotencyKey.startsWith("merge-hold:"))
    .map((row) => ({
      key: row.idempotencyKey,
      delivery: row.delivery,
      kind: (row.payload as { kind: string }).kind,
      body: (row.payload as { body: string }).body,
    }));
}

function held(db: Database, id: string, reason: "conflict" | "ci", respondFirst = true): void {
  item(db, id, "merge_queue", 2, [TOOLKIT, PROJECT]);
  if (respondFirst) respond(db, id);
  sendBack(db, id, reason);
}

test("an item sent back to rebase and held behind another posts one line naming blocker and files", async () => {
  const db = tempDb();
  try {
    hot(db, [TOOLKIT, PROJECT]);
    item(db, "ACME-1", "running", 1, [TOOLKIT, PROJECT]);
    held(db, "ACME-2", "conflict");

    for (const offset of [0, 1, 2]) await workspaceDispatch(db, { now: NOW + offset });

    expect(holds(db, "ACME-2")).toEqual([
      {
        key: "merge-hold:0:ACME-1:ACME-2",
        delivery: "ordered",
        kind: "response",
        body: "Waiting for ACME-1 to merge first (both change toolkit.py, pyproject.toml), then rebasing.",
      },
    ]);
  } finally {
    db.close();
  }
});

test("two items held behind one blocker each get their own line", async () => {
  const db = tempDb();
  try {
    hot(db, [TOOLKIT, PROJECT]);
    item(db, "ACME-1", "running", 1, [TOOLKIT, PROJECT]);
    held(db, "ACME-2", "conflict");
    held(db, "ACME-3", "conflict");

    await workspaceDispatch(db, { now: NOW });
    await workspaceDispatch(db, { now: NOW + 1 });

    expect(holds(db, "ACME-2")).toHaveLength(1);
    expect(holds(db, "ACME-3")).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("a hold says nothing without a conflict restart or before the pull request response", async () => {
  const db = tempDb();
  try {
    hot(db, [TOOLKIT]);
    item(db, "ACME-1", "running", 1, [TOOLKIT]);
    held(db, "ACME-2", "ci");
    held(db, "ACME-3", "conflict", false);

    await workspaceDispatch(db, { now: NOW });

    expect(holds(db, "ACME-2")).toEqual([]);
    expect(holds(db, "ACME-3")).toEqual([]);
  } finally {
    db.close();
  }
});
