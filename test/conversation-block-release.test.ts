import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { systemClock } from "../src/core";
import {
  CLEANUP_BLOCKED_NOTICE,
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  blockConversation,
  consumeWorkspaceBootstrap,
  getConversation,
  getLinearSession,
  listPendingLinearTurns,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncSteps,
  sqliteDb,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { remoteCommandsGoneSteps } from "../src/runner-backend";
import { RUNNER_LIVE_GRACE_MS, createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceTokenHash } from "../src/workspace";
import { tempHome } from "./helpers";

function linearEvent(key: string, body: string | null): AcceptedLinearEvent {
  return {
    dedupeKey: key,
    deliveryId: null,
    source: "webhook",
    action: body === null ? "created" : "prompted",
    sessionId: "session",
    issueId: "issue",
    activityId: body === null ? null : key,
    body,
    signal: null,
    updatedAtMs: Date.now(),
    payload: JSON.stringify({
      organizationId: "org",
      appUserId: "app",
      agentSession: { creatorId: "human" },
    }),
  };
}

/**
 * A task whose run failed on a runner with "Git process cleanup could not be verified": the
 * conversation is blocked and the runner still holds the acknowledged command.
 */
async function blockedAfterCleanupFailure() {
  const home = tempHome();
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  let now = Date.now();
  await putWorkspaceUser(sqliteDb(db), {
    id: "owner",
    linearUserId: "owner",
    name: "Owner",
    email: "o@x.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(sqliteDb(db), {
    id: "workspace",
    organizationId: "org",
    name: "Fixture",
    userId: "owner",
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES('agentbox',?,'owner','agentbox','active',?)",
    [workspace.id, now],
  );
  await recordLinearInstallation(sqliteDb(db), {
    sessionId: "session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: 1,
  });
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "PAS-763",
      title: "Fix",
      description: null,
      subIssues: [],
    },
  ]);
  const orchestrator = attachOrchestrator({
    store: sqliteDb(db),
    tracker,
    pawsRoot: home,
    jobs: new JobLoop(db, systemClock),
    outbox: new OutboxDispatcher(db, systemClock),
    authorizeLinearIntake: () => syncSteps(() => true),
    remoteExecution: {
      agentForItem: () => {
        throw new Error("Unexpected agent");
      },
      agentForSession: () => {
        throw new Error("Unexpected agent");
      },
      commandsGone: (q, itemId, since) => remoteCommandsGoneSteps(q, itemId, since),
    },
  });
  await orchestrator.onLinearEvent(linearEvent("created", null));
  const itemId = (await getLinearSession(sqliteDb(db), "session"))!.activeItemId!;
  const { run } = await beginImplementRun(sqliteDb(db), itemId, now);
  db.run(
    "INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at,acknowledged_at) VALUES('command','agentbox',?,1,'run','{}',?,?)",
    [run.id, now + 600_000, now],
  );
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,'agentbox',?,1,0,'command',?)",
    [run.id, workspace.id, now + 60_000],
  );
  await applyWorkItemEvent(sqliteDb(db), itemId, "run_failed");
  await blockConversation(sqliteDb(db), itemId, now);
  const keys = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: keys.privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  return {
    db,
    tracker,
    orchestrator,
    itemId,
    runId: run.id,
    /** One runner heartbeat naming the work it still runs, `later` ms from the last. */
    async heartbeat(live: { runId: string; generation: number }[], later = RUNNER_LIVE_GRACE_MS) {
      now += later;
      await work.heartbeat("agentbox", 1, {}, undefined, undefined, undefined, undefined, live);
    },
    restarts: () =>
      db
        .query<{ payload: string }, []>(
          "SELECT payload FROM job WHERE job_key LIKE 'linear-turn:%'",
        )
        .all(),
    notices: () =>
      db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM outbox WHERE json_extract(payload,'$.body')=?",
        )
        .get(CLEANUP_BLOCKED_NOTICE)!.n,
    close: () =>
      orchestrator
        .shutdown()
        .catch(() => undefined)
        .finally(() => db.close()),
  };
}

test("a blocked reply waits, then is delivered once after the restarted runner reports the command gone", async () => {
  const f = await blockedAfterCleanupFailure();
  try {
    await f.orchestrator.onLinearEvent(linearEvent("reply-1", "Please continue"));
    await f.orchestrator.onLinearEvent(linearEvent("reply-2", "And add a test"));
    // The replies wait instead of failing; the session hears why once.
    expect(await listPendingLinearTurns(sqliteDb(f.db), "session")).toHaveLength(2);
    expect(f.restarts()).toEqual([]);
    expect(f.notices()).toBe(1);
    expect((await getConversation(sqliteDb(f.db), f.itemId)).blocked).toBe(true);

    // The runner restarted for an update and no longer names the command.
    await f.heartbeat([]);
    await f.orchestrator.releaseCleanupBlocks();
    expect((await getConversation(sqliteDb(f.db), f.itemId)).blocked).toBe(false);
    const restarts = f.restarts();
    expect(restarts).toHaveLength(1);
    expect(restarts[0]!.payload).toContain("Please continue");
    expect(restarts[0]!.payload).toContain("And add a test");

    await f.orchestrator.releaseCleanupBlocks();
    expect(f.restarts()).toHaveLength(1);
    expect(f.notices()).toBe(1);
  } finally {
    await f.close();
  }
}, 20_000);

test("a runner that still reports the command keeps the block", async () => {
  const f = await blockedAfterCleanupFailure();
  try {
    await f.orchestrator.onLinearEvent(linearEvent("reply-1", "Please continue"));
    const live = [{ runId: f.runId, generation: 1 }];
    await f.heartbeat(live);
    await f.heartbeat(live);
    await f.orchestrator.releaseCleanupBlocks();
    expect((await getConversation(sqliteDb(f.db), f.itemId)).blocked).toBe(true);
    expect(await listPendingLinearTurns(sqliteDb(f.db), "session")).toHaveLength(1);
    expect(f.restarts()).toEqual([]);

    // Once a later report leaves it out, the old agent is gone.
    await f.heartbeat([]);
    await f.orchestrator.releaseCleanupBlocks();
    expect((await getConversation(sqliteDb(f.db), f.itemId)).blocked).toBe(false);
    expect(f.restarts()).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 20_000);
