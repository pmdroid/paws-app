import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
  revokeLinearInstallation,
  getLinearSessionAccess,
  syncWorkspaceMember,
  saveCheckpoint,
} from "../../src/db";
import { createRunnerPlacement, type PlacementRequest } from "../../src/runner-placement";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";
import type { RunnerResult } from "../../src/runner-protocol";

export async function probeRunnerPlacement(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  let now = Date.now();
  const owner = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const token = issueWorkspaceBootstrap(db, "org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: owner,
    tokenHash: workspaceTokenHash(token),
    now,
  });
  const item = insertQueuedItem(db, { id: "placement", now, sessionKey: "session" });
  const { run } = beginImplementRun(db, item.id, now);
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app-client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  bindWorkItemRepository(db, item.id, {
    owner: "fixture",
    repo: "repository",
    remoteUrl: "https://github.com/fixture/repository.git",
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "team",
  ]);
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [owner, item.id]);
  for (const [id, user] of [
    ["own", "owner"],
    ["second", "owner"],
    ["shared", "colleague"],
    ["api", "pool"],
  ]) {
    const userId =
      user === "owner"
        ? owner
        : putWorkspaceUser(db, {
            id: workspaceId(),
            linearUserId: user!,
            name: user!,
            email: `${user}@example.invalid`,
          });
    if (user !== "owner")
      syncWorkspaceMember(db, {
        workspaceId: workspace.id,
        userId,
        role: "member",
        active: true,
        teamIds: ["team"],
        now,
      });
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id!, workspace.id, userId, id!, now, now],
    );
    db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES(?,?)", [
      id!,
      user === "owner" ? 0 : 1,
    ]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',1)", [id!]);
  }
  let installationObservation = now;
  const observeInstallation = (teamId: string) =>
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app-client",
      appUserId: "app",
      sessionId: "session",
      teamId,
      observedAtMs: ++installationObservation,
    });
  const placement = createRunnerPlacement({ db, now: () => now });
  const request: PlacementRequest = {
    itemId: item.id,
    profile: { agent: "codex", model: "implementation-model" },
    role: "implementer",
    purpose: "work",
  };
  const ids = async (input: PlacementRequest = request) =>
    (await placement.candidates(input)).map((row) => row.id);
  const start = async (
    runnerId: string,
    purpose: PlacementRequest["purpose"] = "work",
    role: PlacementRequest["role"] = "implementer",
    model = "implementation-model",
  ) => {
    const profile = { agent: "codex" as const, model };
    await placement.candidates({ ...request, purpose, role, profile });
    const commandId = workspaceId();
    placement.started({
      commandId,
      runnerId,
      itemId: item.id,
      runId: run.id,
      profile,
      purpose,
      role,
      startedAt: now,
    });
    return commandId;
  };
  const result = (
    commandId: string,
    model = "implementation-model",
    changes: Partial<RunnerResult> = {},
  ): RunnerResult => ({
    executionId: run.id,
    commandId,
    role: "implementer",
    stopReason: "end_turn",
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    identity: { session: "agent-session", model, provider: "fixture" },
    ...changes,
  });
  try {
    assert.deepEqual(await ids(), ["own", "second"]);
    observe("An unchanged installation refresh preserves ownership reads and assignment", true, {
      sameOAuthClient: true,
      sameAppUser: true,
      sameTeam: true,
    });
    observeInstallation("other-team");
    await assert.rejects(ids(), /outside workspace access/);
    observeInstallation("team");
    assert.deepEqual(await ids(), ["own", "second"]);
    observe("A changed installation team still fences selection", true, {
      teamChangeRejected: true,
    });
    assert.deepEqual(await ids(), ["own", "second"]);
    observe("An item does not offer another member's shared runner", true, {
      offered: ["own", "second"],
      sharedExcluded: true,
    });
    await placement.candidates(request);
    saveCheckpoint(db, item.id, {
      phase: "running",
      baseSha: "a".repeat(40),
      wipCommit: "b".repeat(40),
    });
    db.run("UPDATE work_item SET awake_ms=awake_ms+1000 WHERE id=?", [item.id]);
    const progressCommand = workspaceId();
    placement.started({
      commandId: progressCommand,
      runnerId: "own",
      itemId: item.id,
      runId: run.id,
      profile: request.profile,
      role: request.role,
      purpose: request.purpose,
      startedAt: now,
    });
    placement.finished({
      commandId: progressCommand,
      runnerId: "own",
      result: result(progressCommand),
      finishedAt: now,
    });
    observe(
      "Checkpoint preparation and ordinary progress preserve unchanged selection authority",
      true,
      { checkpointSaved: true, admitted: true },
    );
    assert.throws(
      () =>
        placement.started({
          commandId: workspaceId(),
          runnerId: "own",
          itemId: item.id,
          runId: run.id,
          profile: request.profile,
          role: request.role,
          purpose: request.purpose,
          startedAt: now,
        }),
      /selection authority changed/,
    );
    observe("Selection grants are consumed once and cannot authorize another command", true, {
      duplicateDenied: true,
    });
    const quotaCommand = await start("own");
    assert.equal(
      placement.finished({
        commandId: quotaCommand,
        runnerId: "own",
        finishedAt: now,
        result: result(quotaCommand, "implementation-model", {
          errorMessage: "Rate limit exceeded; retry in 30 minutes",
          stopReason: "error",
        }),
      }).retryable,
      true,
    );
    assert(!(await ids()).includes("own"));
    const quota = db
      .query<{ reset: number; cooldown: number }, []>(
        "SELECT resets_at AS reset,cooldown_until AS cooldown FROM runner_agent_policy WHERE runner_id='own'",
      )
      .get()!;
    assert.equal(quota.reset, now + 1_800_000);
    assert.equal(quota.cooldown, quota.reset);
    now += 1_800_001;
    db.run("UPDATE runner SET last_seen_at=?", [now]);
    const probe = await start("own", "prepare");
    placement.finished({
      commandId: probe,
      runnerId: "own",
      finishedAt: now,
      result: result(probe),
    });
    assert.equal(
      db
        .query<{ state: string }, []>(
          "SELECT quota_state AS state FROM runner_agent_policy WHERE runner_id='own'",
        )
        .get()!.state,
      "exhausted",
    );
    observe(
      "Provider exhaustion records its reset and a login probe cannot erase exhaustion",
      true,
      quota,
    );
    const authCommand = await start("second");
    placement.finished({
      commandId: authCommand,
      runnerId: "second",
      finishedAt: now,
      result: result(authCommand, "other", { authRequired: true, stopReason: "error" }),
    });
    assert(!(await ids()).includes("second"));
    const fencedSignedOut = await start("second", "prepare");
    placement.finished({
      commandId: fencedSignedOut,
      runnerId: "second",
      finishedAt: now,
      failure: "heartbeat_lost",
    });
    assert(!(await ids()).includes("second"));
    const login = await start("second", "prepare");
    placement.finished({
      commandId: login,
      runnerId: "second",
      finishedAt: now,
      result: result(login, "other"),
    });
    assert((await ids()).includes("second"));
    const fencedSignedIn = await start("second");
    placement.finished({
      commandId: fencedSignedIn,
      runnerId: "second",
      finishedAt: now,
      failure: "heartbeat_lost",
    });
    assert((await ids()).includes("second"));
    observe("Expired authentication holds work until successful readiness verification", true, {
      held: true,
      heldAfterFence: true,
      recovered: true,
      readyAfterFence: true,
    });
    const implemented = await start("own");
    placement.finished({
      commandId: implemented,
      runnerId: "own",
      finishedAt: now,
      result: result(implemented),
    });
    assert.deepEqual(
      await ids({
        ...request,
        role: "reviewer",
        profile: { agent: "codex", model: "review-model" },
      }),
      ["second", "own"],
    );
    assert.deepEqual(await ids({ ...request, role: "reviewer" }), []);
    const conflictCommand = await start("second", "work", "reviewer", "review-model");
    assert.equal(
      placement.finished({
        commandId: conflictCommand,
        runnerId: "second",
        finishedAt: now,
        result: { ...result(conflictCommand), role: "reviewer" },
      }).retryable,
      true,
    );
    const rejectedReview = db
      .query<{ outcome: string; endedAt: number | null }, [string]>(
        "SELECT outcome,ended_at AS endedAt FROM runner_execution_usage WHERE command_id=?",
      )
      .get(conflictCommand)!;
    assert.equal(rejectedReview.outcome, "model_conflict");
    assert.notEqual(rejectedReview.endedAt, null);
    observe(
      "A runtime reviewer model conflict closes its receipt and requests another independent reviewer",
      true,
      rejectedReview,
    );
    observe(
      "Review selection prefers a different runner and refuses the implementation model",
      true,
      { preferred: "second", sameModelDenied: true },
    );
    await placement.candidates(request);
    db.run("UPDATE runner_policy SET sharing=1 WHERE runner_id='own'");
    assert.throws(
      () =>
        placement.started({
          commandId: workspaceId(),
          runnerId: "own",
          itemId: item.id,
          runId: run.id,
          profile: request.profile,
          role: "implementer",
          purpose: "work",
          startedAt: now,
        }),
      /selection authority changed/,
    );
    db.run("UPDATE runner_policy SET sharing=0 WHERE runner_id='own'");
    observe("Policy changes between selection and assignment cannot admit stale authority", true, {
      denied: true,
    });
    db.run("UPDATE runner SET last_seen_at=0 WHERE id='second'");
    assert(!(await ids()).includes("second"));
    db.run("UPDATE runner SET last_seen_at=? WHERE id='second'", [now]);
    db.run("UPDATE workspace_member SET active=0 WHERE user_id=?", [owner]);
    await assert.rejects(ids(), /not an active workspace member/);
    db.run("UPDATE workspace_member SET active=1 WHERE user_id=?", [owner]);
    observe("Offline hosts and revoked workspace members are excluded", true, {
      offlineDenied: true,
      revokedDenied: true,
    });
    const reopened = openDatabase(join(root, "paws.sqlite"));
    try {
      assert(
        reopened
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM runner_execution_usage WHERE ended_at IS NOT NULL",
          )
          .get()!.count >= 5,
      );
    } finally {
      reopened.close();
    }
    observe(
      "Provider observations and attributed execution usage persist across connections",
      true,
      { persisted: true },
    );
    revokeLinearInstallation(db, {
      eventKey: "placement-revocation",
      organizationId: "org",
      oauthClientId: "app-client",
      createdAtMs: ++installationObservation,
    });
    await assert.rejects(ids(), /Runner (?:task|session authority) is unavailable/);
    assert.equal(getLinearSessionAccess(db, "session"), "revoked");
    observe("App revocation fences selection", true, {
      revoked: true,
    });
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable evidence directory");
  const observations: unknown[] = [];
  await probeRunnerPlacement(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2) + "\n");
}
