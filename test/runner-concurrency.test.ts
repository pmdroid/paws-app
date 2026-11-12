import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  insertRun,
  putWorkspaceUser,
  runnerHasCapacity,
  syncWorkspaceMember,
} from "../src/db";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const roots: string[] = [];
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Listed = {
  slots: { used: number; total: number };
  concurrency: { desired: number | null; applied: number; ceiling: number | null } | null;
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-concurrency-"));
  roots.push(root);
  const { db, close } = await tempStore();
  open.push(close);
  const now = 1_800_000_000_000;
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = await issueWorkspaceBootstrap(db, "fixture-host", now);
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-host",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal = (id: string, role: WorkspacePrincipal["role"]): WorkspacePrincipal => ({
    workspaceId: workspace.id,
    userId: id,
    role,
    authenticatedAt: now,
    teamIds: [],
  });
  const admin = principal(userId, "admin");
  const memberId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "member",
    name: "member",
    email: "member@example.invalid",
  });
  await syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: memberId,
    role: "member",
    active: true,
    teamIds: [],
    now,
  });
  const member = principal(memberId, "member");
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    store: db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
    serverVersion: "2.3.4",
  });
  const client = await createRunnerKey(join(root, "client"));
  const pending = { name: "Host VM", csr: client.csr };
  const { runnerId } = await control.enroll({
    ...pending,
    token: (await control.createEnrollment(admin, pending)).token,
  });
  await seed(db, (q) =>
    q.orm.update(q.t.runner).set({ status: "active" }).where(eq(q.t.runner.id, runnerId)),
  );
  const work = createRunnerWorkHttp(
    createRunnerWork({
      store: db,
      keyId: "fixture",
      privateKey: generateKeyPairSync("ed25519").privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: () => now,
    }),
  );
  const browser = createRunnerHttp(control);
  return {
    db,
    runnerId,
    workspaceId: workspace.id,
    admin,
    member,
    now,
    async heartbeat(body: unknown) {
      const response = (await work(
        new Request("https://runner.invalid/v1/heartbeat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        runnerId,
      ))!;
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    },
    async list(as = admin) {
      const response = await browser.browser(
        new Request("https://paws.invalid/api/runners"),
        as,
        [],
      );
      return ((await response!.json()) as { runners: Listed[] }).runners[0]!;
    },
    async set(concurrency: unknown, as = admin) {
      const response = (await browser.browser(
        new Request(`https://paws.invalid/api/runners/${runnerId}/concurrency`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ concurrency }),
        }),
        as,
        [],
      ))!;
      return { status: response.status, body: (await response.json()) as { error?: string } };
    },
  };
}

test("the heartbeat reply carries the chosen concurrency only to runners that report a ceiling", async () => {
  const runner = await fixture();
  const reply = await runner.heartbeat({ capacity: 4, runnerVersion: "0.1.75" });
  expect(reply).toEqual({ leases: [], fenced: [] });
  expect((await runner.list()).concurrency).toEqual({ desired: null, applied: 4, ceiling: null });
  const old = await runner.set(2);
  expect(old.status).toBe(400);
  expect(old.body.error).toContain("Update this runner");

  expect(await runner.heartbeat({ capacity: 4, ceiling: 4 })).toEqual({
    leases: [],
    fenced: [],
    concurrency: 4,
  });
  expect(await runner.list()).toMatchObject({
    slots: { used: 0, total: 4 },
    concurrency: { desired: null, applied: 4, ceiling: 4 },
  });
});

