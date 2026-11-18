import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createAccountManagement } from "../src/account-management";
import { createAccountUsage } from "../src/agent-auth";
import { JOB_KIND } from "../src/core";
import { writeAgentCredentialSteps } from "../src/credentials";
import {
  ACCOUNT_RESET_SLACK_MS,
  bindAgentAccountSteps,
  createAgentAccountSteps,
  enqueueJobSteps,
  onJobReady,
  providerUsageSteps,
  saveProviderUsageSteps,
  type Db,
} from "../src/db";
import { bindingReadinessSteps } from "../src/runner-placement";
import { tempStore } from "./pglite";
import { seed, seedCredential } from "./pglite-fixtures";
import { REPOSITORY, workspaceWithRunners } from "./runner-slot-fixture";

const NOW = 1_800_000_000_000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function account(extraUsage: boolean) {
  const { db, close } = await tempStore();
  cleanup.push(close);
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "workspace", linearOrganizationId: "org", name: "W", createdAt: NOW }),
    (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({ id: "user", linearUserId: "user", name: "U", email: "u@test.invalid" }),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values({
        workspaceId: "workspace",
        userId: "user",
        role: "owner",
        source: "manual",
        active: 1,
        checkedAt: NOW,
      }),
  );
  const row = await db.transaction((q) =>
    createAgentAccountSteps(q, {
      ownerUserId: "user",
      workspaceId: "workspace",
      agent: "claude",
      label: "Main",
      now: NOW,
    }),
  );
  return { db, row: { ...row, workspaceId: "workspace", agent: "claude", extraUsage } };
}

test("a provider reading at 100% puts the account in quota cooldown until the reset", async () => {
  const { db, row } = await account(false);
  const resetsAt = NOW + 3_600_000;
  await db.transaction((q) =>
    saveProviderUsageSteps(q, row, [{ window: "Weekly", usedPercent: 100, resetsAt }], NOW),
  );
  const saved = await db.run((q) => providerUsageSteps(q, row.id));
  expect(saved?.state).toBe("exhausted");
  expect(saved?.resetsAt).toBe(resetsAt);
  expect(saved?.nextCheckAt).toBe(resetsAt + ACCOUNT_RESET_SLACK_MS);
});

test("an account on extra usage stays available when a window is spent", async () => {
  const { db, row } = await account(true);
  await db.transaction((q) =>
    saveProviderUsageSteps(
      q,
      row,
      [{ window: "Weekly", usedPercent: 100, resetsAt: NOW + 3_600_000 }],
      NOW,
    ),
  );
  expect((await db.run((q) => providerUsageSteps(q, row.id)))?.state).toBe("ok");
});

test("placement holds a spent account until the reset, then offers it again", async () => {
  const { db, close } = await tempStore();
  cleanup.push(close);
  const { pair, workspace, userId } = await workspaceWithRunners(db);
  const runnerId = await pair("usage-runner", 1, [REPOSITORY]);
  const spent = await db.transaction((q) =>
    createAgentAccountSteps(q, {
      ownerUserId: userId,
      workspaceId: workspace.id,
      agent: "codex",
      label: "Spent",
      now: NOW,
    }),
  );
  await seedCredential(db, spent.id, "codex", NOW);
  const binding = await db.transaction((q) =>
    bindAgentAccountSteps(q, {
      userId,
      workspaceId: workspace.id,
      accountId: spent.id,
      runnerId,
      now: NOW,
    }),
  );
  const resetsAt = NOW + 3_600_000;
  await db.transaction((q) =>
    saveProviderUsageSteps(q, spent, [{ window: "Weekly", usedPercent: 100, resetsAt }], NOW),
  );
  const ready = (now: number) =>
    db.run((q) => bindingReadinessSteps(q, { bindingId: binding.id, now }));
  await seed(db, (q) =>
    q.orm.update(q.t.runner).set({ lastSeenAt: resetsAt + ACCOUNT_RESET_SLACK_MS + 1 }),
  );
  expect(await ready(NOW + 1)).toEqual({
    ready: false,
    reason: "exhausted",
    until: resetsAt + ACCOUNT_RESET_SLACK_MS,
  });
  expect((await ready(resetsAt + ACCOUNT_RESET_SLACK_MS + 1)).ready).toBe(true);
});

