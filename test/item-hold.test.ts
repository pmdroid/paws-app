import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setJournalSink } from "../src/journal";
import { listItemHolds, syncSteps, type Db } from "../src/db";
import { recordItemDependenciesSteps } from "../src/intake";
import { createAdmission, dispatch, type ItemAdmission } from "../src/scheduler";
import { createLiveStatusProvider } from "../src/dashboard";
import {
  confirmFakeMergePg,
  joinFakeWorkspacePg,
  workspaceAdmission,
  workspaceDispatchPg,
} from "./fake-workspace";
import { seed, withoutForeignKeys } from "./dialects";
import { tempStore } from "./pglite";

function item(db: Db, id: string, state = "queued", position = 0) {
  return seed(db, (q) =>
    q.orm.insert(q.t.workItem).values({
      id,
      delegationId: "delegation",
      linearIssueId: `issue-${id}`,
      linearIdentifier: id,
      title: id,
      state,
      branchName: `paws/${id}`,
      position,
      createdAt: position,
    }),
  );
}

function block(db: Db, blocker: string, blocked: string) {
  return seed(db, (q) =>
    q.orm.insert(q.t.taskBlock).values({
      blockerLinearIssueId: `issue-${blocker}`,
      blockedLinearIssueId: `issue-${blocked}`,
    }),
  );
}

function merged(db: Db, id: string) {
  return seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ state: "merged" }).where(eq(q.t.workItem.id, id)),
  );
}

async function fullRunner(db: Db) {
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
        lastSeenAt: Date.now(),
      }),
    (q) =>
      q.orm.insert(q.t.runnerWork).values({
        runId: "run",
        runnerId: "runner",
        workspaceId: "ws",
        generation: 1,
        runnerFence: 0,
        commandId: "command",
        leaseUntil: Date.now() + 600_000,
        lastSequence: 0,
      }),
  );
}

function journal() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

test("a blocked item names its blocker once in the journal and once more when it starts", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, "PAS-367", "running");
    await item(db, "PAS-368", "queued", 1);
    await block(db, "PAS-367", "PAS-368");
    const { lines, log } = journal();
    expect(await workspaceDispatchPg(db, { now: 1, log })).toEqual([]);
    expect(await workspaceDispatchPg(db, { now: 2, log })).toEqual([]);
    expect(await listItemHolds(db)).toEqual([
      { itemId: "PAS-368", reason: "blocked", blockers: ["PAS-367"] },
    ]);
    expect(lines).toEqual(["item PAS-368 held: blocked by PAS-367"]);
    await merged(db, "PAS-367");
    expect(await workspaceDispatchPg(db, { now: 3, log })).toEqual([]);
    expect(await listItemHolds(db)).toEqual([
      { itemId: "PAS-368", reason: "blocked", blockers: ["PAS-367"] },
    ]);
    expect(
      (await createLiveStatusProvider(db).issues()).issues.find((entry) => entry.id === "PAS-368")
        ?.blockers,
    ).toEqual(["PAS-367"]);
    await confirmFakeMergePg(db, "PAS-367");
    expect(await workspaceDispatchPg(db, { now: 3, log })).toEqual(["PAS-368"]);
    expect(await listItemHolds(db)).toEqual([]);
    expect(lines).toEqual(["item PAS-368 held: blocked by PAS-367", "item PAS-368 no longer held"]);
  } finally {
    await close();
  }
});

async function externalBlocker(db: Db, state: string) {
  await item(db, "PAS-840");
  await joinFakeWorkspacePg(db, "delegation");
  await db.transaction(function* (q) {
    const { id: workspaceId } = (yield* q.one(
      q.orm.select({ id: q.t.workspace.id }).from(q.t.workspace),
    ))!;
    const snapshot = yield* q.one(
      q.orm
        .select({ generation: q.t.itemDependencySnapshot.generation })
        .from(q.t.itemDependencySnapshot)
        .where(eq(q.t.itemDependencySnapshot.itemId, "PAS-840")),
    );
    const generation = snapshot?.generation ?? 0;
    return yield* recordItemDependenciesSteps(
      q,
      { itemId: "PAS-840", workspaceId, expectedGeneration: generation },
      {
        edges: [{ blockerLinearIssueId: "issue-OPS-12", blockedLinearIssueId: "issue-PAS-840" }],
        states: new Map([["issue-OPS-12", state]]),
        identifiers: new Map([["issue-OPS-12", "OPS-12"]]),
      },
    );
  });
}

