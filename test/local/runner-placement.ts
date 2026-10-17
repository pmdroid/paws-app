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
import { createFakeLinearIssueLifecycle } from "../../src/linear";
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
  db.run(
    `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at)
     VALUES('approval',?,'project',?,?,'placement','{}',?,?,?)`,
    [workspace.id, owner, owner, now, now, now],
  );
  db.run("UPDATE work_item SET owner_user_id=?, project_approval_id='approval' WHERE id=?", [
    owner,
    item.id,
  ]);
  for (const [id, user] of [
    ["own", "owner"],
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
    db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES(?,?)", [id!, id === "own" ? 0 : 1]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,seat,ready) VALUES(?,'codex',?,1)", [
      id!,
      id === "own" ? "personal" : id === "shared" ? "organization" : "api",
    ]);
  }
  db.run(
    "INSERT INTO workspace_runner_policy(workspace_id,personal_organization_host) VALUES(?,1)",
    [workspace.id],
  );
  const issue = {
    id: item.linearIssueId,
    teamId: "team",
    assigneeId: "owner",
    delegateId: "app",
    stateType: "started",
    projectId: "project",
  };
  const lifecycle = createFakeLinearIssueLifecycle(issue);
  let members = ["colleague"];
  let membershipFailure = false;
  let installationObservation = now;
  let observedTeam: string | undefined = "team";
  let revokeDuringRead = false;
  const observeInstallation = (teamId: string) =>
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app-client",
      appUserId: "app",
      sessionId: "session",
      teamId,
      observedAtMs: ++installationObservation,
    });
  const placement = createRunnerPlacement({
    db,
    lifecycle,
    tracker: {
      async listProjectMembers() {
        if (revokeDuringRead)
          revokeLinearInstallation(db, {
            eventKey: "placement-revocation",
            organizationId: "org",
            oauthClientId: "app-client",
            createdAtMs: ++installationObservation,
          });
        if (observedTeam !== undefined) {
          observeInstallation(observedTeam);
          observedTeam = undefined;
        }
        if (membershipFailure) throw new Error("Linear returned incomplete project membership");
        return members;
      },
    },
    now: () => now,
  });
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
    observeInstallation("team");
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
    assert.deepEqual(await ids(), ["own", "shared"]);
    observe("An unchanged installation refresh preserves ownership reads and assignment", true, {
      sameOAuthClient: true,
      sameAppUser: true,
      sameTeam: true,
    });
    observedTeam = "other-team";
    await assert.rejects(ids(), /Runner issue authority changed/);
    observeInstallation("team");
    assert.deepEqual(await ids(), ["own", "shared"]);
    observe("A changed installation team still fences selection", true, {
      teamChangeRejected: true,
    });
    members = [];
    assert.deepEqual(await ids(), ["own"]);
    members = ["colleague"];
    db.run("UPDATE runner_policy SET sharing=0 WHERE runner_id='shared'");
    assert.deepEqual(await ids(), ["own"]);
    db.run("UPDATE runner_policy SET sharing=1 WHERE runner_id='shared'");
    observe(
      "Assignee runners precede explicitly shared project members and sharing is opt in",
      true,
      { first: "own", shared: "shared", outsidersExcluded: true },
    );
    members = ["colleague", "pool"];
    assert.deepEqual(await ids(), ["own", "api", "shared"]);
    db.run("UPDATE runner_agent_policy SET seat='personal' WHERE runner_id='shared'");
    assert.deepEqual(await ids(), ["own", "api"]);
    db.run("UPDATE runner_agent_policy SET seat='organization' WHERE runner_id='shared'");
    db.run("UPDATE workspace_runner_policy SET personal_organization_host=0 WHERE workspace_id=?", [
      workspace.id,
    ]);
    assert.deepEqual(await ids(), ["api", "shared"]);
    db.run("UPDATE workspace_runner_policy SET personal_organization_host=1 WHERE workspace_id=?", [
      workspace.id,
    ]);
    members = ["colleague"];
    observe(
      "Organization and API seats are shared with project members and personal seats need workspace permission for own work",
      true,
      { shared: ["api", "shared"], personalSharingDenied: true, personalNeedsPermission: true },
    );
    await placement.candidates(request);
    saveCheckpoint(db, item.id, {
      phase: "running",
      baseSha: "a".repeat(40),
      wipCommit: "b".repeat(40),
    });
    db.run("UPDATE work_item SET awake_ms=awake_ms+1000,turn_count=turn_count+1 WHERE id=?", [
      item.id,
    ]);
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
    membershipFailure = true;
    assert.deepEqual(await ids(), ["own"]);
    membershipFailure = false;
    observe(
      "Unverified project membership denies shared accounts without removing owner authority",
      true,
      { sharedDenied: true, ownAllowed: true },
    );
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
    const authCommand = await start("shared");
    placement.finished({
      commandId: authCommand,
      runnerId: "shared",
      finishedAt: now,
      result: result(authCommand, "other", { authRequired: true, stopReason: "error" }),
    });
    assert(!(await ids()).includes("shared"));
    const login = await start("shared", "prepare");
    placement.finished({
      commandId: login,
      runnerId: "shared",
      finishedAt: now,
      result: result(login, "other"),
    });
    assert((await ids()).includes("shared"));
    observe("Expired authentication holds work until successful readiness verification", true, {
      held: true,
      recovered: true,
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
      ["shared", "own"],
    );
    assert.deepEqual(await ids({ ...request, role: "reviewer" }), []);
    const conflictCommand = await start("shared", "work", "reviewer", "review-model");
    assert.equal(
      placement.finished({
        commandId: conflictCommand,
        runnerId: "shared",
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
      "Review selection prefers a different member and refuses the implementation model",
      true,
      { preferred: "shared", sameModelDenied: true },
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
    db.run("UPDATE runner SET last_seen_at=0 WHERE id='shared'");
    assert(!(await ids()).includes("shared"));
    db.run("UPDATE runner SET last_seen_at=? WHERE id='shared'", [now]);
    db.run(
      "UPDATE workspace_member SET active=0 WHERE user_id=(SELECT owner_user_id FROM runner WHERE id='shared')",
    );
    assert(!(await ids()).includes("shared"));
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
    const colleague = db
      .query<{ id: string }, []>("SELECT id FROM workspace_user WHERE linear_user_id='colleague'")
      .get()!.id;
    db.run("UPDATE workspace_member SET active=1 WHERE user_id=?", [colleague]);
    db.run(
      "INSERT INTO runner_agent_policy(runner_id,agent,seat,ready) VALUES('own','claude','personal',1)",
    );
    const otherProvider: PlacementRequest = {
      ...request,
      profile: { agent: "claude", model: "implementation-model" },
    };
    assert((await ids(otherProvider)).includes("own"));
    for (const userId of [owner, colleague])
      db.run(
        "INSERT INTO runner_member_account(runner_id,user_id,agent,connected,updated_at) VALUES('own',?,'codex',1,?)",
        [userId, now],
      );
    assert(!(await ids(otherProvider)).includes("own"));
    let selected = (await placement.candidates(request)).find((runner) => runner.id === "own");
    assert.equal(selected?.memberId, owner);
    lifecycle.issue.assigneeId = "colleague";
    selected = (await placement.candidates(request)).find((runner) => runner.id === "own");
    assert.equal(selected?.memberId, owner);
    lifecycle.issue.assigneeId = "owner";
    const personalCommand = await start("own");
    const personalUsage = db
      .query<{ owner: string; seat: string }, [string]>(
        "SELECT owner_user_id AS owner,seat FROM runner_execution_usage WHERE command_id=?",
      )
      .get(personalCommand)!;
    assert.equal(personalUsage.owner, owner);
    assert.equal(personalUsage.seat, "personal");
    placement.finished({
      commandId: personalCommand,
      runnerId: "own",
      finishedAt: now,
      result: result(personalCommand, "implementation-model", {
        errorMessage: "Rate limit exceeded; retry in 30 minutes",
        stopReason: "error",
      }),
    });
    assert(!(await ids()).includes("own"));
    db.run("UPDATE runner_policy SET sharing=1 WHERE runner_id='own'");
    assert(!(await ids()).includes("own"));
    db.run(
      "UPDATE runner_member_account SET cooldown_until=0 WHERE runner_id='own' AND user_id=?",
      [owner],
    );
    assert((await ids()).includes("own"));
    db.run("UPDATE runner_member_account SET connected=0 WHERE user_id=?", [owner]);
    assert(!(await ids()).includes("own"));
    observe(
      "Per-member accounts follow the item owner, host consent and individual quota without shared credential fallback",
      true,
      { owner, colleague },
    );
    revokeDuringRead = true;
    await assert.rejects(ids(), /Runner (?:task|session authority) is unavailable/);
    assert.equal(getLinearSessionAccess(db, "session"), "revoked");
    observe("App revocation during ownership reads still fences selection", true, {
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
