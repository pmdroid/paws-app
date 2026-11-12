import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
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
  putWorkspaceUser,
  recordLinearInstallation,
  syncSteps,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { remoteCommandsGoneSteps } from "../src/runner-backend";
import { RUNNER_LIVE_GRACE_MS, createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceTokenHash } from "../src/workspace";
import { tempHome } from "./helpers";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

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
  const { db, close } = await tempStore();
  let now = Date.now();
  await putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "owner",
    name: "Owner",
    email: "o@x.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Fixture",
    userId: "owner",
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  await seed(db, (q) =>
    q.orm.insert(q.t.runner).values({
      id: "agentbox",
      workspaceId: workspace.id,
      ownerUserId: "owner",
      name: "agentbox",
      status: "active",
      createdAt: now,
    }),
  );
  await recordLinearInstallation(db, {
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
    store: db,
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
  const itemId = (await getLinearSession(db, "session"))!.activeItemId!;
  const { run } = await beginImplementRun(db, itemId, now);
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runnerCommand).values({
        id: "command",
        runnerId: "agentbox",
        runId: run.id,
        generation: 1,
        kind: "run",
        envelope: "{}",
        expiresAt: now + 600_000,
        acknowledgedAt: now,
      }),
    (q) =>
      q.orm.insert(q.t.runnerWork).values({
        runId: run.id,
        runnerId: "agentbox",
        workspaceId: workspace.id,
        generation: 1,
        runnerFence: 0,
        commandId: "command",
        leaseUntil: now + 60_000,
      }),
  );
  await applyWorkItemEvent(db, itemId, "run_failed");
  await blockConversation(db, itemId, now);
  const keys = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    store: db,
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
    restarts: async () =>
      (
        await db.run((q) =>
          q.all(
            q.orm
              .select({ payload: q.t.job.payload })
              .from(q.t.job)
              .where(like(q.t.job.jobKey, "linear-turn:%")),
          ),
        )
      ).map((row) => ({ payload: JSON.stringify(row.payload) })),
    notices: async () =>
      (
        await db.run((q) =>
          q.all(
            q.orm
              .select({ id: q.t.outbox.id })
              .from(q.t.outbox)
              .where(eq(sql`${q.t.outbox.payload}->>'body'`, CLEANUP_BLOCKED_NOTICE)),
          ),
        )
      ).length,
    close: () =>
      orchestrator
        .shutdown()
        .catch(() => undefined)
        .finally(close),
  };
}

test("a blocked reply waits, then is delivered once after the restarted runner reports the command gone", async () => {
  const f = await blockedAfterCleanupFailure();
  try {
    await f.orchestrator.onLinearEvent(linearEvent("reply-1", "Please continue"));
    await f.orchestrator.onLinearEvent(linearEvent("reply-2", "And add a test"));
    // The replies wait instead of failing; the session hears why once.
    expect(await listPendingLinearTurns(f.db, "session")).toHaveLength(2);
    expect(await f.restarts()).toEqual([]);
    expect(await f.notices()).toBe(1);
    expect((await getConversation(f.db, f.itemId)).blocked).toBe(true);

    // The runner restarted for an update and no longer names the command.
    await f.heartbeat([]);
    await f.orchestrator.releaseCleanupBlocks();
    expect((await getConversation(f.db, f.itemId)).blocked).toBe(false);
    const restarts = await f.restarts();
    expect(restarts).toHaveLength(1);
    expect(restarts[0]!.payload).toContain("Please continue");
    expect(restarts[0]!.payload).toContain("And add a test");

    await f.orchestrator.releaseCleanupBlocks();
    expect(await f.restarts()).toHaveLength(1);
    expect(await f.notices()).toBe(1);
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
    expect((await getConversation(f.db, f.itemId)).blocked).toBe(true);
    expect(await listPendingLinearTurns(f.db, "session")).toHaveLength(1);
    expect(await f.restarts()).toEqual([]);

    // Once a later report leaves it out, the old agent is gone.
    await f.heartbeat([]);
    await f.orchestrator.releaseCleanupBlocks();
    expect((await getConversation(f.db, f.itemId)).blocked).toBe(false);
    expect(await f.restarts()).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 20_000);
