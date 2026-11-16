import { afterEach, expect, test } from "bun:test";
import {
  ACCOUNT_RESET_SLACK_MS,
  createAgentAccountSteps,
  providerUsageSteps,
  saveProviderUsageSteps,
} from "../src/db";
import { tempStore } from "./pglite";
import { seed } from "./pglite-fixtures";

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
