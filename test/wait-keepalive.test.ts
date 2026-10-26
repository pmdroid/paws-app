import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listOutbox, recordConfirmedRemoteMerge } from "../src/db";
import { recordItemDependencies } from "../src/intake";
import { WAIT_KEEPALIVE_MS, type ItemWait } from "../src/scheduler";
import { joinFakeWorkspace, workspaceDispatch } from "./fake-workspace";
import { tempDb } from "./helpers";

const MINUTE = 60_000;

function item(db: Database, id: string, delegation: string, state: string) {
  db.run(
    `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
     VALUES(?,?,?,?,?,?,?,0,0)`,
    [id, delegation, `issue-${id}`, id, id, state, `paws/${id}`],
  );
}

function activities(db: Database, sessionId: string) {
  return listOutbox(db, sessionId)
    .filter((row) => row.op === "activity")
    .map((row) => ({
      key: row.idempotencyKey,
      status: row.status,
      body: (row.payload as { body: string }).body,
      ephemeral: (row.payload as { ephemeral?: boolean }).ephemeral === true,
    }));
}

function blockedFixture() {
  const db = tempDb();
  item(db, "PAS-618", "first", "running");
  item(db, "PAS-619", "second", "queued");
  db.run("INSERT INTO task_block VALUES('issue-PAS-618','issue-PAS-619')");
  joinFakeWorkspace(db, "first");
  joinFakeWorkspace(db, "second");
  const workspaceId = db.query<{ id: string }, []>("SELECT id FROM workspace").get()!.id;
  const generation =
    db
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM item_dependency_snapshot WHERE item_id=?",
      )
      .get("PAS-619")?.generation ?? 0;
  recordItemDependencies(
    db,
    { itemId: "PAS-619", workspaceId, expectedGeneration: generation },
    {
      edges: [{ blockerLinearIssueId: "issue-PAS-618", blockedLinearIssueId: "issue-PAS-619" }],
      states: new Map([["issue-PAS-618", "started"]]),
      identifiers: new Map([["issue-PAS-618", "PAS-618"]]),
    },
  );
  return db;
}

test("a blocked item gets one thought, then an ephemeral at each 25-minute mark until it starts", () => {
  const db = blockedFixture();
  try {
    const session = "session-second";
    const start = Date.now();
    const waits: ItemWait[][] = [];
    const tick = (minutes: number) =>
      workspaceDispatch(db, {
        now: start + minutes * MINUTE,
        onWaits: (w: readonly ItemWait[]) => waits.push([...w]),
      });

    expect(tick(0)).toEqual([]);
    expect(waits.at(-1)).toEqual([
      {
        itemId: "PAS-619",
        sessionId: session,
        identifier: "PAS-619",
        version: expect.any(Number),
        kind: "blocked",
        blockers: ["PAS-618"],
      },
    ]);
    expect(activities(db, session)).toEqual([
      expect.objectContaining({ body: "Waiting for PAS-618 before starting.", ephemeral: false }),
    ]);

    // Ticks inside the first 25 minutes add nothing.
    tick(1);
    tick(24);
    expect(activities(db, session)).toHaveLength(1);

    tick(25);
    tick(25);
    tick(30);
    expect(activities(db, session).filter((row) => row.ephemeral)).toEqual([
      expect.objectContaining({ body: "Still waiting for PAS-618.", status: "pending" }),
    ]);

    // Delivery is down: the next mark replaces the pending one instead of queueing a second.
    tick(50);
    const ephemerals = activities(db, session).filter((row) => row.ephemeral);
    expect(ephemerals.map((row) => row.status)).toEqual(["dropped", "pending"]);
    expect(ephemerals[1]!.key).toEndWith(":keep:2");

    // A restart of Paws replays the same mark under the same key.
    tick(55);
    expect(activities(db, session).filter((row) => row.ephemeral)).toHaveLength(2);

    db.run("UPDATE work_item SET state='merged' WHERE id='PAS-618'");
    recordConfirmedRemoteMerge(db, {
      itemId: "PAS-618",
      repositoryOwner: "owner",
      repositoryName: "repo",
      pullNumber: 1,
      pullUrl: null,
      mergeSha: "merge-PAS-618",
      confirmedAt: 1000,
    });
    expect(tick(60)).toEqual(["PAS-619"]);
    expect(waits.at(-1)).toEqual([]);
    tick(75);
    tick(100);
    expect(activities(db, session).filter((row) => row.ephemeral)).toHaveLength(2);
    expect(
      activities(db, session).filter(
        (row) => row.ephemeral && row.status === "pending" && row.body.startsWith("Still"),
      ),
    ).toHaveLength(1);
    expect(db.query("SELECT 1 FROM item_wait").get()).toBeNull();
  } finally {
    db.close();
  }
});

