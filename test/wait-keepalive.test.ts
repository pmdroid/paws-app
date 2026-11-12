import { expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { listOutbox, recordConfirmedRemoteMerge, type Db } from "../src/db";
import { recordItemDependenciesSteps } from "../src/intake";
import { WAIT_KEEPALIVE_MS, type ItemWait } from "../src/scheduler";
import { seed, withoutForeignKeys } from "./dialects";
import { joinFakeWorkspacePg, workspaceDispatchPg } from "./fake-workspace";
import { tempStore } from "./pglite";

const MINUTE = 60_000;

function item(db: Db, id: string, delegation: string, state: string, position = 0) {
  return seed(db, (q) =>
    q.orm.insert(q.t.workItem).values({
      id,
      delegationId: delegation,
      linearIssueId: `issue-${id}`,
      linearIdentifier: id,
      title: id,
      state,
      branchName: `paws/${id}`,
      position,
      createdAt: 0,
    }),
  );
}

function block(db: Db, blocker: string, blocked: string) {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.taskBlock)
      .values({ blockerLinearIssueId: blocker, blockedLinearIssueId: blocked }),
  );
}

async function activities(db: Db, sessionId: string) {
  return (await listOutbox(db, sessionId))
    .filter((row) => row.op === "activity")
    .map((row) => ({
      key: row.idempotencyKey,
      status: row.status,
      body: (row.payload as { body: string }).body,
      ephemeral: (row.payload as { ephemeral?: boolean }).ephemeral === true,
    }));
}

async function blockedFixture() {
  const store = await tempStore();
  const { db } = store;
  await item(db, "PAS-618", "first", "running");
  await item(db, "PAS-619", "second", "queued");
  await block(db, "issue-PAS-618", "issue-PAS-619");
  await joinFakeWorkspacePg(db, "first");
  await joinFakeWorkspacePg(db, "second");
  const workspaceId = (await db.run((q) =>
    q.one(q.orm.select({ id: q.t.workspace.id }).from(q.t.workspace)),
  ))!.id;
  const snapshot = await db.run((q) =>
    q.one(
      q.orm
        .select({ generation: q.t.itemDependencySnapshot.generation })
        .from(q.t.itemDependencySnapshot)
        .where(eq(q.t.itemDependencySnapshot.itemId, "PAS-619")),
    ),
  );
  const generation = snapshot?.generation ?? 0;
  await db.transaction((q) =>
    recordItemDependenciesSteps(
      q,
      { itemId: "PAS-619", workspaceId, expectedGeneration: generation },
      {
        edges: [{ blockerLinearIssueId: "issue-PAS-618", blockedLinearIssueId: "issue-PAS-619" }],
        states: new Map([["issue-PAS-618", "started"]]),
        identifiers: new Map([["issue-PAS-618", "PAS-618"]]),
      },
    ),
  );
  return store;
}

test("a blocked item gets one thought, then an ephemeral at each 25-minute mark until it starts", async () => {
  const { db, close } = await blockedFixture();
  try {
    const session = "session-second";
    const start = Date.now();
    const waits: ItemWait[][] = [];
    const tick = (minutes: number) =>
      workspaceDispatchPg(db, {
        now: start + minutes * MINUTE,
        onWaits: (w: readonly ItemWait[]) => waits.push([...w]),
      });

    expect(await tick(0)).toEqual([]);
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
    expect(await activities(db, session)).toEqual([
      expect.objectContaining({ body: "Waiting for PAS-618 before starting.", ephemeral: false }),
    ]);

    // Ticks inside the first 25 minutes add nothing.
    await tick(1);
    await tick(24);
    expect(await activities(db, session)).toHaveLength(1);

    await tick(25);
    await tick(25);
    await tick(30);
    expect((await activities(db, session)).filter((row) => row.ephemeral)).toEqual([
      expect.objectContaining({
        body: "Still waiting for PAS-618. Paws checks blockers in Linear every minute while it waits.",
        status: "pending",
      }),
    ]);

    // Delivery is down: the next mark replaces the pending one instead of queueing a second.
    await tick(50);
    const ephemerals = (await activities(db, session)).filter((row) => row.ephemeral);
    expect(ephemerals.map((row) => row.status)).toEqual(["dropped", "pending"]);
    expect(ephemerals[1]!.key).toEndWith(":keep:2");

    // A restart of Paws replays the same mark under the same key.
    await tick(55);
    expect((await activities(db, session)).filter((row) => row.ephemeral)).toHaveLength(2);

    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "merged" }).where(eq(q.t.workItem.id, "PAS-618")),
    );
    await recordConfirmedRemoteMerge(db, {
      itemId: "PAS-618",
      repositoryOwner: "owner",
      repositoryName: "repo",
      pullNumber: 1,
      pullUrl: null,
      mergeSha: "merge-PAS-618",
      confirmedAt: 1000,
    });
    expect(await tick(60)).toEqual(["PAS-619"]);
    expect(waits.at(-1)).toEqual([]);
    await tick(75);
    await tick(100);
    expect((await activities(db, session)).filter((row) => row.ephemeral)).toHaveLength(2);
    expect(
      (await activities(db, session)).filter(
        (row) => row.ephemeral && row.status === "pending" && row.body.startsWith("Still"),
      ),
    ).toHaveLength(1);
    expect(await db.run((q) => q.one(q.orm.select({ n: count() }).from(q.t.itemWait)))).toEqual({
      n: 0,
    });
  } finally {
    await close();
  }
});

