import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { asc, eq, like, or } from "drizzle-orm";
import type { LinearCommand } from "../src/core";
import {
  blockConversation,
  enqueueJob,
  getJob,
  getWorkItem,
  workspaceSessionIds,
  type Db,
} from "../src/db";
import {
  createExecutionControls,
  type ExecutionControlCaller,
  type ExecutionControlPort,
} from "../src/execution-controls";
import { createExecutionControlsFixturePg } from "./local/execution-controls";
import { seed } from "./pglite-fixtures";

function audits(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          userId: q.t.workspaceAccessAudit.userId,
          action: q.t.workspaceAccessAudit.action,
          subject: q.t.workspaceAccessAudit.subject,
        })
        .from(q.t.workspaceAccessAudit)
        .where(
          or(
            eq(q.t.workspaceAccessAudit.action, "access.denied"),
            like(q.t.workspaceAccessAudit.action, "execution.%"),
          ),
        )
        .orderBy(asc(q.t.workspaceAccessAudit.id)),
    ),
  );
}

async function withCore(
  run: (input: {
    db: Db;
    core: ReturnType<typeof createExecutionControls>["core"];
    caller: (userId: string) => Promise<ExecutionControlCaller>;
    interrupted: string[];
    commands: LinearCommand[];
  }) => Promise<void>,
  options: { port?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-core-"));
  const fixture = await createExecutionControlsFixturePg(root);
  const { db, orchestrator } = fixture;
  const interrupted: string[] = [];
  const commands: LinearCommand[] = [];
  const unsubscribe = orchestrator.bus.subscribe((command) => commands.push(command));
  const port: ExecutionControlPort = {
    pauseItem: (id, canAct, onCommitted) => orchestrator.pauseItem(id, canAct, onCommitted),
    resumeItem: (id, canAct, onCommitted) => orchestrator.resumeItem(id, canAct, onCommitted),
    async interruptItem(id) {
      interrupted.push(id);
    },
    clearStuckAgent: (id, canAct, onCommitted) =>
      orchestrator.clearStuckAgent(id, canAct, onCommitted),
  };
  const { core } = createExecutionControls({
    db,
    bus: orchestrator.bus,
    getPort: () => (options.port === false ? null : port),
  });
  const caller = async (userId: string): Promise<ExecutionControlCaller> => ({
    principal: {
      workspaceId: "workspace",
      userId,
      role: userId === "admin" ? "admin" : "member",
      authenticatedAt: Date.now(),
      teamIds: ["team"],
    },
    sessionIds: await workspaceSessionIds(db, "workspace", userId, "client"),
  });
  try {
    await run({ db, core, caller, interrupted, commands });
  } finally {
    unsubscribe();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("read for an item outside the caller's sessions offers nothing and audits nothing", () =>
  withCore(async ({ db, core, caller }) => {
    const view = await core.read(await caller("outside"), "controlled");
    assert.deepEqual(view, { itemId: "controlled", available: true, actions: [] });
    assert.deepEqual(await audits(db), []);
    assert.deepEqual((await core.read(await caller("member"), "controlled")).actions, [
      "stop",
      "pause",
    ]);
  }));

test("apply for an item outside the caller's sessions is denied and audited once", () =>
  withCore(async ({ db, core, caller }) => {
    assert.deepEqual(
      await core.apply(await caller("outside"), { itemId: "controlled", action: "pause" }),
      { status: "denied" },
    );
    assert.deepEqual(await audits(db), [
      { userId: "outside", action: "access.denied", subject: "execution-controls" },
    ]);
    assert.equal((await getWorkItem(db, "controlled"))!.state, "running");
  }));

test("apply pause on a running item is applied and audited", () =>
  withCore(async ({ db, core, caller }) => {
    assert.deepEqual(
      await core.apply(await caller("member"), { itemId: "controlled", action: "pause" }),
      { status: "applied", itemId: "controlled", action: "pause" },
    );
    assert.equal((await getWorkItem(db, "controlled"))!.state, "paused");
    assert.deepEqual(await audits(db), [
      { userId: "member", action: "execution.pause", subject: "controlled" },
    ]);
  }));

test("apply with a stale expected version changes nothing", () =>
  withCore(async ({ db, core, caller }) => {
    const before = (await getWorkItem(db, "controlled"))!;
    assert.deepEqual(
      await core.apply(await caller("member"), {
        itemId: "controlled",
        action: "pause",
        expectedVersion: before.version - 1,
      }),
      { status: "changed" },
    );
    assert.deepEqual(await getWorkItem(db, "controlled"), before);
    assert.deepEqual(await audits(db), []);
  }));

test("apply outside the allowed actions is unavailable even for an admin", () =>
  withCore(async ({ db, core, caller }) => {
    await blockConversation(db, "controlled", Date.now());
    const admin = await caller("admin");
    assert((await core.read(admin, "controlled")).actions.includes("clear_stuck_agent"));
    assert.deepEqual(
      await core.apply(admin, {
        itemId: "controlled",
        action: "clear_stuck_agent",
        allowed: ["pause", "resume", "stop"],
      }),
      { status: "unavailable" },
    );
    assert.deepEqual(await audits(db), []);
    assert.equal(
      (await core.apply(admin, { itemId: "controlled", action: "clear_stuck_agent" })).status,
      "applied",
    );
  }));

test("apply stop submits one stop command and interrupts the item", () =>
  withCore(async ({ db, core, caller, interrupted, commands }) => {
    assert.deepEqual(
      await core.apply(await caller("member"), { itemId: "controlled", action: "stop" }),
      { status: "applied", itemId: "controlled", action: "stop" },
    );
    assert.deepEqual(
      commands.map(({ type, source, itemId }) => ({ type, source, itemId })),
      [{ type: "stop", source: "dashboard", itemId: "controlled" }],
    );
    assert.deepEqual(interrupted, ["controlled"]);
    assert.equal((await getWorkItem(db, "controlled"))!.state, "cancelled");
  }));

test("retry refuses a bad target and a delivery from an earlier state of the item", () =>
  withCore(async ({ db, core, caller }) => {
    const member = await caller("member");
    assert.deepEqual(await core.retry(member, "job:x"), { status: "invalid_target" });
    const job = await enqueueJob(db, {
      queue: "test.unhandled",
      payload: { itemId: "controlled" },
      jobKey: "dead:controlled",
      runAt: Date.now() + 3_600_000,
    });
    await seed(db, (q) =>
      q.orm.update(q.t.job).set({ status: "dead", itemVersion: -1 }).where(eq(q.t.job.id, job)),
    );
    assert.deepEqual(await core.retry(member, `job:${job}`), { status: "stale_delivery" });
    assert.equal((await getJob(db, job))!.status, "dead");
    await seed(db, (q) =>
      q.orm.update(q.t.job).set({ itemVersion: null }).where(eq(q.t.job.id, job)),
    );
    assert.deepEqual(await core.retry(member, `job:${job}`), {
      status: "applied",
      itemId: "controlled",
      action: "retry",
    });
    assert.equal((await getJob(db, job))!.status, "pending");
    assert.deepEqual(await core.retry(member, `job:${job}`), { status: "denied" });
  }));

test("without a port, apply is not ready and read offers nothing", () =>
  withCore(
    async ({ db, core, caller }) => {
      const member = await caller("member");
      assert.deepEqual(await core.read(member, "controlled"), {
        itemId: "controlled",
        available: false,
        actions: [],
      });
      assert.deepEqual(await core.apply(member, { itemId: "controlled", action: "pause" }), {
        status: "not_ready",
      });
      assert.equal((await getWorkItem(db, "controlled"))!.state, "running");
    },
    { port: false },
  ));
