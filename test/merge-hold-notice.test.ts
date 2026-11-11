import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  enqueueOutbox,
  getWorkItem,
  listOutbox,
  recordRebaseReturn,
  restart,
  saveCandidatePaths,
  sqliteDb,
} from "../src/db";
import { joinFakeWorkspace, workspaceDispatch } from "./fake-workspace";
import { tempDb } from "./helpers";

const NOW = 30 * 24 * 60 * 60 * 1000;
const TOOLKIT = "libs/acme/toolkit.py";
const PROJECT = "pyproject.toml";

async function item(
  db: Database,
  id: string,
  state: string,
  position: number,
  paths: string[],
): Promise<void> {
  db.run(
    `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
     VALUES(?,?,?,?,?,?,?,?,0)`,
    [id, id, `issue-${id}`, id, id, state, `paws/${id}`, position],
  );
  db.run(
    "INSERT INTO work_item_repository(item_id,owner,repo,remote_url) VALUES(?,'acme','app','https://github.com/acme/app.git')",
    [id],
  );
  await joinFakeWorkspace(db, id);
  await saveCandidatePaths(sqliteDb(db), { itemId: id, head: `head-${id}`, paths, recordedAt: 1 });
}

/** A file that caused a merge-queue conflict lately, so the overlap gate holds work on it. */
async function hot(db: Database, files: string[]): Promise<void> {
  db.run(
    `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
     VALUES('earlier','earlier','issue-earlier','earlier','earlier','merged','paws/earlier',0,0)`,
  );
  db.run(
    "INSERT INTO work_item_repository(item_id,owner,repo,remote_url) VALUES('earlier','acme','app','https://github.com/acme/app.git')",
  );
  await recordRebaseReturn(sqliteDb(db), {
    itemId: "earlier",
    jobId: 9000,
    candidate: "head-earlier",
    reason: "merge",
    files,
    recordedAt: NOW - 60_000,
  });
}

async function respond(db: Database, id: string): Promise<void> {
  await enqueueOutbox(sqliteDb(db), {
    target: "linear",
    op: "activity",
    orderingKey: `session-${id}`,
    delivery: "ordered",
    idempotencyKey: `pull-request-ready:${id}:0`,
    payload: { sessionId: `session-${id}`, kind: "response", body: "Opened #7." },
  });
}

async function sendBack(db: Database, id: string, reason: "conflict" | "ci"): Promise<void> {
  await restart(sqliteDb(db), (await getWorkItem(sqliteDb(db), id))!, {
    reason,
    body: "Rebase.",
    jobKey: `${reason}:${id}`,
    now: NOW,
  });
}

async function holds(db: Database, id: string) {
  return (await listOutbox(sqliteDb(db), `session-${id}`))
    .filter((row) => row.idempotencyKey.startsWith("merge-hold:"))
    .map((row) => ({
      key: row.idempotencyKey,
      delivery: row.delivery,
      kind: (row.payload as { kind: string }).kind,
      body: (row.payload as { body: string }).body,
    }));
}

async function held(
  db: Database,
  id: string,
  reason: "conflict" | "ci",
  respondFirst = true,
): Promise<void> {
  await item(db, id, "merge_queue", 2, [TOOLKIT, PROJECT]);
  if (respondFirst) await respond(db, id);
  await sendBack(db, id, reason);
}

test("an item sent back to rebase and held behind another posts one line naming blocker and files", async () => {
  const db = tempDb();
  try {
    await hot(db, [TOOLKIT, PROJECT]);
    await item(db, "ACME-1", "running", 1, [TOOLKIT, PROJECT]);
    await held(db, "ACME-2", "conflict");

    for (const offset of [0, 1, 2]) await workspaceDispatch(db, { now: NOW + offset });

    expect(await holds(db, "ACME-2")).toEqual([
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
    await hot(db, [TOOLKIT, PROJECT]);
    await item(db, "ACME-1", "running", 1, [TOOLKIT, PROJECT]);
    await held(db, "ACME-2", "conflict");
    await held(db, "ACME-3", "conflict");

    await workspaceDispatch(db, { now: NOW });
    await workspaceDispatch(db, { now: NOW + 1 });

    expect(await holds(db, "ACME-2")).toHaveLength(1);
    expect(await holds(db, "ACME-3")).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("a hold says nothing without a conflict restart or before the pull request response", async () => {
  const db = tempDb();
  try {
    await hot(db, [TOOLKIT]);
    await item(db, "ACME-1", "running", 1, [TOOLKIT]);
    await held(db, "ACME-2", "ci");
    await held(db, "ACME-3", "conflict", false);

    await workspaceDispatch(db, { now: NOW });

    expect(await holds(db, "ACME-2")).toEqual([]);
    expect(await holds(db, "ACME-3")).toEqual([]);
  } finally {
    db.close();
  }
});
