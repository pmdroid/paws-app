import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  listRunnerOverview,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerCapacity,
  recordRunnerHostStatus,
  runnerHelperAvailability,
  runnerOccupancy,
  sqliteDb,
} from "../db";
import { RUNNER_CONVERSATION_MS } from "../runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../workspace";
import { createRunnerHelpers } from ".";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function fixture(version: string | null, conversations?: number) {
  const root = mkdtempSync(join(tmpdir(), "paws-conversation-lane-"));
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Acme",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,'Acme box','active',?,?)",
    ["runner", workspace.id, userId, now, now],
  );
  for (const sessionId of ["session-1", "session-2", "session-3", "session-4"])
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId,
      teamId: "team",
      observedAtMs: now,
    });
  recordRunnerCapacity(db, "runner", 1, 1, conversations);
  if (version)
    await recordRunnerHostStatus(sqliteDb(db), "runner", { runnerVersion: version }, now);
  const helpers = createRunnerHelpers({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => now,
  });
  const dispatch = async (sessionId: string, purpose: "classify" | "conversation") =>
    (
      await helpers.dispatch({
        runnerId: "runner",
        sessionId,
        purpose,
        profile: { agent: "claude", model: null },
        prompt: "What does the acme checkout do?",
        ...(purpose === "conversation"
          ? {
              conversation: {
                itemId: "item-acme",
                runId: "run-acme",
                resumeSessionId: `claude-${sessionId}`,
              },
            }
          : {}),
      })
    ).command;
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, now, workspace: workspace.id, dispatch };
}

test("a conversation starts with every work slot busy and fills no work slot", async () => {
  const { db, now, workspace, dispatch } = await fixture("0.1.77", 2);
  await dispatch("session-1", "classify");
  expect(runnerOccupancy(db, "runner", now)).toEqual({ capacity: 1, occupied: 1 });
  expect(runnerHelperAvailability(db, "runner", now, true).available).toBe(false);

  const command = await dispatch("session-2", "conversation");
  expect(command.expiresAt - command.issuedAt).toBe(RUNNER_CONVERSATION_MS);
  expect(runnerOccupancy(db, "runner", now)).toEqual({ capacity: 1, occupied: 1 });
  const [runner] = await listRunnerOverview(sqliteDb(db), workspace, now);
  expect(runner!.slots).toEqual({ used: 1, total: 1 });
  expect(runner!.conversations).toEqual({ used: 1, total: 2 });
});

test("a third conversation waits for a conversation slot, not a work slot", async () => {
  const { db, now, dispatch } = await fixture("0.1.77", 2);
  await dispatch("session-1", "conversation");
  await dispatch("session-2", "conversation");
  await expect(dispatch("session-3", "conversation")).rejects.toThrow("Runner is busy");
  expect(runnerHelperAvailability(db, "runner", now, true, true).available).toBe(false);
  expect(runnerOccupancy(db, "runner", now)).toEqual({ capacity: 1, occupied: 0 });
  expect((await dispatch("session-4", "classify")).purpose).toBe("classify");
});

for (const [name, version, conversations] of [
  ["an older runner", "0.1.73", 2],
  ["a runner that reports no conversation lane", "0.1.77", undefined],
  ["a runner with the lane turned off", "0.1.77", 0],
  ["a runner that is not told the control plane's level", "0.1.75", 2],
  ["a runner that refuses Claude's reply and start_work calls", "0.1.76", 2],
] as const)
  test(`${name} admits no conversation`, async () => {
    const { db, now, dispatch } = await fixture(version, conversations);
    expect(runnerHelperAvailability(db, "runner", now, true, true).available).toBe(false);
    await expect(dispatch("session-1", "conversation")).rejects.toThrow("Runner is busy");
  });