test("a runner-queued item says its place in line every 25 minutes", async () => {
  const { db, close } = await tempStore();
  try {
    const start = Date.now();
    await item(db, "PAS-1", "first", "running");
    await item(db, "PAS-2", "second", "queued");
    await item(db, "PAS-3", "third", "queued");
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ createdAt: 1 }).where(eq(q.t.workItem.id, "PAS-3")),
    );
    for (const delegation of ["first", "second", "third"])
      await joinFakeWorkspacePg(db, delegation);
    await withoutForeignKeys(db);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id: "runner",
          workspaceId: "ws",
          ownerUserId: "owner",
          name: "Runner",
          status: "active",
          createdAt: 0,
          lastSeenAt: start + 200 * MINUTE,
        }),
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: "run",
          runnerId: "runner",
          workspaceId: "ws",
          generation: 1,
          runnerFence: 0,
          commandId: "command",
          leaseUntil: start + 200 * MINUTE,
          lastSequence: 0,
        }),
    );
    const waits: ItemWait[][] = [];
    const tick = (minutes: number) =>
      workspaceDispatchPg(db, {
        now: start + minutes * MINUTE,
        onWaits: (w: readonly ItemWait[]) => waits.push([...w]),
      });
    expect(await tick(0)).toEqual([]);
    expect(
      waits.at(-1)!.map((wait) => [wait.identifier, wait.kind === "runner" && wait.position]),
    ).toEqual([
      ["PAS-2", 1],
      ["PAS-3", 2],
    ]);
    await tick(25);
    expect((await activities(db, "session-third")).map((row) => row.body)).toEqual([
      "Still 2nd in line for a runner.",
    ]);
    expect((await activities(db, "session-second")).map((row) => row.body)).toEqual([
      "Still 1st in line for a runner.",
    ]);
    expect(WAIT_KEEPALIVE_MS).toBe(25 * MINUTE);
  } finally {
    await close();
  }
});

test("a sibling at work keeps its session's face, and a paused item posts no ephemeral", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, "PAS-10", "shared", "running");
    await item(db, "PAS-11", "shared", "queued", 1);
    await block(db, "issue-PAS-10", "issue-PAS-11");
    await item(db, "PAS-12", "alone", "paused");
    await joinFakeWorkspacePg(db, "shared");
    await joinFakeWorkspacePg(db, "alone");
    await seed(
      db,
      (q) =>
        q.orm
          .insert(q.t.workspaceUser)
          .values({ id: "u", linearUserId: "lu", name: "Pascal", email: "p@x" }),
      (q) =>
        q.orm.insert(q.t.workspaceAccessAudit).values({
          workspaceId: null,
          userId: "u",
          action: "execution.pause",
          subject: "PAS-12",
          createdAt: 0,
        }),
    );
    const waits: ItemWait[][] = [];
    const start = Date.now();
    await workspaceDispatchPg(db, {
      now: start,
      onWaits: (w: readonly ItemWait[]) => waits.push([...w]),
    });
    await workspaceDispatchPg(db, {
      now: start + 60 * MINUTE,
      onWaits: (w: readonly ItemWait[]) => waits.push([...w]),
    });
    expect(waits.at(-1)).toEqual([
      expect.objectContaining({ identifier: "PAS-12", kind: "paused", by: "Pascal" }),
    ]);
    expect(await activities(db, "session-alone")).toEqual([]);
    expect((await activities(db, "session-shared")).filter((row) => row.ephemeral)).toEqual([]);
  } finally {
    await close();
  }
});
