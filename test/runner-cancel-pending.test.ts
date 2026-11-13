import { expect, test } from "bun:test";
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
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
  releaseRunCapacity,
  runnerCancelPending,
  runnerOccupancy,
  runnerSlotFree,
  openPawsStore,
  runnerSlotsHeldBetweenCommands,
  type Db,
} from "../src/db";
import { createRunnerWork, createRunnerWorkHttp, RunnerTeardownPending } from "../src/runner-work";
import { CONFIRMED_TEARDOWN_RUNNER_VERSION, type RunnerCommand } from "../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceTokenHash } from "../src/workspace";
import { jsonValue, seed, withoutForeignKeys } from "./dialects";
import { copyMigratedPglite, tempStore } from "./pglite";

async function runnerWork(db: Db) {
  const [row] = await db.run((q) =>
    q.all(
      q.orm
        .select({
          endedAt: q.t.runnerWork.endedAt,
          confirmed: q.t.runnerWork.teardownConfirmedAt,
        })
        .from(q.t.runnerWork),
    ),
  );
  return row!;
}

test("real cancellation retains ownership through receipt, expiry, live reports and server reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-cancel-pending-"));
  const dir = join(root, "pglite");
  await copyMigratedPglite(dir);
  let store = await openPawsStore({ url: null, pgliteDir: dir });
  let db = store.store;
  let now = Date.now();
  const keys = generateKeyPairSync("ed25519");
  const controller = () =>
    createRunnerWork({
      store: db,
      keyId: "fixture",
      privateKey: keys.privateKey,
      eventKey: Buffer.alloc(32, 7),
      now: () => now,
    });
  try {
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
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id: "box",
          workspaceId: workspace.id,
          ownerUserId: userId,
          name: "box",
          status: "active",
          createdAt: now,
          lastSeenAt: now,
        }),
      (q) =>
        q.orm
          .insert(q.t.workspaceRepository)
          .values({ workspaceId: workspace.id, repository: "fixture/repository", teamId: "team" }),
    );
    const item = await insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
    const { run } = await beginImplementRun(db, item.id, now);
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: now,
    });
    await bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    };
    await bindWorkItemRepository(db, item.id, repository);
    const command: Extract<RunnerCommand, { type: "run" }> = {
      id: "work-1",
      type: "run",
      runnerId: "box",
      workspaceId: workspace.id,
      runId: run.id,
      itemId: item.id,
      generation: 1,
      issuedAt: now,
      expiresAt: now + 600_000,
      repository,
      profile: { agent: "claude", model: null },
      prompt: "Implement the issue",
    };
    let work = controller();
    await work.assign(command);
    expect((await runnerOccupancy(db, "box", now)).occupied).toBe(1);
    await work.acknowledge("box", command.id);
    await work.heartbeat(
      "box",
      1,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      [{ runId: run.id, generation: 1 }],
      undefined,
      [],
    );
    now++;
    const cancel = {
      id: "cancel-1",
      type: "cancel" as const,
      runnerId: "box",
      workspaceId: workspace.id,
      runId: run.id,
      generation: 1,
      issuedAt: now,
      expiresAt: now + 60_000,
    };
    await work.enqueue(cancel);
    expect((await runnerWork(db)).endedAt).toBe(now);
    expect((await runnerOccupancy(db, "box", now)).occupied).toBe(1);
    expect(await runnerSlotsHeldBetweenCommands(db, "box", now)).toBe(0);
    await work.acknowledge("box", cancel.id);
    expect(await runnerCancelPending(db, "box")).toBe(true);
    now = cancel.expiresAt + 1;
    const report = [{ runId: run.id, generation: 1 }];
    const host = { runnerVersion: CONFIRMED_TEARDOWN_RUNNER_VERSION.join(".") };
    await work.heartbeat("box", 1, host, undefined, undefined, undefined, undefined, report);
    expect(await runnerSlotFree(db, ["box"], now, run.id)).toBe(false);
    await store.close();
    store = await openPawsStore({ url: null, pgliteDir: dir });
    db = store.store;
    work = controller();
    expect(await runnerCancelPending(db, "box")).toBe(true);
    const next = {
      ...command,
      id: "work-2",
      generation: 2,
      issuedAt: now,
      expiresAt: now + 600_000,
    };
    await expect(work.assign(next)).rejects.toThrow(RunnerTeardownPending);
    // Absence also cannot erase the durable cleanup obligation.
    await work.heartbeat("box", 1, host, undefined, undefined, undefined, undefined, []);
    expect((await runnerOccupancy(db, "box", now)).occupied).toBe(1);
    const termination = { runId: run.id, generation: 1, commandId: command.id };
    const http = createRunnerWorkHttp(work);
    const response = await http(
      new Request("https://paws.invalid/v1/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...host, live: [], terminated: [termination] }),
      }),
      "box",
    );
    expect(response!.status).toBe(200);
    expect(((await response!.json()) as { terminated: unknown }).terminated).toEqual([termination]);
    expect(await runnerCancelPending(db, "box")).toBe(false);
    expect((await runnerOccupancy(db, "box", now)).occupied).toBe(0);
    // Between-command ownership survives until the owning run ends.
    expect(await runnerSlotsHeldBetweenCommands(db, "box", now)).toBe(1);
    const { confirmed } = await runnerWork(db);
    now++;
    await work.heartbeat(
      "box",
      1,
      host,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      [termination],
    );
    expect((await runnerWork(db)).confirmed).toBe(confirmed);
    await seed(db, (q) =>
      q.orm.update(q.t.runnerWork).set({ lostAt: 1 }).where(eq(q.t.runnerWork.runId, run.id)),
    );
    await work.assign(next);
    await work.enqueue({
      ...cancel,
      id: "cancel-2",
      generation: 2,
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    await work.acknowledge("box", cancel.id);
    await work.heartbeat(
      "box",
      1,
      host,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      [termination],
    );
    expect(await runnerCancelPending(db, "box")).toBe(true);
    expect((await runnerOccupancy(db, "box", now)).occupied).toBe(1);
    // Generic release/recovery paths end authority but keep the slot until confirmation.
    await releaseRunCapacity(db, run.id, now);
    expect(await runnerSlotFree(db, ["box"], now)).toBe(false);
    await work.heartbeat(
      "box",
      1,
      host,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      [{ runId: run.id, generation: 2, commandId: "cancel-2" }],
    );
    expect(await runnerSlotFree(db, ["box"], now)).toBe(true);
    const other = await insertQueuedItem(db, { id: "item-2", now, sessionKey: "session-2" });
    const retry = (await beginImplementRun(db, other.id, now)).run;
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session-2",
      teamId: "team",
      observedAtMs: now,
    });
    await bindLinearSessionTask(db, "session-2", other.delegationId, {
      actorId: "owner",
    });
    await bindWorkItemRepository(db, other.id, repository);
    const undelivered = {
      ...command,
      id: "work-3",
      runId: retry.id,
      itemId: other.id,
      generation: 1,
      issuedAt: now,
      expiresAt: now + 120_000,
    };
    await work.assign(undelivered);
    await seed(db, (q) =>
      q.orm.update(q.t.runnerWork).set({ endedAt: now }).where(eq(q.t.runnerWork.runId, retry.id)),
    );
    expect(await runnerCancelPending(db, "box")).toBe(true);
    await expect(work.assign({ ...undelivered, id: "work-4", generation: 2 })).rejects.toThrow(
      RunnerTeardownPending,
    );
    now = undelivered.expiresAt + 1;
    expect(await runnerCancelPending(db, "box")).toBe(true);
    await work.heartbeat(
      "box",
      1,
      host,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      [],
    );
    expect(await runnerCancelPending(db, "box")).toBe(false);
    expect((await runnerOccupancy(db, "box", now)).occupied).toBe(0);
    const reported = {
      ...undelivered,
      id: "work-4",
      generation: 2,
      issuedAt: now,
      expiresAt: now + 120_000,
    };
    await work.assign(reported);
    await work.heartbeat("box", 1, host, undefined, undefined, undefined, undefined, [
      { runId: retry.id, generation: 2 },
    ]);
    await releaseRunCapacity(db, retry.id, now);
    now = reported.expiresAt + 1;
    await work.heartbeat(
      "box",
      1,
      host,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      [],
    );
    expect(await runnerCancelPending(db, "box")).toBe(true);
    expect((await runnerOccupancy(db, "box", now)).occupied).toBe(1);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a runner that never reported terminations keeps the legacy release on cancel receipt or loss", async () => {
  const { db, close } = await tempStore();
  try {
    await withoutForeignKeys(db);
    const ended = (runId: string, lostAt: number | null) =>
      seed(db, (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId,
          runnerId: "old",
          workspaceId: "ws",
          generation: 1,
          runnerFence: 0,
          commandId: `work-${runId}`,
          leaseUntil: 2000,
          endedAt: 1000,
          lostAt,
        }),
      );
    const since = (terminationsSince: number) =>
      seed(db, (q) => q.orm.update(q.t.runner).set({ terminationsSince }));
    await seed(
      db,
      (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: "old", capacity: 1 }),
      (q) =>
        q.orm.insert(q.t.runner).values({
          id: "old",
          workspaceId: "ws",
          ownerUserId: "me",
          name: "old",
          status: "active",
          createdAt: 0,
          lastSeenAt: 1000,
        }),
    );
    await ended("cancelled", null);
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerCommand).values({
        id: "cancel",
        runnerId: "old",
        runId: "cancelled",
        generation: 1,
        kind: "cancel",
        envelope: jsonValue(q, {}),
        expiresAt: 5000,
        acknowledgedAt: 1100,
      }),
    );
    expect(await runnerCancelPending(db, "old")).toBe(false);
    await ended("lost", 1200);
    expect(await runnerCancelPending(db, "old")).toBe(false);
    await since(1050);
    expect((await runnerOccupancy(db, "old", 1300)).occupied).toBe(2);
    await since(1150);
    expect((await runnerOccupancy(db, "old", 1300)).occupied).toBe(1);
    await since(1250);
    expect(await runnerCancelPending(db, "old")).toBe(false);
  } finally {
    await close();
  }
});