test("admins change concurrency within one heartbeat and cannot exceed the ceiling", async () => {
  const runner = await fixture();
  await runner.heartbeat({ capacity: 4, ceiling: 4 });

  const above = await runner.set(5);
  expect(above.status).toBe(400);
  expect(above.body.error).toBe("Concurrency must be from 1 to 4, the limit set on the host.");
  expect((await runner.set(0)).status).toBe(403);

  expect((await runner.set(2)).status).toBe(200);
  expect((await runner.list()).slots.total).toBe(2);
  expect((await runner.heartbeat({ capacity: 4, ceiling: 4 })).concurrency).toBe(2);
  await runner.heartbeat({ capacity: 2, ceiling: 4 });
  expect((await runner.list()).concurrency).toEqual({ desired: 2, applied: 2, ceiling: 4 });

  expect((await runner.set(3)).status).toBe(200);
  expect((await runner.list()).slots.total).toBe(2);
  expect((await runner.heartbeat({ capacity: 2, ceiling: 4 })).concurrency).toBe(3);
  await runner.heartbeat({ capacity: 3, ceiling: 4 });
  expect((await runner.list()).slots.total).toBe(3);

  // A lowered host ceiling caps the stored value without editing it.
  expect((await runner.heartbeat({ capacity: 2, ceiling: 2 })).concurrency).toBe(2);
  expect(
    await runner.db.run((q) =>
      q.all(
        q.orm
          .select({ action: q.t.workspaceAccessAudit.action })
          .from(q.t.workspaceAccessAudit)
          .where(eq(q.t.workspaceAccessAudit.action, "runner.concurrency")),
      ),
    ),
  ).toHaveLength(2);
});

test("members see concurrency but cannot change it", async () => {
  const runner = await fixture();
  await runner.heartbeat({ capacity: 3, ceiling: 3 });
  expect((await runner.set(1, runner.member)).status).toBe(403);
  expect((await runner.list(runner.member)).concurrency).toEqual({
    desired: null,
    applied: 3,
    ceiling: 3,
  });
});

test("lowering concurrency below running work holds back new placement", async () => {
  const runner = await fixture();
  await runner.heartbeat({ capacity: 3, ceiling: 3 });
  for (const index of [0, 1]) {
    await seed(runner.db, (q) =>
      q.orm.insert(q.t.workItem).values({
        id: `item-${index}`,
        delegationId: `epic-${index}`,
        linearIssueId: `issue-${index}`,
        linearIdentifier: `ENG-${index}`,
        title: "Task",
        state: "running",
        branchName: `paws/eng-${index}`,
        position: 0,
        createdAt: runner.now,
      }),
    );
    const run = await insertRun(runner.db, {
      itemId: `item-${index}`,
      now: runner.now,
      status: "active",
    });
    await seed(runner.db, (q) =>
      q.orm.insert(q.t.runnerWork).values({
        runId: run.id,
        runnerId: runner.runnerId,
        workspaceId: runner.workspaceId,
        generation: 1,
        runnerFence: 0,
        commandId: `cmd-${index}`,
        leaseUntil: runner.now + 60_000,
      }),
    );
  }
  expect(await runnerHasCapacity(runner.db, runner.runnerId, runner.now)).toBe(true);
  expect((await runner.set(1)).status).toBe(200);
  expect(await runnerHasCapacity(runner.db, runner.runnerId, runner.now)).toBe(false);
  expect((await runner.list()).slots).toEqual({ used: 2, total: 1 });
  expect(
    await runner.db.run((q) =>
      q.one(
        q.orm
          .select({ open: count() })
          .from(q.t.runnerWork)
          .where(and(eq(q.t.runnerWork.runnerId, runner.runnerId), isNull(q.t.runnerWork.endedAt))),
      ),
    ),
  ).toEqual({ open: 2 });
});

test("the heartbeat reports the conversation lane beside the work slots", async () => {
  const runner = await fixture();
  await runner.heartbeat({ capacity: 4, ceiling: 4, conversationConcurrency: 2 });
  expect(await runner.list()).toMatchObject({
    slots: { used: 0, total: 4 },
    conversations: { used: 0, total: 2 },
  });
  await runner.heartbeat({ capacity: 4, ceiling: 4 });
  expect(await runner.list()).toMatchObject({ conversations: null });
});
