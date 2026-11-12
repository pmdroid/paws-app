import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
  revokeLinearInstallation,
  getLinearSessionAccess,
  syncWorkspaceMember,
  saveCheckpoint,
  type Q,
} from "../../src/db";
import { createRunnerPlacement, type PlacementRequest } from "../../src/runner-placement";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";
import type { RunnerResult } from "../../src/runner-protocol";
import { count, eq, isNotNull, ne, sql } from "drizzle-orm";
import { seed } from "../dialects";
import { tempStore } from "../pglite";

export async function probeRunnerPlacement(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true });
  const { db, close } = await tempStore();
  const change = (statement: (q: Q) => PromiseLike<unknown>) => seed(db, statement);
  let now = Date.now();
  const owner = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const token = await issueWorkspaceBootstrap(db, "org", now);
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: owner,
    tokenHash: workspaceTokenHash(token),
    now,
  });
  const item = await insertQueuedItem(db, { id: "placement", now, sessionKey: "session" });
  const { run } = await beginImplementRun(db, item.id, now);
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app-client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  await bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  await bindWorkItemRepository(db, item.id, {
    owner: "fixture",
    repo: "repository",
    remoteUrl: "https://github.com/fixture/repository.git",
  });
  await change((q) =>
    q.orm
      .insert(q.t.workspaceRepository)
      .values({ workspaceId: workspace.id, repository: "fixture/repository", teamId: "team" }),
  );
  await change((q) =>
    q.orm.update(q.t.workItem).set({ ownerUserId: owner }).where(eq(q.t.workItem.id, item.id)),
  );
  for (const [id, user] of [
    ["own", "owner"],
    ["second", "owner"],
    ["shared", "colleague"],
    ["api", "pool"],
  ]) {
    const userId =
      user === "owner"
        ? owner
        : await putWorkspaceUser(db, {
            id: workspaceId(),
            linearUserId: user!,
            name: user!,
            email: `${user}@example.invalid`,
          });
    if (user !== "owner")
      await syncWorkspaceMember(db, {
        workspaceId: workspace.id,
        userId,
        role: "member",
        active: true,
        teamIds: ["team"],
        now,
      });
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id: id!,
          workspaceId: workspace.id,
          ownerUserId: userId,
          name: id!,
          status: "active",
          createdAt: now,
          lastSeenAt: now,
        }),
      (q) =>
        q.orm.insert(q.t.runnerPolicy).values({ runnerId: id!, sharing: user === "owner" ? 0 : 1 }),
      (q) =>
        q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: id!, agent: "codex", ready: 1 }),
    );
  }
  const setSharing = (sharing: number) =>
    change((q) =>
      q.orm.update(q.t.runnerPolicy).set({ sharing }).where(eq(q.t.runnerPolicy.runnerId, "own")),
    );
  const lastSeen = (lastSeenAt: number) =>
    change((q) => q.orm.update(q.t.runner).set({ lastSeenAt }).where(eq(q.t.runner.id, "second")));
  const setActive = (active: number) =>
    change((q) =>
      q.orm
        .update(q.t.workspaceMember)
        .set({ active })
        .where(eq(q.t.workspaceMember.userId, owner)),
    );
  let installationObservation = now;
  const observeInstallation = async (teamId: string) =>
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app-client",
      appUserId: "app",
      sessionId: "session",
      teamId,
      observedAtMs: ++installationObservation,
    });
  const placement = createRunnerPlacement({ store: db, now: () => now });
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
    await db.transaction((q) =>
      placement.startedSteps(q, {
        commandId,
        runnerId,
        itemId: item.id,
        runId: run.id,
        profile,
        purpose,
        role,
        startedAt: now,
      }),
    );
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
    await observeInstallation("other-team");
    await assert.rejects(ids(), /outside workspace access/);
    await observeInstallation("team");
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
    await saveCheckpoint(db, item.id, {
      phase: "running",
      baseSha: "a".repeat(40),
      wipCommit: "b".repeat(40),
    });
    await change((q) =>
      q.orm
        .update(q.t.workItem)
        .set({ awakeMs: sql`${q.t.workItem.awakeMs} + 1000` })
        .where(eq(q.t.workItem.id, item.id)),
    );
    const progressCommand = workspaceId();
    await db.transaction((q) =>
      placement.startedSteps(q, {
        commandId: progressCommand,
        runnerId: "own",
        itemId: item.id,
        runId: run.id,
        profile: request.profile,
        role: request.role,
        purpose: request.purpose,
        startedAt: now,
      }),
    );
    await db.transaction((q) =>
      placement.finishedSteps(q, {
        commandId: progressCommand,
        runnerId: "own",
        result: result(progressCommand),
        finishedAt: now,
      }),
    );
    observe(
      "Checkpoint preparation and ordinary progress preserve unchanged selection authority",
      true,
      { checkpointSaved: true, admitted: true },
    );
    await assert.rejects(
      () =>
        db.transaction((q) =>
          placement.startedSteps(q, {
            commandId: workspaceId(),
            runnerId: "own",
            itemId: item.id,
            runId: run.id,
            profile: request.profile,
            role: request.role,
            purpose: request.purpose,
            startedAt: now,
          }),
        ),
      /selection authority changed/,
    );
    observe("Selection grants are consumed once and cannot authorize another command", true, {
      duplicateDenied: true,
    });
    const quotaCommand = await start("own");
    assert.equal(
      (
        await db.transaction((q) =>
          placement.finishedSteps(q, {
            commandId: quotaCommand,
            runnerId: "own",
            finishedAt: now,
            result: result(quotaCommand, "implementation-model", {
              errorMessage: "Rate limit exceeded; retry in 30 minutes",
              stopReason: "error",
            }),
          }),
        )
      ).retryable,
      true,
    );
    assert(!(await ids()).includes("own"));
    const [quota] = await db.run((q) =>
      q.all(
        q.orm
          .select({
            reset: q.t.runnerAgentPolicy.resetsAt,
            cooldown: q.t.runnerAgentPolicy.cooldownUntil,
          })
          .from(q.t.runnerAgentPolicy)
          .where(eq(q.t.runnerAgentPolicy.runnerId, "own")),
      ),
    );
    if (!quota) throw new Error("Missing quota for own");
    assert.equal(quota.reset, now + 1_800_000);
    assert.equal(quota.cooldown, quota.reset);
    now += 1_800_001;
    await change((q) => q.orm.update(q.t.runner).set({ lastSeenAt: now }));
    const probe = await start("own", "prepare");
    await db.transaction((q) =>
      placement.finishedSteps(q, {
        commandId: probe,
        runnerId: "own",
        finishedAt: now,
        result: result(probe),
      }),
    );
    assert.deepEqual(
      await db.run((q) =>
        q.all(
          q.orm
            .select({ state: q.t.runnerAgentPolicy.quotaState })
            .from(q.t.runnerAgentPolicy)
            .where(eq(q.t.runnerAgentPolicy.runnerId, "own")),
        ),
      ),
      [{ state: "exhausted" }],
    );
    observe(
      "Provider exhaustion records its reset and a login probe cannot erase exhaustion",
      true,
      quota,
    );
    const authCommand = await start("second");
    await db.transaction((q) =>
      placement.finishedSteps(q, {
        commandId: authCommand,
        runnerId: "second",
        finishedAt: now,
        result: result(authCommand, "other", { authRequired: true, stopReason: "error" }),
      }),
    );
    assert(!(await ids()).includes("second"));
    const onlySecond = async (place: () => Promise<string>) => {
      const policy = (q: Q) => q.t.runnerAgentPolicy;
      const others = await db.run((q) =>
        q.all(
          q.orm
            .select({ id: policy(q).runnerId, ready: policy(q).ready })
            .from(policy(q))
            .where(ne(policy(q).runnerId, "second")),
        ),
      );
      await change((q) =>
        q.orm
          .update(policy(q))
          .set({ ready: 0 })
          .where(ne(policy(q).runnerId, "second")),
      );
      try {
        return await place();
      } finally {
        for (const other of others)
          await change((q) =>
            q.orm
              .update(policy(q))
              .set({ ready: other.ready })
              .where(eq(policy(q).runnerId, other.id)),
          );
      }
    };
    const fencedSignedOut = await onlySecond(() => start("second", "prepare"));
    await db.transaction((q) =>
      placement.finishedSteps(q, {
        commandId: fencedSignedOut,
        runnerId: "second",
        finishedAt: now,
        failure: "heartbeat_lost",
      }),
    );
    assert(!(await ids()).includes("second"));
    const login = await onlySecond(() => start("second", "prepare"));
    await db.transaction((q) =>
      placement.finishedSteps(q, {
        commandId: login,
        runnerId: "second",
        finishedAt: now,
        result: result(login, "other"),
      }),
    );
    assert((await ids()).includes("second"));
    const fencedSignedIn = await start("second");
    await db.transaction((q) =>
      placement.finishedSteps(q, {
        commandId: fencedSignedIn,
        runnerId: "second",
        finishedAt: now,
        failure: "heartbeat_lost",
      }),
    );
    assert((await ids()).includes("second"));
    observe("Expired authentication holds work until successful readiness verification", true, {
      held: true,
      heldAfterFence: true,
      recovered: true,
      readyAfterFence: true,
    });
    const implemented = await start("own");
    await db.transaction((q) =>
      placement.finishedSteps(q, {
        commandId: implemented,
        runnerId: "own",
        finishedAt: now,
        result: result(implemented),
      }),
    );
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
      (
        await db.transaction((q) =>
          placement.finishedSteps(q, {
            commandId: conflictCommand,
            runnerId: "second",
            finishedAt: now,
            result: { ...result(conflictCommand), role: "reviewer" },
          }),
        )
      ).retryable,
      true,
    );
    const [rejectedReview] = await db.run((q) =>
      q.all(
        q.orm
          .select({
            outcome: q.t.runnerExecutionUsage.outcome,
            endedAt: q.t.runnerExecutionUsage.endedAt,
          })
          .from(q.t.runnerExecutionUsage)
          .where(eq(q.t.runnerExecutionUsage.commandId, conflictCommand)),
      ),
    );
    if (!rejectedReview) throw new Error("Missing the rejected review receipt");
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
    await setSharing(1);
    await assert.rejects(
      () =>
        db.transaction((q) =>
          placement.startedSteps(q, {
            commandId: workspaceId(),
            runnerId: "own",
            itemId: item.id,
            runId: run.id,
            profile: request.profile,
            role: "implementer",
            purpose: "work",
            startedAt: now,
          }),
        ),
      /selection authority changed/,
    );
    await setSharing(0);
    observe("Policy changes between selection and assignment cannot admit stale authority", true, {
      denied: true,
    });
    await lastSeen(0);
    assert(!(await ids()).includes("second"));
    await lastSeen(now);
    await setActive(0);
    await assert.rejects(ids(), /not an active workspace member/);
    await setActive(1);
    observe("Offline hosts and revoked workspace members are excluded", true, {
      offlineDenied: true,
      revokedDenied: true,
    });
    const [ended] = await db.run((q) =>
      q.all(
        q.orm
          .select({ count: count() })
          .from(q.t.runnerExecutionUsage)
          .where(isNotNull(q.t.runnerExecutionUsage.endedAt)),
      ),
    );
    assert(ended!.count >= 5);
    observe("Provider observations and attributed execution usage persist", true, {
      persisted: true,
    });
    await revokeLinearInstallation(db, {
      eventKey: "placement-revocation",
      organizationId: "org",
      oauthClientId: "app-client",
      createdAtMs: ++installationObservation,
    });
    await assert.rejects(ids(), /Runner (?:task|session authority) is unavailable/);
    assert.equal(await getLinearSessionAccess(db, "session"), "revoked");
    observe("App revocation fences selection", true, {
      revoked: true,
    });
  } finally {
    await close();
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
