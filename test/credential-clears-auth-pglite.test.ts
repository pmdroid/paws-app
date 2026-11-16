import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentCredentialSteps } from "../src/credentials";
import {
  bindAgentAccountSteps,
  createAgentAccountSteps,
  recordAccountObservationSteps,
} from "../src/db";
import { bindingReadinessSteps } from "../src/runner-placement";
import { tempStore } from "./pglite";
import { seed } from "./pglite-fixtures";
import { NOW, REPOSITORY, workspaceWithRunners } from "./runner-slot-fixture";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("a new credential clears the account's stale sign-in failures on every binding", async () => {
  const { db, close } = await tempStore();
  cleanup.push(close);
  const secrets = mkdtempSync(join(tmpdir(), "paws-credential-auth-"));
  cleanup.push(() => rmSync(secrets, { recursive: true, force: true }));
  const { pair, workspace, userId } = await workspaceWithRunners(db);
  const runnerId = await pair("auth-runner", 1, [REPOSITORY]);
  const account = await db.transaction((q) =>
    createAgentAccountSteps(q, {
      ownerUserId: userId,
      workspaceId: workspace.id,
      agent: "claude",
      label: "Ultra",
      now: NOW,
    }),
  );
  const binding = await db.transaction((q) =>
    bindAgentAccountSteps(q, {
      userId,
      workspaceId: workspace.id,
      accountId: account.id,
      runnerId,
      now: NOW,
    }),
  );
  await db.transaction((q) =>
    recordAccountObservationSteps(q, {
      bindingId: binding.id,
      source: "result",
      sourceId: "failed-run",
      observedAt: NOW + 1,
      now: NOW + 1,
      state: "auth_required",
    }),
  );
  const ready = (now: number) =>
    db.run((q) => bindingReadinessSteps(q, { bindingId: binding.id, now }));
  await seed(db, (q) => q.orm.update(q.t.runner).set({ lastSeenAt: NOW + 10 }));
  expect(await ready(NOW + 10)).toMatchObject({ ready: false, reason: "auth-required" });
  const written = await db.transaction((q) =>
    writeAgentCredentialSteps(q, secrets, {
      accountId: account.id,
      runnerId: null,
      version: 1,
      blob: "[]",
      now: NOW + 5,
    }),
  );
  expect(written).toBe("written");
  expect((await ready(NOW + 10)).ready).toBe(true);
});
