import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bindLinearSessionTask,
  migrate,
  openDatabase,
  recordLinearInstallation,
  saveTaskMode,
} from "../../src/db";
import { intakeDelegatedIssue, readyItems, syncEpicDependencies } from "../../src/intake";
import { createFakeTracker, createFakeLinearIssueLifecycle } from "../../src/linear";

export async function probeDependencySnapshots(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
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
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
    assert(intake.ok);
    const target = { epicId: intake.epic.id, workspaceId: "workspace" };
    const ids = new Map(intake.items.map((item) => [item.linearIssueId, item.id]));
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    db.run("INSERT INTO workspace VALUES('other','outside-org','Other',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.epic.id, { actorId: "owner" });
    saveTaskMode(db, ids.get("a")!, "code");
    const refresh = () =>
      syncEpicDependencies(db, {
        ...target,
        expectedGeneration: readyItems(db, target).generation,
        tracker,
        lifecycle,
      });
    const edge = (blockerLinearIssueId: string, blockedLinearIssueId: string) => ({
      blockerLinearIssueId,
      blockedLinearIssueId,
    });
    const rowCount = (table: string) =>
      (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const observed = (name: string, value: unknown) => observe(name, true, value);
    const addedSchema = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE name IN ('epic_dependency_snapshot','external_dep','external_dep_blocker','work_item_block','epic_execution_control') ORDER BY name",
      )
      .all();
    assert.deepEqual(
      addedSchema.map((row) => row.name),
      ["epic_dependency_snapshot"],
    );
    assert(db.query("SELECT 1 FROM schema_migration WHERE id='039_epic_dependencies'").get());
    assert.deepEqual(readyItems(db, target).readyItemIds, []);
    observed("Uninitialized snapshots hold every queued item", {
      addedSchema,
      readiness: readyItems(db, target),
    });
    tracker.deps.set("parent", [edge("a", "b"), edge("outside", "b")]);
    tracker.deps.set("a", [edge("a", "b")]);
    await refresh();
    assert.equal(rowCount("task_block"), 2);
    assert(!readyItems(db, target).readyItemIds.includes(ids.get("b")!));
    observed(
      "Complete snapshots persist deduplicated internal and external edges",
      readyItems(db, target),
    );
    const cases = [
      ["queued", "code", "completed", false],
      ["running", "code", "completed", false],
      ["verifying", "code", "completed", false],
      ["completed", "code", "completed", false],
      ["cancelled", "code", "completed", false],
      ["merged", "code", "started", true],
      ["merged", "code", "canceled", false],
      ["manual", "code", "completed", true],
      ["manual", "code", "canceled", false],
      ["manual", "code", "started", false],
      ["completed", "answer", "started", true],
      ["completed", "answer", "canceled", false],
      ["completed", "artifact", "started", true],
      ["completed", "artifact", "canceled", false],
    ] as const;
    for (const [state, mode, linearState, expected] of cases) {
      db.run("UPDATE work_item SET state=? WHERE id=?", [state, ids.get("a")!]);
      db.run("UPDATE work_item_task SET mode=? WHERE item_id=?", [mode, ids.get("a")!]);
      lifecycle.issue.stateType = linearState;
      await refresh();
      assert.equal(readyItems(db, target).readyItemIds.includes(ids.get("b")!), expected);
    }
    observed(
      "Readiness distinguishes merged code, delivered tasks, manual completion and cancellation",
      cases,
    );
    db.run("UPDATE work_item SET state='merged',cancel_requested=1 WHERE id=?", [ids.get("a")!]);
    assert(!readyItems(db, target).readyItemIds.includes(ids.get("b")!));
    db.run("UPDATE work_item SET cancel_requested=0 WHERE id=?", [ids.get("a")!]);
    lifecycle.issue.stateType = "started";
    for (const state of ["started", "canceled", "Completed", "completed ", "completed"]) {
      lifecycle.issues.get("outside")!.stateType = state;
      await refresh();
      assert.equal(
        readyItems(db, target).readyItemIds.includes(ids.get("b")!),
        state === "completed",
      );
    }
    observed(
      "Cancellation flags and non-completed external states never satisfy blockers",
      readyItems(db, target),
    );
    tracker.deps.clear();
    tracker.deps.set("parent", [edge("a", "b"), edge("b", "a"), edge("b", "c")]);
    db.run("UPDATE work_item SET state='queued' WHERE epic_id=?", [target.epicId]);
    await refresh();
    assert.deepEqual(readyItems(db, target).readyItemIds, [ids.get("free")!]);
    assert.deepEqual(
      new Set(readyItems(db, target).cycleHeldItemIds),
      new Set(["a", "b", "c"].map((id) => ids.get(id)!)),
    );
    observed(
      "Cycles and descendants hold while unrelated work remains ready",
      readyItems(db, target),
    );
    const generation = readyItems(db, target).generation;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const late = syncEpicDependencies(db, {
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
    const concurrent = openDatabase(join(root, "paws.sqlite"));
    concurrent.run("BEGIN IMMEDIATE");
    concurrent.run("ROLLBACK");
    concurrent.close();
    tracker.deps.clear();
    await refresh();
    release();
    await assert.rejects(late, /snapshot changed/);
    assert.equal(rowCount("task_block"), 0);
    assert.equal(readyItems(db, target).readyItemIds.length, 4);
    await assert.rejects(
      syncEpicDependencies(db, { ...target, expectedGeneration: generation, tracker, lifecycle }),
      /snapshot changed/,
    );
    observed(
      "Newer snapshots remove edges and reject delayed older publications",
      readyItems(db, target),
    );
    assert.throws(() => readyItems(db, { ...target, workspaceId: "other" }), /ownership changed/);
    const before = readyItems(db, target).generation;
    tracker.deps.set("parent", [edge("outside", "b")]);
    db.run(
      "CREATE TRIGGER dependency_write_failure BEFORE INSERT ON task_block BEGIN SELECT RAISE(ABORT,'injected storage failure'); END",
    );
    await assert.rejects(refresh, /injected storage failure/);
    assert.equal(rowCount("task_block"), 0);
    assert.equal(readyItems(db, target).generation, before);
    db.run("DROP TRIGGER dependency_write_failure");
    await refresh();
    observed(
      "Wrong workspaces deny and failed publication rolls back all snapshot rows",
      readyItems(db, target),
    );
    const owner = openDatabase(join(root, "paws.sqlite"));
    owner.run("BEGIN IMMEDIATE");
    db.run("PRAGMA busy_timeout=0");
    const beforeBusy = readyItems(db, target).generation;
    try {
      await assert.rejects(refresh, /locked/);
      assert.equal(readyItems(db, target).generation, beforeBusy);
    } finally {
      owner.run("ROLLBACK");
      owner.close();
    }
    await refresh();
    observed(
      "A real SQLite writer conflict preserves the last complete snapshot and repairs exactly",
      readyItems(db, target),
    );
    const controller = new AbortController();
    const beforeAbort = readyItems(db, target).generation;
    await assert.rejects(
      syncEpicDependencies(db, {
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
    assert.equal(readyItems(db, target).generation, beforeAbort);
    await assert.rejects(
      syncEpicDependencies(db, {
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
    assert.equal(readyItems(db, target).generation, beforeAbort);
    observed(
      "Cancellation and wrong issue identities cannot publish partial authoritative state",
      readyItems(db, target),
    );
    for (const [change, restore] of [
      [
        "UPDATE linear_session_task SET owner_actor_id='replacement'",
        "UPDATE linear_session_task SET owner_actor_id='owner'",
      ],
      [
        "UPDATE linear_session SET organization_id='outside-org'",
        "UPDATE linear_session SET organization_id='org'",
      ],
      [
        "UPDATE linear_session SET team_id='other-team'",
        "UPDATE linear_session SET team_id='team'",
      ],
      [
        "UPDATE work_item SET linear_issue_id='replacement' WHERE linear_issue_id='c'",
        "UPDATE work_item SET linear_issue_id='c' WHERE linear_issue_id='replacement'",
      ],
    ] as const) {
      let changed = false;
      try {
        await assert.rejects(
          syncEpicDependencies(db, {
            ...target,
            expectedGeneration: beforeAbort,
            lifecycle,
            tracker: {
              async listDeps(id) {
                const value = await tracker.listDeps(id);
                if (!changed) {
                  changed = true;
                  db.run(change);
                }
                return value;
              },
            },
          }),
          /snapshot changed|ownership changed/,
        );
      } finally {
        db.run(restore);
      }
      assert.equal(readyItems(db, target).generation, beforeAbort);
    }
    await assert.rejects(
      syncEpicDependencies(db, {
        ...target,
        expectedGeneration: beforeAbort,
        lifecycle,
        tracker: {
          async listDeps(id) {
            const value = await tracker.listDeps(id);
            db.run("UPDATE linear_session SET generation=generation+1 WHERE session_id='session'");
            return value;
          },
        },
      }),
      /snapshot changed/,
    );
    assert.equal(readyItems(db, target).generation, beforeAbort);
    assert.deepEqual(readyItems(db, target).readyItemIds, []);
    await refresh();
    observed(
      "Changed canonical session generations hold work until a fresh snapshot succeeds",
      readyItems(db, target),
    );
  } finally {
    db.close();
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
