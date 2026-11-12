import assert from "node:assert/strict";
import { test } from "bun:test";
import { eq } from "drizzle-orm";
import { recordLinearInstallation, saveTaskMode, type Db } from "../src/db";
import { createAdmission } from "../src/scheduler";
import { seed } from "./dialects";
import { confirmFakeMergePg, joinFakeWorkspacePg, workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

function item(
  db: Db,
  input: { id: string; delegationId?: string; state?: string; position?: number; session?: string },
) {
  return seed(db, (q) =>
    q.orm.insert(q.t.workItem).values({
      id: input.id,
      delegationId: input.delegationId ?? "delegation",
      linearIssueId: `issue-${input.id}`,
      linearIdentifier: input.id,
      title: input.id,
      state: input.state ?? "queued",
      branchName: `paws/${input.id}`,
      position: input.position ?? 0,
      createdAt: 0,
      sessionKey: input.session ?? null,
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

function setState(db: Db, id: string, state: string) {
  return seed(db, (q) => q.orm.update(q.t.workItem).set({ state }).where(eq(q.t.workItem.id, id)));
}

test("an Item starts once its blocker in the delegation merged", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, { id: "blocker", state: "running" });
    await item(db, { id: "blocked", position: 1 });
    await block(db, "blocker", "blocked");
    const admission = workspaceAdmission(db);
    assert.deepEqual(await admission.canStart("blocked"), { ok: false, held: "blocked" });
    await setState(db, "blocker", "merged");
    assert.deepEqual(await admission.canStart("blocked"), { ok: false, held: "blocked" });
    await confirmFakeMergePg(db, "blocker");
    assert.deepEqual(await admission.canStart("blocked"), { ok: true });
  } finally {
    await close();
  }
});

test("a completed blocker satisfies the Block only for answer and artifact work", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, { id: "blocker", state: "completed" });
    await item(db, { id: "blocked", position: 1 });
    await block(db, "blocker", "blocked");
    const admission = workspaceAdmission(db);
    assert.deepEqual(await admission.canStart("blocked"), { ok: false, held: "blocked" });
    await saveTaskMode(db, "blocker", "answer");
    assert.deepEqual(await admission.canStart("blocked"), { ok: true });
  } finally {
    await close();
  }
});

test("a merge waits for an unmerged blocker and passes once it merged", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, { id: "blocker", state: "verifying" });
    await item(db, { id: "blocked", state: "merge_queue", position: 1 });
    await block(db, "blocker", "blocked");
    const admission = workspaceAdmission(db);
    assert.deepEqual(await admission.canMerge("blocked"), { ok: false, held: "blocked" });
    await setState(db, "blocker", "merged");
    await confirmFakeMergePg(db, "blocker");
    assert.deepEqual(await admission.canMerge("blocked"), { ok: true });
  } finally {
    await close();
  }
});

test("project authority holds start and merge before readiness is read", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, { id: "held", state: "merge_queue" });
    const admission = workspaceAdmission(db, { authority: (id) => id !== "delegation" });
    assert.deepEqual(await admission.canStart("held"), { ok: false, held: "project" });
    assert.deepEqual(await admission.canMerge("held"), { ok: false, held: "project" });
    assert.equal(await admission.canDispatchDelegation("delegation"), false);
    assert.equal(await admission.canDispatchDelegation("other"), true);
  } finally {
    await close();
  }
});

test("missing and cancel requested Items are held", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, { id: "stopping" });
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ cancelRequested: 1 }).where(eq(q.t.workItem.id, "stopping")),
    );
    const admission = workspaceAdmission(db);
    assert.deepEqual(await admission.canStart("absent"), { ok: false, held: "missing" });
    assert.deepEqual(await admission.canStart("stopping"), { ok: false, held: "cancelled" });
    assert.deepEqual(await admission.canMerge("stopping"), { ok: false, held: "cancelled" });
  } finally {
    await close();
  }
});

test("admission holds a delegation until its snapshots exist and changes are applied", async () => {
  const { db, close } = await tempStore();
  try {
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
    );
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 0,
    });
    await item(db, { id: "work", session: "session" });
    const admission = createAdmission({ db });
    assert.deepEqual(await admission.canStart("work"), { ok: false, held: "snapshot" });
    assert.equal(await admission.canDispatchDelegation("delegation"), false);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.itemReconciliationRequest)
        .values({ itemId: "work", workspaceId: "workspace", token: "token" }),
    );
    assert.deepEqual(await admission.canStart("work"), { ok: false, held: "reconciling" });
    await seed(db, (q) => q.orm.delete(q.t.itemReconciliationRequest));
    await joinFakeWorkspacePg(db, "delegation");
    assert.equal(await admission.canDispatchDelegation("delegation"), true);
    assert.deepEqual(await admission.canStart("work"), { ok: true });
  } finally {
    await close();
  }
});
