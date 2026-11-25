import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  createAgentAccount,
  getRunnerSteps,
  insertQueuedItem,
  issueVmByIdSteps,
  putVmProviderCheckSteps,
  listAgentBindingsSteps,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { recordIssueVmSteps } from "../src/issue-vm";
import { createRunnerControl, RunnerEnrollmentDenied } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { eligibleRunnersSteps } from "../src/runner-placement";
import type { RunnerCommand } from "../src/runner-protocol";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceTokenHash } from "../src/workspace";
import { seed, seedCredential } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-issue-vm-enroll-"));
  const { db, close } = await tempStore();
  cleanups.push(close, () => rmSync(root, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const userId = await putWorkspaceUser(db, {
    id: "me",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: "ws",
    organizationId: "org",
    name: "Test",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspaceRepository)
      .values({ workspaceId: workspace.id, repository: "fixture/repository", teamId: "team" }),
  );
  const repository = {
    owner: "fixture",
    repo: "repository",
    remoteUrl: "https://github.com/fixture/repository.git",
    baseSha: "a".repeat(40),
  };
  const items: Record<string, { itemId: string; runId: string }> = {};
  for (const name of ["mine", "other"]) {
    const item = await insertQueuedItem(db, { id: name, now, sessionKey: `session-${name}` });
    const { run } = await beginImplementRun(db, item.id, now);
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: `session-${name}`,
      teamId: "team",
      observedAtMs: now,
    });
    await bindLinearSessionTask(db, `session-${name}`, item.delegationId, { actorId: "owner" });
    await bindWorkItemRepository(db, item.id, repository);
    items[name] = { itemId: item.id, runId: run.id };
  }
  await db.run((q) =>
    recordIssueVmSteps(q, {
      id: "01M8VM0000000000000000000A",
      workspaceId: workspace.id,
      itemId: "mine",
      memberUserId: userId,
      provider: "boat",
      now,
    }),
  );
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    store: db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
    serverVersion: "2.3.4",
  });
  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  const command = (runnerId: string, name: string): Extract<RunnerCommand, { type: "run" }> => ({
    id: `work-${name}`,
    type: "run",
    runnerId,
    workspaceId: workspace.id,
    runId: items[name]!.runId,
    itemId: items[name]!.itemId,
    generation: 1,
    issuedAt: now,
    expiresAt: now + 600_000,
    repository,
    profile: { agent: "claude", model: null },
    prompt: "Implement the issue",
  });
  return {
    db,
    control,
    work,
    command,
    root,
    workspaceId: workspace.id,
    userId,
    vmId: "01M8VM0000000000000000000A",
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

test("an issue VM enrolls with its bootstrap token once and gets only its own issue's work", async () => {
  const f = await fixture();
  const account = await createAgentAccount(f.db, {
    ownerUserId: f.userId,
    workspaceId: f.workspaceId,
    agent: "claude",
    label: "mine",
    now: f.now(),
  });
  await seedCredential(f.db, account.id, "claude", f.now());
  const { token, expiresAt } = (await f.control.createIssueVmEnrollment(f.vmId))!;
  expect(expiresAt).toBe(f.now() + 10 * 60_000);
  const client = await createRunnerKey(join(f.root, "vm"));
  const enrolled = await f.control.enroll({ token, name: "vm", csr: client.csr });
  const runner = await f.db.run((q) => getRunnerSteps(q, enrolled.runnerId));
  expect(runner).toMatchObject({ status: "active", ownerUserId: f.userId });
  const row = await f.db.run((q) =>
    q.one(
      q.orm
        .select({ isolation: q.t.runner.isolation, issueVmId: q.t.runner.issueVmId })
        .from(q.t.runner)
        .where(eq(q.t.runner.id, enrolled.runnerId)),
    ),
  );
  expect(row).toEqual({ isolation: "issue_vm", issueVmId: f.vmId });
  expect((await f.db.run((q) => issueVmByIdSteps(q, f.vmId)))?.runnerId).toBe(enrolled.runnerId);
  expect(
    (await f.db.run((q) => listAgentBindingsSteps(q, f.workspaceId, account.id))).map(
      (binding) => binding.runnerId,
    ),
  ).toEqual([enrolled.runnerId]);

  const again = await createRunnerKey(join(f.root, "again"));
  await expect(f.control.enroll({ token, name: "vm", csr: again.csr })).rejects.toThrow(
    RunnerEnrollmentDenied,
  );
  expect(await f.control.createIssueVmEnrollment(f.vmId)).toBeNull();

  await seed(f.db, (q) =>
    q.orm
      .update(q.t.runner)
      .set({ lastSeenAt: f.now() })
      .where(eq(q.t.runner.id, enrolled.runnerId)),
  );
  const reasons = (itemId: string) =>
    f.db.run(function* (q) {
      const runners = yield* eligibleRunnersSteps(q, {
        workspaceId: f.workspaceId,
        teamId: "team",
        ownerUserId: f.userId,
        agent: "claude",
        purpose: "prepare",
        itemId,
        now: f.now(),
      });
      return runners.map((candidate) => candidate.reason);
    });
  expect(await reasons("mine")).toEqual(["own"]);
  expect(await reasons("other")).toEqual(["not-yours"]);

  await expect(f.work.assign(f.command(enrolled.runnerId, "other"))).rejects.toThrow(
    "Runner is not accepting this assignment.",
  );
  await f.work.assign(f.command(enrolled.runnerId, "mine"));
});

test("a Tailscale key whose machines wait for approval refuses the bootstrap token", async () => {
  const f = await fixture();
  await f.db.run((q) =>
    putVmProviderCheckSteps(q, {
      name: "tailscale",
      state: "limited",
      message: "",
      facts: [],
      checkedAt: f.now(),
      lastWorkingAt: f.now(),
    }),
  );
  await expect(f.control.createIssueVmEnrollment(f.vmId)).rejects.toThrow(
    "The Tailscale key's new machines wait for approval, so an issue VM can't enroll without a person.",
  );
});

test("an issue VM's bootstrap token expires after ten minutes", async () => {
  const f = await fixture();
  const { token } = (await f.control.createIssueVmEnrollment(f.vmId))!;
  f.advance(10 * 60_000);
  const client = await createRunnerKey(join(f.root, "late"));
  await expect(f.control.enroll({ token, name: "vm", csr: client.csr })).rejects.toThrow(
    RunnerEnrollmentDenied,
  );
  expect((await f.db.run((q) => issueVmByIdSteps(q, f.vmId)))?.runnerId).toBeNull();
});
