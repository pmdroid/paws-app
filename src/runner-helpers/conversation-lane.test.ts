import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  listRunnerOverview,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerCapacity,
  recordRunnerHostStatus,
  runnerHelperAvailability,
  runnerOccupancy,
} from "../db";
import { MINIMUM_RUNNER_VERSION, RUNNER_CONVERSATION_MS } from "../runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../workspace";
import { createRunnerHelpers } from ".";
import { sqlRun, tempStore } from "../../test/pglite";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(conversations?: number, agent: "claude" | "codex" = "claude") {
  const root = mkdtempSync(join(tmpdir(), "paws-conversation-lane-"));
  const { db, close: closeDb } = await tempStore();
  const now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Acme",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  await sqlRun(
    db,
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,'Acme box','active',?,?)",
    ["runner", workspace.id, userId, now, now],
  );
  for (const sessionId of ["session-1", "session-2", "session-3", "session-4"])
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId,
      teamId: "team",
      observedAtMs: now,
    });
  await recordRunnerCapacity(db, "runner", 1, 1, conversations);
  await recordRunnerHostStatus(
    db,
    "runner",
    { runnerVersion: MINIMUM_RUNNER_VERSION.join(".") },
    now,
  );
  const helpers = createRunnerHelpers({
    store: db,
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
        profile: { agent, model: null, fast: true },
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
  cleanup.push(async () => {
    await closeDb();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, now, workspace: workspace.id, dispatch };
}

test("a conversation starts with every work slot busy and fills no work slot", async () => {
  const { db, now, workspace, dispatch } = await fixture(2);
  await dispatch("session-1", "classify");
  expect(await runnerOccupancy(db, "runner", now)).toEqual({ capacity: 1, occupied: 1 });
  expect((await runnerHelperAvailability(db, "runner", now, true)).available).toBe(false);

  const command = await dispatch("session-2", "conversation");
  expect(command.expiresAt - command.issuedAt).toBe(RUNNER_CONVERSATION_MS);
  expect(await runnerOccupancy(db, "runner", now)).toEqual({ capacity: 1, occupied: 1 });
  const [runner] = await listRunnerOverview(db, workspace, now);
  expect(runner!.slots).toEqual({ used: 1, total: 1 });
  expect(runner!.conversations).toEqual({ used: 1, total: 2 });
});

for (const agent of ["claude", "codex"] as const)
  test(`a ${agent} helper keeps fast mode`, async () => {
    const { dispatch } = await fixture(undefined, agent);
    const helper = await dispatch("session-1", "classify");
    expect(helper.type === "helper" && helper.profile.fast).toBe(true);
  });

test("a third conversation waits for a conversation slot, not a work slot", async () => {
  const { db, now, dispatch } = await fixture(2);
  await dispatch("session-1", "conversation");
  await dispatch("session-2", "conversation");
  await expect(dispatch("session-3", "conversation")).rejects.toThrow("Runner is busy");
  expect((await runnerHelperAvailability(db, "runner", now, true, true)).available).toBe(false);
  expect(await runnerOccupancy(db, "runner", now)).toEqual({ capacity: 1, occupied: 0 });
  expect((await dispatch("session-4", "classify")).purpose).toBe("classify");
});

for (const [name, conversations] of [
  ["a runner that reports no conversation lane", undefined],
  ["a runner with the lane turned off", 0],
] as const)
  test(`${name} admits no conversation`, async () => {
    const { db, now, dispatch } = await fixture(conversations);
    expect((await runnerHelperAvailability(db, "runner", now, true, true)).available).toBe(false);
    await expect(dispatch("session-1", "conversation")).rejects.toThrow("Runner is busy");
  });