async function spentAccount() {
  const { db, close } = await tempStore();
  const secretsDir = mkdtempSync(join(tmpdir(), "extra-usage-"));
  cleanup.push(close, () => rmSync(secretsDir, { recursive: true, force: true }));
  const { pair, workspace, userId } = await workspaceWithRunners(db);
  const runnerId = await pair("usage-runner", 1, [REPOSITORY]);
  const spent = await db.transaction((q) =>
    createAgentAccountSteps(q, {
      ownerUserId: userId,
      workspaceId: workspace.id,
      agent: "claude",
      label: "Spent",
      now: NOW,
    }),
  );
  await db.transaction((q) =>
    writeAgentCredentialSteps(q, secretsDir, {
      accountId: spent.id,
      runnerId: null,
      version: 1,
      blob: JSON.stringify([{ path: ".claude/.credentials.json", data: "e30=" }]),
      now: NOW,
    }),
  );
  const binding = await db.transaction((q) =>
    bindAgentAccountSteps(q, {
      userId,
      workspaceId: workspace.id,
      accountId: spent.id,
      runnerId,
      now: NOW,
    }),
  );
  const resetsAt = NOW + 3_600_000;
  const limits = [{ window: "Weekly", usedPercent: 100, resetsAt }];
  await db.transaction((q) => saveProviderUsageSteps(q, spent, limits, NOW));
  await seed(db, (q) => q.orm.update(q.t.runner).set({ lastSeenAt: NOW + 1_000 }));
  const held = await db.transaction((q) =>
    enqueueJobSteps(q, {
      queue: JOB_KIND.start,
      payload: { itemId: "held", capacityWait: { since: NOW, attempt: 1, runnerIds: [] } },
      runAt: resetsAt + ACCOUNT_RESET_SLACK_MS,
      now: NOW,
    }),
  );
  const at = NOW + 500;
  const api = createAccountManagement({ store: db, secretsDir, now: () => at });
  const extraUsage = (on: boolean) =>
    api(
      new Request(`http://127.0.0.1:8787/api/runners/agent-accounts/${spent.id}/extra-usage`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extraUsage: on }),
      }),
      { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: NOW, teamIds: [] },
    );
  return { db, secretsDir, spent, binding, limits, held, at, extraUsage };
}

const jobs = (db: Db, queue: string) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({ id: q.t.job.id, runAt: q.t.job.runAt, payload: q.t.job.payload })
        .from(q.t.job)
        .where(and(eq(q.t.job.queue, queue), eq(q.t.job.status, "pending"))),
    ),
  );

test("turning extra usage on re-checks a spent account at once and places the held item", async () => {
  const { db, secretsDir, spent, binding, limits, held, at, extraUsage } = await spentAccount();
  let woken = 0;
  const stop = onJobReady((store) => store === db && woken++);
  cleanup.push(stop);
  expect(
    (await db.run((q) => bindingReadinessSteps(q, { bindingId: binding.id, now: at }))).ready,
  ).toBe(false);
  expect((await extraUsage(true))?.status).toBe(200);
  expect(woken).toBeGreaterThan(0);
  expect((await db.run((q) => providerUsageSteps(q, spent.id)))?.nextCheckAt).toBe(at);
  const usageJobs = await jobs(db, "agent.usage.after-run");
  expect(usageJobs).toHaveLength(1);
  expect(usageJobs[0]!.runAt).toBe(at);
  let reads = 0;
  await createAccountUsage({
    store: db,
    secretsDir,
    now: () => at,
    readUsage: async () => {
      reads++;
      return limits;
    },
  }).tick((usageJobs[0]!.payload as { accountId: string }).accountId);
  expect(reads).toBe(1);
  expect(
    await db.run((q) => bindingReadinessSteps(q, { bindingId: binding.id, now: at + 1 })),
  ).toMatchObject({ ready: true });
  expect((await jobs(db, JOB_KIND.start)).find((job) => job.id === held)?.runAt).toBe(at);
});

test("turning extra usage off leaves the quota cooldown to the next scheduled reading", async () => {
  const { db, spent, held, extraUsage } = await spentAccount();
  const before = await db.run((q) => providerUsageSteps(q, spent.id));
  expect((await extraUsage(false))?.status).toBe(200);
  expect(await db.run((q) => providerUsageSteps(q, spent.id))).toEqual(before);
  expect(await jobs(db, "agent.usage.after-run")).toEqual([]);
  expect((await jobs(db, JOB_KIND.start)).find((job) => job.id === held)?.runAt).toBe(
    before!.nextCheckAt!,
  );
});