test("a runner-queued item says its place in line every 25 minutes", () => {
  const db = tempDb();
  try {
    const start = Date.now();
    item(db, "PAS-1", "first", "running");
    item(db, "PAS-2", "second", "queued");
    item(db, "PAS-3", "third", "queued");
    db.run("UPDATE work_item SET created_at=1 WHERE id='PAS-3'");
    for (const delegation of ["first", "second", "third"]) joinFakeWorkspace(db, delegation);
    db.run("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner','ws','owner','Runner','active',0,?)",
      [start + 200 * MINUTE],
    );
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES('run','runner','ws',1,0,'command',?,0)",
      [start + 200 * MINUTE],
    );
    const waits: ItemWait[][] = [];
    const tick = (minutes: number) =>
      workspaceDispatch(db, {
        now: start + minutes * MINUTE,
        onWaits: (w: readonly ItemWait[]) => waits.push([...w]),
      });
    expect(tick(0)).toEqual([]);
    expect(
      waits.at(-1)!.map((wait) => [wait.identifier, wait.kind === "runner" && wait.position]),
    ).toEqual([
      ["PAS-2", 1],
      ["PAS-3", 2],
    ]);
    tick(25);
    expect(activities(db, "session-third").map((row) => row.body)).toEqual([
      "Still 2nd in line for a runner.",
    ]);
    expect(activities(db, "session-second").map((row) => row.body)).toEqual([
      "Still 1st in line for a runner.",
    ]);
    expect(WAIT_KEEPALIVE_MS).toBe(25 * MINUTE);
  } finally {
    db.close();
  }
});

test("a sibling at work keeps its session's face, and a paused item posts no ephemeral", () => {
  const db = tempDb();
  try {
    item(db, "PAS-10", "shared", "running");
    item(db, "PAS-11", "shared", "queued");
    db.run("UPDATE work_item SET position=1 WHERE id='PAS-11'");
    db.run("INSERT INTO task_block VALUES('issue-PAS-10','issue-PAS-11')");
    item(db, "PAS-12", "alone", "paused");
    joinFakeWorkspace(db, "shared");
    joinFakeWorkspace(db, "alone");
    db.run(
      "INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES('u','lu','Pascal','p@x')",
    );
    db.run(
      "INSERT INTO workspace_access_audit(workspace_id,user_id,action,subject,created_at) VALUES(NULL,'u','execution.pause','PAS-12',0)",
    );
    const waits: ItemWait[][] = [];
    const start = Date.now();
    workspaceDispatch(db, { now: start, onWaits: (w: readonly ItemWait[]) => waits.push([...w]) });
    workspaceDispatch(db, {
      now: start + 60 * MINUTE,
      onWaits: (w: readonly ItemWait[]) => waits.push([...w]),
    });
    expect(waits.at(-1)).toEqual([
      expect.objectContaining({ identifier: "PAS-12", kind: "paused", by: "Pascal" }),
    ]);
    expect(activities(db, "session-alone")).toEqual([]);
    expect(activities(db, "session-shared").filter((row) => row.ephemeral)).toEqual([]);
  } finally {
    db.close();
  }
});
