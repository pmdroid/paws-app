import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  releaseRunCapacity,
  runnerCancelPending,
  runnerOccupancy,
  runnerSlotFree,
  runnerSlotsHeldBetweenCommands,
} from "../src/db";
import { RunnerCapacityWait } from "../src/core";
import { createRunnerWork, createRunnerWorkHttp } from "../src/runner-work";
import { CONFIRMED_TEARDOWN_RUNNER_VERSION, type RunnerCommand } from "../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceTokenHash } from "../src/workspace";

test("real cancellation retains ownership through receipt, expiry, live reports and server reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-cancel-pending-"));
  const path = join(root, "paws.sqlite");
  let db = openDatabase(path);
  let now = Date.now();
  const keys = generateKeyPairSync("ed25519");
  const controller = () =>
    createRunnerWork({ db, keyId: "fixture", privateKey: keys.privateKey, now: () => now });
  try {
    migrate(db);
    const userId = putWorkspaceUser(db, {
      id: "me",
      linearUserId: "owner",
      name: "Owner",
      email: "owner@example.invalid",
    });
    const workspace = consumeWorkspaceBootstrap(db, {
      id: "ws",
      organizationId: "org",
      name: "Test",
      userId,
      tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
      now,
    });
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('box',?,?,'box','active',?,?)",
      [workspace.id, userId, now, now],
    );
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "team",
    ]);
    const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
    const { run } = beginImplementRun(db, item.id, now);
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    };
    bindWorkItemRepository(db, item.id, repository);
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
    work.assign(command);
    expect(runnerOccupancy(db, "box", now).occupied).toBe(1);
    work.acknowledge("box", command.id);
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
    work.enqueue(cancel);
    expect(
      db.query<{ endedAt: number }, []>("SELECT ended_at AS endedAt FROM runner_work").get()!
        .endedAt,
    ).toBe(now);
    expect(runnerOccupancy(db, "box", now).occupied).toBe(1);
    expect(runnerSlotsHeldBetweenCommands(db, "box", now)).toBe(0);
    work.acknowledge("box", cancel.id);
    expect(runnerCancelPending(db, "box", now)).toBe(true);
    now = cancel.expiresAt + 1;
    const report = [{ runId: run.id, generation: 1 }];
    const host = { runnerVersion: CONFIRMED_TEARDOWN_RUNNER_VERSION.join(".") };
    work.heartbeat("box", 1, host, undefined, undefined, undefined, undefined, report);
    expect(runnerSlotFree(db, ["box"], now, run.id)).toBe(false);
    db.close();
    db = openDatabase(path);
    work = controller();
    expect(runnerCancelPending(db, "box", now)).toBe(true);
    const next = {
      ...command,
      id: "work-2",
      generation: 2,
      issuedAt: now,
      expiresAt: now + 600_000,
    };
    expect(() => work.assign(next)).toThrow(RunnerCapacityWait);
    // Absence also cannot erase the durable cleanup obligation.
    work.heartbeat("box", 1, host, undefined, undefined, undefined, undefined, []);
    expect(runnerOccupancy(db, "box", now).occupied).toBe(1);
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
    expect(runnerCancelPending(db, "box", now)).toBe(false);
    expect(runnerOccupancy(db, "box", now).occupied).toBe(0);
    // Between-command ownership survives until the owning run ends.
    expect(runnerSlotsHeldBetweenCommands(db, "box", now)).toBe(1);
    const confirmed = db
      .query<{ confirmed: number }, []>(
        "SELECT teardown_confirmed_at AS confirmed FROM runner_work",
      )
      .get()!.confirmed;
    now++;
    work.heartbeat("box", 1, host, undefined, undefined, undefined, undefined, [], undefined, [
      termination,
    ]);
    expect(
      db
        .query<{ confirmed: number }, []>(
          "SELECT teardown_confirmed_at AS confirmed FROM runner_work",
        )
        .get()!.confirmed,
    ).toBe(confirmed);
    work.assign(next);
    work.enqueue({
      ...cancel,
      id: "cancel-2",
      generation: 2,
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    work.acknowledge("box", cancel.id);
    work.heartbeat("box", 1, host, undefined, undefined, undefined, undefined, [], undefined, [
      termination,
    ]);
    expect(runnerCancelPending(db, "box", now)).toBe(true);
    expect(runnerOccupancy(db, "box", now).occupied).toBe(1);
    // Generic release/recovery paths end authority but keep the slot until confirmation.
    releaseRunCapacity(db, run.id, now);
    expect(runnerSlotFree(db, ["box"], now)).toBe(false);
    work.heartbeat("box", 1, host, undefined, undefined, undefined, undefined, [], undefined, [
      { runId: run.id, generation: 2, commandId: "cancel-2" },
    ]);
    expect(runnerSlotFree(db, ["box"], now)).toBe(true);
    const other = insertQueuedItem(db, { id: "item-2", now, sessionKey: "session-2" });
    const retry = beginImplementRun(db, other.id, now).run;
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session-2",
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "session-2", other.delegationId, { actorId: "owner" });
    bindWorkItemRepository(db, other.id, repository);
    const undelivered = {
      ...command,
      id: "work-3",
      runId: retry.id,
      itemId: other.id,
      generation: 1,
      issuedAt: now,
      expiresAt: now + 120_000,
    };
    work.assign(undelivered);
    db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [now, retry.id]);
    expect(runnerCancelPending(db, "box", now)).toBe(true);
    expect(() => work.assign({ ...undelivered, id: "work-4", generation: 2 })).toThrow(
      RunnerCapacityWait,
    );
    now = undelivered.expiresAt;
    expect(runnerCancelPending(db, "box", now)).toBe(false);
    expect(runnerOccupancy(db, "box", now).occupied).toBe(0);
    const reported = {
      ...undelivered,
      id: "work-4",
      generation: 2,
      issuedAt: now,
      expiresAt: now + 120_000,
    };
    work.assign(reported);
    work.heartbeat("box", 1, host, undefined, undefined, undefined, undefined, [
      { runId: retry.id, generation: 2 },
    ]);
    releaseRunCapacity(db, retry.id, now);
    now = reported.expiresAt;
    expect(runnerCancelPending(db, "box", now)).toBe(true);
    expect(runnerOccupancy(db, "box", now).occupied).toBe(1);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