for (const state of ["started", "unstarted"])
  test(`an item blocked by a ${state} issue Paws does not run names that issue`, async () => {
    const { db, close } = await tempStore();
    const journaled: string[] = [];
    const restore = setJournalSink((line) => journaled.push(line));
    try {
      await externalBlocker(db, state);
      const { lines, log } = journal();
      expect(
        await dispatch(db, {
          now: 1,
          log,
          admission: createAdmission({ db }),
        }),
      ).toEqual([]);
      expect(await listItemHolds(db)).toEqual([
        { itemId: "PAS-840", reason: "blocked", blockers: ["OPS-12"] },
      ]);
      expect(lines).toEqual(["item PAS-840 held: blocked by OPS-12"]);
      expect(journaled).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });

test("a blocked hold without an open blocker is journaled as an inconsistency", async () => {
  const { db, close } = await tempStore();
  const journaled: string[] = [];
  const restore = setJournalSink((line) => journaled.push(line));
  try {
    await item(db, "PAS-841");
    const blocked: ItemAdmission = {
      canDispatchDelegation: async () => true,
      canStart: async () => ({ ok: false, held: "blocked" }),
      canMerge: async () => ({ ok: false, held: "blocked" }),
      steps: {
        canDispatchDelegation: () => syncSteps(() => true),
        canStart: () => syncSteps(() => ({ ok: false, held: "blocked" })),
        canMerge: () => syncSteps(() => ({ ok: false, held: "blocked" })),
      },
    };
    const { lines, log } = journal();
    expect(await dispatch(db, { now: 1, log, admission: blocked })).toEqual([]);
    expect(await dispatch(db, { now: 2, log, admission: blocked })).toEqual([]);
    expect(await listItemHolds(db)).toEqual([
      { itemId: "PAS-841", reason: "blocked", blockers: [] },
    ]);
    expect(lines).toEqual(["item PAS-841 held: blocked by another issue"]);
    expect(journaled).toEqual([
      "scheduler inconsistency: item PAS-841 is held as blocked but has no open blocker",
    ]);
  } finally {
    restore();
    await close();
  }
});

test("a ready item without a free slot, then over its owner cap, journals each new reason", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, "PAS-1", "running");
    await item(db, "PAS-2", "queued", 1);
    const { lines, log } = journal();
    await fullRunner(db);
    const now = Date.now();
    await workspaceDispatchPg(db, { now, log });
    expect(await listItemHolds(db)).toEqual([{ itemId: "PAS-2", reason: "slot", blockers: [] }]);
    await workspaceDispatchPg(db, { now: now + 1, log });
    await seed(db, (q) => q.orm.delete(q.t.runnerWork));
    await workspaceDispatchPg(db, { now: now + 2, log, ownerCap: 1 });
    expect(await listItemHolds(db)).toEqual([{ itemId: "PAS-2", reason: "cap", blockers: [] }]);
    expect(lines).toEqual([
      "item PAS-2 held: no free slot on any runner",
      "item PAS-2 held: its owner already runs the most tasks at once",
    ]);
  } finally {
    await close();
  }
});

test("a project that holds an item is its held reason", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, "PAS-5");
    const { lines, log } = journal();
    const admission = workspaceAdmission(db, { authority: () => false });
    expect(await dispatch(db, { now: 1, log, admission })).toEqual([]);
    expect(await listItemHolds(db)).toEqual([{ itemId: "PAS-5", reason: "project", blockers: [] }]);
    expect(lines).toEqual(["item PAS-5 held: its project has not released it yet"]);
  } finally {
    await close();
  }
});

test("without a workspace every queued item is held for the workspace, journaled once", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, "PAS-7", "running");
    await item(db, "PAS-8", "queued", 1);
    await block(db, "PAS-7", "PAS-8");
    const { lines, log } = journal();
    expect(await workspaceDispatchPg(db, { now: 1, log })).toEqual([]);
    await confirmFakeMergePg(db, "PAS-7");
    await merged(db, "PAS-7");
    await item(db, "PAS-9", "queued", 2);
    const admission = createAdmission({ db, workspace: false });
    expect(await dispatch(db, { now: 2, log, admission })).toEqual([]);
    expect(await dispatch(db, { now: 3, log, admission })).toEqual([]);
    expect(await listItemHolds(db)).toEqual([
      { itemId: "PAS-8", reason: "workspace", blockers: [] },
      { itemId: "PAS-9", reason: "workspace", blockers: [] },
    ]);
    expect(lines).toEqual([
      "item PAS-8 held: blocked by PAS-7",
      "item PAS-8 held: no Linear workspace",
      "item PAS-9 held: no Linear workspace",
    ]);
    expect(
      (await createLiveStatusProvider(db).issues()).issues.find((entry) => entry.id === "PAS-9")
        ?.held,
    ).toEqual({ reason: "workspace", blockers: [] });
  } finally {
    await close();
  }
});

test("the status API carries the held reason of a queued item", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, "PAS-367", "running");
    await item(db, "PAS-368", "queued", 1);
    await block(db, "PAS-367", "PAS-368");
    await workspaceDispatchPg(db, { now: 1 });
    const items = (await createLiveStatusProvider(db).issues()).issues;
    expect(items.find((entry) => entry.id === "PAS-368")?.held).toEqual({
      reason: "blocked",
      blockers: ["PAS-367"],
    });
    expect(items.find((entry) => entry.id === "PAS-367")?.held).toBeUndefined();
  } finally {
    await close();
  }
});

test("an item blocked only by an issue canceled in Linear is not held", async () => {
  const { db, close } = await tempStore();
  try {
    await externalBlocker(db, "canceled");
    const { lines, log } = journal();
    await dispatch(db, { now: 1, log, admission: createAdmission({ db }) });
    expect(await listItemHolds(db)).toEqual([]);
    expect(lines).toEqual([]);
  } finally {
    await close();
  }
});
