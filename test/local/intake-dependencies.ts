import { confirmFakeMergePg } from "../fake-workspace";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bindLinearSessionTask,
  openPawsStore,
  pgSchema,
  recordLinearInstallation,
  saveTaskMode,
  type PgDb,
  type Q,
} from "../../src/db";
import {
  intakeDelegatedIssue,
  readyItemsSteps,
  syncItemDependencies,
  type DependencyReadiness,
} from "../../src/intake";
import { createFakeTracker, createFakeLinearIssueLifecycle } from "../../src/linear";
import { pgliteServer } from "../pglite";

export async function probeDependencySnapshots(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const postgres = await pgliteServer();
  const connect = () => openPawsStore({ url: postgres.url, pgliteDir: "" });
  const db = postgres.store as PgDb;
  const change = (update: (q: Q) => PromiseLike<unknown>) => db.run((q) => q.exec(update(q)));
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "DEP-1",
      title: "Parent",
      description: null,
      subIssues: ["a", "b", "c", "free"].map((id, index) => ({
        linearIssueId: id,
        identifier: `DEP-${index + 2}`,
        title: id,
      })),
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "a",
    teamId: "team",
    stateType: "started",
    assigneeId: null,
    delegateId: null,
  });
  lifecycle.issues.set("b", { ...lifecycle.issue, id: "b" });
  lifecycle.issues.set("outside", { ...lifecycle.issue, id: "outside", stateType: "completed" });
  try {
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      now: 1000,
    });
    assert(intake.ok);
    const ids = new Map(intake.items.map((item) => [item.linearIssueId, item.id]));
    const workspaceId = "workspace";
    const focus = ids.get("b")!;
    const target = { itemId: focus, workspaceId };
    const readiness = async () => {
      const all: DependencyReadiness[] = [];
      for (const itemId of ids.values())
        all.push(await db.run((q) => readyItemsSteps(q, { itemId, workspaceId })));
      return all;
    };
    const readyIds = async () => (await readiness()).flatMap((entry) => entry.readyItemIds);
    const cycleIds = async () => (await readiness()).flatMap((entry) => entry.cycleHeldItemIds);
    await change((q) =>
      q.orm.insert(q.t.workspace).values([
        { id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 1000 },
        { id: "other", linearOrganizationId: "outside-org", name: "Other", createdAt: 1000 },
      ]),
    );
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(db, "session", intake.delegation.id, {
      actorId: "owner",
    });
    await saveTaskMode(db, ids.get("a")!, "code");
    const refresh = async () => {
      for (const itemId of ids.values())
        await syncItemDependencies(db, {
          itemId,
          workspaceId,
          expectedGeneration: (await db.run((q) => readyItemsSteps(q, { itemId, workspaceId })))
            .generation,
          tracker,
          lifecycle,
        });
    };
    const edge = (blockerLinearIssueId: string, blockedLinearIssueId: string) => ({
      blockerLinearIssueId,
      blockedLinearIssueId,
    });
    const taskBlocks = async () =>
      (await db.run((q) => q.all(q.orm.select().from(q.t.taskBlock)))).length;
    const observed = (name: string, value: unknown) => observe(name, true, value);
    const addedSchema = (await db.orm.execute(
      sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('epic_dependency_snapshot','external_dep','external_dep_blocker','work_item_block','epic_execution_control') ORDER BY table_name`,
    )) as unknown as { name: string }[];
    assert.deepEqual(
      addedSchema.map((row) => row.name),
      [],
    );
    assert.deepEqual(await readyIds(), []);
    observed("Uninitialized snapshots hold every queued item", {
      addedSchema,
      readiness: await readyIds(),
    });
    tracker.deps.set("parent", [edge("a", "b"), edge("outside", "b")]);
    tracker.deps.set("a", [edge("a", "b")]);
    await refresh();
    assert.equal(await taskBlocks(), 2);
    assert(!(await db.run((q) => readyItemsSteps(q, target))).readyItemIds.includes(ids.get("b")!));
    observed(
      "Complete snapshots persist deduplicated internal and external edges",
      await db.run((q) => readyItemsSteps(q, target)),
    );
    const cases = [
      ["queued", "code", "completed", false],
      ["running", "code", "completed", false],
      ["verifying", "code", "completed", false],
      ["completed", "code", "completed", false],
      ["cancelled", "code", "completed", false],
      ["merged", "code", "started", true],
      ["merged", "code", "canceled", true],
      ["manual", "code", "completed", true],
      ["manual", "code", "canceled", true],
      ["manual", "code", "started", false],
      ["completed", "answer", "started", true],
      ["completed", "answer", "canceled", true],
      ["completed", "artifact", "started", true],
      ["completed", "artifact", "canceled", true],
    ] as const;
    const a = ids.get("a")!;
    const setA = (values: { state?: string; cancelRequested?: number }) =>
      change((q) => q.orm.update(q.t.workItem).set(values).where(eq(q.t.workItem.id, a)));
    await confirmFakeMergePg(db, a);
    for (const [state, mode, linearState, expected] of cases) {
      await setA({ state });
      await change((q) =>
        q.orm.update(q.t.workItemTask).set({ mode }).where(eq(q.t.workItemTask.itemId, a)),
      );
      lifecycle.issue.stateType = linearState;
      await refresh();
      assert.equal(
        (await db.run((q) => readyItemsSteps(q, target))).readyItemIds.includes(ids.get("b")!),
        expected,
      );
    }
    observed(
      "Readiness distinguishes merged code, delivered tasks, manual completion and cancellation",
      cases,
    );
    lifecycle.issue.stateType = "started";
    await setA({ state: "merged", cancelRequested: 1 });
    await refresh();
    assert(!(await db.run((q) => readyItemsSteps(q, target))).readyItemIds.includes(ids.get("b")!));
    await setA({ cancelRequested: 0 });
    for (const state of ["started", "canceled", "Completed", "completed ", "completed"]) {
      lifecycle.issues.get("outside")!.stateType = state;
      await refresh();
      assert.equal(
        (await db.run((q) => readyItemsSteps(q, target))).readyItemIds.includes(ids.get("b")!),
        state === "completed" || state === "canceled",
      );
    }
    observed(
      "Cancellation flags and open external states never satisfy blockers",
      await db.run((q) => readyItemsSteps(q, target)),
    );
    tracker.deps.clear();
    tracker.deps.set("parent", [edge("a", "b"), edge("b", "a"), edge("b", "c")]);
    await change((q) =>
      q.orm
        .update(q.t.workItem)
        .set({ state: "queued" })
        .where(eq(q.t.workItem.delegationId, intake.delegation.id)),
    );
    await refresh();
    assert.deepEqual(await readyIds(), [ids.get("free")!]);
    assert.deepEqual(new Set(await cycleIds()), new Set(["a", "b", "c"].map((id) => ids.get(id)!)));
    observed(
      "Cycles and descendants hold while unrelated work remains ready",
      await db.run((q) => readyItemsSteps(q, target)),
    );
    const generation = (await db.run((q) => readyItemsSteps(q, target))).generation;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const late = syncItemDependencies(db, {
      ...target,
      expectedGeneration: generation,
      lifecycle,
      tracker: {
        async listDeps(id) {
          const edges = await tracker.listDeps(id);
          if (!held) {
            held = true;
            enter();
            await gate;
          }
          return edges;
        },
      },
    });
    await entered;
    const concurrent = await connect();
    try {
      await concurrent.store.orm.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE task_block, item_dependency_snapshot IN EXCLUSIVE MODE`);
      });
    } finally {
      await concurrent.close();
    }
    tracker.deps.clear();
    await refresh();
    release();
    await assert.rejects(late, /snapshot changed/);
    assert.equal(await taskBlocks(), 0);
    assert.equal((await readyIds()).length, 4);
    await assert.rejects(
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: generation,
        tracker,
        lifecycle,
      }),
      /snapshot changed/,
    );
    observed(
      "Newer snapshots remove edges and reject delayed older publications",
      await db.run((q) => readyItemsSteps(q, target)),
    );
    await assert.rejects(
      db.run((q) => readyItemsSteps(q, { ...target, workspaceId: "other" })),
      /ownership changed/,
    );
    const before = (await db.run((q) => readyItemsSteps(q, target))).generation;
    tracker.deps.set("parent", [edge("outside", "b")]);
    await db.orm.execute(
      sql`CREATE FUNCTION dependency_write_failure() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected storage failure'; END $$ LANGUAGE plpgsql`,
    );
    await db.orm.execute(
      sql`CREATE TRIGGER dependency_write_failure BEFORE INSERT ON task_block FOR EACH ROW EXECUTE FUNCTION dependency_write_failure()`,
    );
    await assert.rejects(refresh, (error: Error) =>
      /injected storage failure/.test(`${error.message} ${String(error.cause)}`),
    );
    assert.equal(await taskBlocks(), 0);
    assert.equal((await db.run((q) => readyItemsSteps(q, target))).generation, before);
    await db.orm.execute(sql`DROP TRIGGER dependency_write_failure ON task_block`);
    await db.orm.execute(sql`DROP FUNCTION dependency_write_failure()`);
    await refresh();
    observed(
      "Wrong workspaces deny and failed publication rolls back all snapshot rows",
      await db.run((q) => readyItemsSteps(q, target)),
    );
    const beforeBusy = (await db.run((q) => readyItemsSteps(q, target))).generation;
    const owner = await connect();
    let blocked!: Promise<void>;
    try {
      await owner.store.orm.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE task_block, item_dependency_snapshot IN EXCLUSIVE MODE`);
        blocked = refresh();
        await Bun.sleep(50);
        const held = await tx
          .select({ generation: pgSchema.itemDependencySnapshot.generation })
          .from(pgSchema.itemDependencySnapshot)
          .where(eq(pgSchema.itemDependencySnapshot.itemId, focus));
        assert.equal(held[0]?.generation, beforeBusy);
      });
    } finally {
      await owner.close();
    }
    await blocked;
    assert((await db.run((q) => readyItemsSteps(q, target))).generation > beforeBusy);
    observed(
      "A concurrent writer's lock holds publication until it commits, then the snapshot completes exactly",
      await db.run((q) => readyItemsSteps(q, target)),
    );
    const controller = new AbortController();
    const beforeAbort = (await db.run((q) => readyItemsSteps(q, target))).generation;
    await assert.rejects(
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: beforeAbort,
        tracker,
        signal: controller.signal,
        lifecycle: {
          async inspect(id, options) {
            const value = await lifecycle.inspect(id, options);
            controller.abort(new Error("Cancelled dependency refresh"));
            return value;
          },
        },
      }),
      /Cancelled dependency refresh/,
    );
    assert.equal((await db.run((q) => readyItemsSteps(q, target))).generation, beforeAbort);
    await assert.rejects(
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: beforeAbort,
        tracker,
        lifecycle: {
          async inspect(id, options) {
            return { ...(await lifecycle.inspect(id, options)), id: "wrong" };
          },
        },
      }),
      /another dependency issue/,
    );
    assert.equal((await db.run((q) => readyItemsSteps(q, target))).generation, beforeAbort);
    observed(
      "Cancellation and wrong issue identities cannot publish partial authoritative state",
      await db.run((q) => readyItemsSteps(q, target)),
    );
    const session =
      (values: { creatorId?: string | null; organizationId?: string; teamId?: string }) => (q: Q) =>
        q.orm
          .update(q.t.linearSession)
          .set(values)
          .where(eq(q.t.linearSession.sessionId, "session"));
    const issue = (from: string, to: string) => (q: Q) =>
      q.orm
        .update(q.t.workItem)
        .set({ linearIssueId: to })
        .where(eq(q.t.workItem.linearIssueId, from));
    for (const [edit, restore] of [
      [session({ creatorId: "replacement" }), session({ creatorId: null })],
      [session({ organizationId: "outside-org" }), session({ organizationId: "org" })],
      [session({ teamId: "other-team" }), session({ teamId: "team" })],
      [issue("c", "replacement"), issue("replacement", "c")],
    ]) {
      let changed = false;
      try {
        await assert.rejects(
          syncItemDependencies(db, {
            ...target,
            expectedGeneration: beforeAbort,
            lifecycle,
            tracker: {
              async listDeps(id) {
                const value = await tracker.listDeps(id);
                if (!changed) {
                  changed = true;
                  await change(edit!);
                }
                return value;
              },
            },
          }),
          /snapshot changed|ownership changed/,
        );
      } finally {
        await change(restore!);
      }
      assert.equal((await db.run((q) => readyItemsSteps(q, target))).generation, beforeAbort);
    }
    await assert.rejects(
      syncItemDependencies(db, {
        ...target,
        expectedGeneration: beforeAbort,
        lifecycle,
        tracker: {
          async listDeps(id) {
            const value = await tracker.listDeps(id);
            await change((q) =>
              q.orm
                .update(q.t.linearSession)
                .set({ generation: sql`${q.t.linearSession.generation}+1` })
                .where(eq(q.t.linearSession.sessionId, "session")),
            );
            return value;
          },
        },
      }),
      /snapshot changed/,
    );
    assert.equal((await db.run((q) => readyItemsSteps(q, target))).generation, beforeAbort);
    assert.deepEqual(await readyIds(), []);
    await refresh();
    observed(
      "Changed canonical session generations hold work until a fresh snapshot succeeds",
      await db.run((q) => readyItemsSteps(q, target)),
    );
  } finally {
    await postgres.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable evidence directory");
  const observations: unknown[] = [];
  try {
    await probeDependencySnapshots(root, (name, passed, observed) =>
      observations.push({ name, passed, observed }),
    );
  } finally {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  }
}
