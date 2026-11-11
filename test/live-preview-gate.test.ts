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
  putWorkspaceUser,
  recordLinearInstallation,
  sqliteDb,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { LIVE_PREVIEW_RUNNER_VERSION, type RunnerCommand } from "../src/runner-protocol";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

const repository = {
  owner: "fixture",
  repo: "repository",
  remoteUrl: "https://github.com/fixture/repository.git",
  baseSha: "a".repeat(40),
};

async function assignedPreview(runnerVersion: string) {
  const root = mkdtempSync(join(tmpdir(), "paws-preview-gate-"));
  const now = () => 1_800_000_000_000;
  const db = migratedDatabase(join(root, "paws.db"));
  try {
    const userId = await putWorkspaceUser(sqliteDb(db), {
      id: workspaceId(),
      linearUserId: "owner",
      name: "Owner",
      email: "owner@example.invalid",
    });
    const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
      id: workspaceId(),
      organizationId: "org",
      name: "Fixture",
      userId,
      tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now())),
      now: now(),
    });
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "team",
    ]);
    const issuer = join(root, "issuer");
    const control = createRunnerControl({
      db,
      authority: await initializeRunnerAuthority(issuer),
      certificateRoot: issuer,
      disconnect() {},
      now,
    });
    const pending = { name: "Runner", csr: (await createRunnerKey(join(root, "client"))).csr };
    const { runnerId } = await control.enroll({
      ...pending,
      token: (
        await control.createEnrollment(
          { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: now(), teamIds: [] },
          pending,
        )
      ).token,
    });
    db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
    db.run("INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?)", [
      runnerId,
      runnerVersion,
      now(),
    ]);
    const item = insertQueuedItem(db, { id: "item", now: now(), sessionKey: "session" });
    const { run } = await beginImplementRun(sqliteDb(db), item.id, now());
    await recordLinearInstallation(sqliteDb(db), {
      organizationId: "org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId: "session",
      teamId: "team",
      observedAtMs: now(),
    });
    await bindLinearSessionTask(sqliteDb(db), "session", item.delegationId, { actorId: "owner" });
    await bindWorkItemRepository(sqliteDb(db), item.id, repository);
    const work = createRunnerWork({
      db,
      keyId: "fixture",
      privateKey: generateKeyPairSync("ed25519").privateKey,
      eventKey: Buffer.alloc(32, 7),
      now,
    });
    const command: Extract<RunnerCommand, { type: "run" }> = {
      type: "run",
      id: workspaceId(),
      runnerId,
      workspaceId: workspace.id,
      issuedAt: now(),
      expiresAt: now() + 3_600_000,
      runId: run.id,
      itemId: item.id,
      generation: 1,
      repository,
      profile: { agent: "codex", model: "scripted" },
      prompt: "Fixture",
      livePreview: { command: "bun run dev", port: 5173 },
    };
    await work.assign(command);
    const sent = (await work.currentAsync(run.id, 1)).command;
    return sent.type === "run" ? sent.livePreview : undefined;
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a runner below the live preview release never gets the field", async () => {
  const [major, minor, patch] = LIVE_PREVIEW_RUNNER_VERSION;
  expect(await assignedPreview(`${major}.${minor}.${patch - 1}`)).toBeUndefined();
  expect(await assignedPreview("")).toBeUndefined();
  expect(await assignedPreview(`${major}.${minor}.${patch}`)).toEqual({
    command: "bun run dev",
    port: 5173,
  });
});
