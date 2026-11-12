import { expect, test } from "bun:test";
import {
  enqueueOutbox,
  getWorkItem,
  listOutbox,
  recordRebaseReturn,
  restart,
  saveCandidatePaths,
  type Db,
} from "../src/db";
import { joinFakeWorkspacePg, workspaceDispatchPg } from "./fake-workspace";
import { tempStore } from "./pglite";

const NOW = 30 * 24 * 60 * 60 * 1000;
const TOOLKIT = "libs/acme/toolkit.py";
const PROJECT = "pyproject.toml";

async function insertItem(db: Db, id: string, state: string, position: number): Promise<void> {
  await db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.workItem).values({
        id,
        delegationId: id,
        linearIssueId: `issue-${id}`,
        linearIdentifier: id,
        title: id,
        state,
        branchName: `paws/${id}`,
        position,
        createdAt: 0,
      }),
    );
    yield* q.exec(
      q.orm.insert(q.t.workItemRepository).values({
        itemId: id,
        owner: "acme",
        repo: "app",
        remoteUrl: "https://github.com/acme/app.git",
      }),
    );
  });
}

async function item(
  db: Db,
  id: string,
  state: string,
  position: number,
  paths: string[],
): Promise<void> {
  await insertItem(db, id, state, position);
  await joinFakeWorkspacePg(db, id);
  await saveCandidatePaths(db, { itemId: id, head: `head-${id}`, paths, recordedAt: 1 });
}

/** A file that caused a merge-queue conflict lately, so the overlap gate holds work on it. */
async function hot(db: Db, files: string[]): Promise<void> {
  await insertItem(db, "earlier", "merged", 0);
  await recordRebaseReturn(db, {
    itemId: "earlier",
    jobId: 9000,
    candidate: "head-earlier",
    reason: "merge",
    files,
    recordedAt: NOW - 60_000,
  });
}

async function respond(db: Db, id: string): Promise<void> {
  await enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: `session-${id}`,
    delivery: "ordered",
    idempotencyKey: `pull-request-ready:${id}:0`,
    payload: { sessionId: `session-${id}`, kind: "response", body: "Opened #7." },
  });
}

async function sendBack(db: Db, id: string, reason: "conflict" | "ci"): Promise<void> {
  await restart(db, (await getWorkItem(db, id))!, {
    reason,
    body: "Rebase.",
    jobKey: `${reason}:${id}`,
    now: NOW,
  });
}

async function holds(db: Db, id: string) {
  return (await listOutbox(db, `session-${id}`))
    .filter((row) => row.idempotencyKey.startsWith("merge-hold:"))
    .map((row) => ({
      key: row.idempotencyKey,
      delivery: row.delivery,
      kind: (row.payload as { kind: string }).kind,
      body: (row.payload as { body: string }).body,
    }));
}

async function held(
  db: Db,
  id: string,
  reason: "conflict" | "ci",
  respondFirst = true,
): Promise<void> {
  await item(db, id, "merge_queue", 2, [TOOLKIT, PROJECT]);
  if (respondFirst) await respond(db, id);
  await sendBack(db, id, reason);
}

test("an item sent back to rebase and held behind another posts one line naming blocker and files", async () => {
  const { db, close } = await tempStore();
  try {
    await hot(db, [TOOLKIT, PROJECT]);
    await item(db, "ACME-1", "running", 1, [TOOLKIT, PROJECT]);
    await held(db, "ACME-2", "conflict");

    for (const offset of [0, 1, 2]) await workspaceDispatchPg(db, { now: NOW + offset });

    expect(await holds(db, "ACME-2")).toEqual([
      {
        key: "merge-hold:0:ACME-1:ACME-2",
        delivery: "ordered",
        kind: "response",
        body: "Waiting for ACME-1 to merge first (both change toolkit.py, pyproject.toml), then rebasing.",
      },
    ]);
  } finally {
    await close();
  }
});

test("two items held behind one blocker each get their own line", async () => {
  const { db, close } = await tempStore();
  try {
    await hot(db, [TOOLKIT, PROJECT]);
    await item(db, "ACME-1", "running", 1, [TOOLKIT, PROJECT]);
    await held(db, "ACME-2", "conflict");
    await held(db, "ACME-3", "conflict");

    await workspaceDispatchPg(db, { now: NOW });
    await workspaceDispatchPg(db, { now: NOW + 1 });

    expect(await holds(db, "ACME-2")).toHaveLength(1);
    expect(await holds(db, "ACME-3")).toHaveLength(1);
  } finally {
    await close();
  }
});

test("a hold says nothing without a conflict restart or before the pull request response", async () => {
  const { db, close } = await tempStore();
  try {
    await hot(db, [TOOLKIT]);
    await item(db, "ACME-1", "running", 1, [TOOLKIT]);
    await held(db, "ACME-2", "ci");
    await held(db, "ACME-3", "conflict", false);

    await workspaceDispatchPg(db, { now: NOW });

    expect(await holds(db, "ACME-2")).toEqual([]);
    expect(await holds(db, "ACME-3")).toEqual([]);
  } finally {
    await close();
  }
});
