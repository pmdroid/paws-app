import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  advanceLinearSessionGeneration,
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  enrollRunner,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  sqliteDb,
} from "../../src/db";
import { writeSecretFile } from "../../src/credentials";
import { openRunnerCoordinator } from "../../src/runner-coordinator";
import { describeRunnerCertificate } from "../../src/runner-identity";
import { verifyRunnerCommand, type RunnerHelperResult } from "../../src/runner-protocol";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { request as https } from "node:https";
import { RUNNER_AUTHORITY, RUNNER_IDENTITIES, SERVER_TLS } from "../fixtures/runner-identity";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerSessionHelpers(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const identity = join(root, "identity");
  mkdirSync(identity, { mode: 0o700 });
  writeSecretFile(join(identity, "runner-authority.json"), JSON.stringify(RUNNER_AUTHORITY), true);
  const { privateKey } = generateKeyPairSync("ed25519");
  writeSecretFile(
    join(identity, "runner-command-key.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    true,
  );
  const signingKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const trustedKeys = new Map([
    [createHash("sha256").update(signingKey).digest("hex"), createPublicKey(signingKey)],
  ]);
  const tls = SERVER_TLS;
  const dbPath = join(root, "paws.db");
  let db = openDatabase(dbPath);
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
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
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "admin" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const errors: unknown[] = [];
  const options = {
    root: identity,
    tls,
    hostname: "127.0.0.1",
    onError: (error: unknown) => errors.push(error),
    now: () => now,
  };
  let coordinator = await openRunnerCoordinator({
    eventKey: Buffer.alloc(32, 7),
    ...options,
    db,
    port: 0,
  });
  const runnerPort = coordinator.port;
  async function pair(name: string, runner: (typeof RUNNER_IDENTITIES)[number]) {
    const { token } = await coordinator.control.createEnrollment(principal, { name });
    const runnerId = workspaceId(now);
    await enrollRunner(sqliteDb(db), {
      tokenHash: workspaceTokenHash(token),
      runnerId,
      name,
      certificate: describeRunnerCertificate(runner.certificate),
      now,
    });
    await coordinator.control.setStatus(principal, runnerId, "active");
    return runnerId;
  }
  try {
    const runnerId = await pair("Session helper runner", RUNNER_IDENTITIES[0]);
    const { key, certificate } = RUNNER_IDENTITIES[0];
    async function call(path: string, value?: unknown) {
      return await new Promise<{ status: number; body: Record<string, unknown> }>(
        (resolve, reject) => {
          const request = https(
            {
              hostname: "127.0.0.1",
              port: coordinator.port,
              path,
              method: value === undefined ? "GET" : "POST",
              ca: tls.cert,
              key,
              cert: certificate,
              agent: false,
              headers: value === undefined ? {} : { "content-type": "application/json" },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.on("end", () =>
                resolve({
                  status: response.statusCode!,
                  body: Buffer.concat(chunks).length
                    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
                    : {},
                }),
              );
              response.on("error", reject);
            },
          );
          request.on("error", reject);
          request.end(value === undefined ? undefined : JSON.stringify(value));
        },
      );
    }
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId: "session",
      teamId: "team",
      observedAtMs: now,
    });
    const input = {
      runnerId: runnerId,
      sessionId: "session",
      purpose: "classify" as const,
      profile: { agent: "codex" as const, model: null },
      prompt: "Classify this Linear request",
    };
    assert.equal(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()!.n, 0);
    const first = await coordinator.helpers.dispatch(input);
    await assert.rejects(coordinator.work.enqueue(first.command), /session assignment/);
    const queued = await call("/v1/helper-commands");
    assert.equal(queued.status, 200);
    assert(Array.isArray(queued.body.commands));
    assert.equal(queued.body.commands.length, 1);
    const verified = verifyRunnerCommand(queued.body.commands[0], {
      trustedKeys,
      runnerId: runnerId,
      workspaceId: workspace.id,
      now,
      allowedRepositories: [],
      claimCommand: () => true,
    });
    assert(verified.ok);
    assert.deepEqual(verified.command, first.command);
    observe("signed helper work is authorized before any task run or repository exists", true, {
      workItems: 0,
      purpose: first.command.purpose,
      sessionGeneration: first.command.sessionGeneration,
      mTLS: true,
    });
    await assert.rejects(coordinator.helpers.dispatch(input), /busy/);
    assert.equal((await call(`/v1/helper-commands/${first.command.id}/ack`, {})).status, 200);
    assert.equal((await call(`/v1/helper-commands/${first.command.id}/ack`, {})).status, 200);
    assert.deepEqual((await call("/v1/helper-commands")).body.commands, []);
    assert.equal(
      (await call(`/v1/helper-commands/${first.command.id}/lease`, {})).body.expiresAt,
      first.command.expiresAt,
    );
    const result: RunnerHelperResult = {
      executionId: workspaceId(),
      commandId: first.command.id,
      role: "implementer",
      stopReason: "end_turn",
      cancelled: false,
      timedOut: false,
      authRequired: false,
      agentExited: true,
      text: '{"mode":"answer"}',
    };
    assert.deepEqual((await call(`/v1/helper-commands/${first.command.id}/result`, result)).body, {
      duplicate: false,
    });
    assert.deepEqual((await call(`/v1/helper-commands/${first.command.id}/result`, result)).body, {
      duplicate: true,
    });
    assert.equal(
      (await call(`/v1/helper-commands/${first.command.id}/result`, { ...result, text: "changed" }))
        .status,
      403,
    );
    assert.equal(
      (
        await call(`/v1/helper-commands/${first.command.id}/result`, {
          ...result,
          candidateSha: "a".repeat(40),
        })
      ).status,
      403,
    );
    assert.deepEqual(await coordinator.helpers.result(first.command.id), result);
    await coordinator.stop();
    db.close();
    db = openDatabase(dbPath);
    migrate(db);
    coordinator = await openRunnerCoordinator({
      eventKey: Buffer.alloc(32, 7),
      ...options,
      db,
      port: runnerPort,
    });
    assert.deepEqual(await coordinator.helpers.result(first.command.id), result);
    assert.deepEqual((await call("/v1/helper-commands")).body.commands, []);
    observe("helper acknowledgments and immutable results survive coordinator reopen", true, {
      exactRetry: true,
      changedResultDenied: true,
      candidateDenied: true,
      persisted: true,
    });
    await advanceLinearSessionGeneration(sqliteDb(db), "session");
    assert.equal((await call(`/v1/helper-commands/${first.command.id}/lease`, {})).status, 409);
    assert.equal(
      (await call(`/v1/helper-commands/${first.command.id}/result`, result)).status,
      409,
    );
    await assert.rejects(coordinator.helpers.result(first.command.id), /authority changed/);
    coordinator.helpers.finish(first.command.id);
    observe("a newer Linear request fences the old helper and its result", true, {
      oldGeneration: first.command.sessionGeneration,
      leaseStatus: 409,
      resultStatus: 409,
    });
    const selected = await coordinator.helpers.dispatch({ ...input, purpose: "select_repository" });
    assert.equal(selected.command.sessionGeneration, 1);
    assert.equal(selected.command.purpose, "select_repository");
    const item = insertQueuedItem(db, { id: "task", sessionKey: "session", now });
    const { run } = beginImplementRun(db, item.id, now);
    bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
    const repository = {
      owner: "acme",
      repo: "app",
      remoteUrl: "https://github.com/acme/app.git",
      baseSha: "a".repeat(40),
    };
    bindWorkItemRepository(db, item.id, repository);
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [workspace.id, "acme/app", "team"]);
    const workCommand = {
      id: workspaceId(),
      runnerId: runnerId,
      workspaceId: workspace.id,
      issuedAt: now,
      expiresAt: now + 120_000,
      type: "run" as const,
      runId: run.id,
      itemId: item.id,
      generation: 1,
      repository,
      profile: input.profile,
      prompt: "Implement task",
    };
    await assert.rejects(coordinator.work.assign(workCommand), /occupied by active work/);
    coordinator.helpers.finish(selected.command.id);
    await coordinator.work.assign(workCommand);
    await assert.rejects(coordinator.helpers.dispatch(input), /busy/);
    await coordinator.work.finish(run.id, 1);
    observe("helper and repository execution cannot claim the same runner simultaneously", true, {
      helperThenRunDenied: true,
      runThenHelperDenied: true,
    });
    const stopped = await coordinator.helpers.dispatch(input);
    db.run("UPDATE linear_session SET stopped_at=? WHERE session_id=?", [now, "session"]);
    assert.equal((await call(`/v1/helper-commands/${stopped.command.id}/lease`, {})).status, 409);
    coordinator.helpers.finish(stopped.command.id);
    db.run("UPDATE linear_session SET stopped_at=NULL WHERE session_id=?", ["session"]);
    const expired = await coordinator.helpers.dispatch(input);
    now = expired.command.expiresAt;
    assert.equal((await call(`/v1/helper-commands/${expired.command.id}/lease`, {})).status, 409);
    assert.deepEqual((await call("/v1/helper-commands")).body.commands, []);
    coordinator.helpers.finish(expired.command.id);
    observe("Stop and exact helper expiry fence delivery and execution authority", true, {
      stopStatus: 409,
      expiryStatus: 409,
      durationMs: 60_000,
    });
    recordLinearInstallation(db, {
      organizationId: "other-org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId: "other-session",
      teamId: "team",
      observedAtMs: now,
    });
    await assert.rejects(
      coordinator.helpers.dispatch({ ...input, sessionId: "other-session" }),
      /authority changed/,
    );
    const fenced = await coordinator.helpers.dispatch(input);
    db.run("UPDATE runner SET fence=fence+1 WHERE id=?", [runnerId]);
    await assert.rejects(coordinator.helpers.result(fenced.command.id), /identity changed/);
    coordinator.helpers.finish(fenced.command.id);
    const removed = await coordinator.helpers.dispatch(input);
    db.run("UPDATE workspace_member SET active=0 WHERE workspace_id=? AND user_id=?", [
      workspace.id,
      userId,
    ]);
    await assert.rejects(
      coordinator.helpers.current(removed.command.id),
      /identity is unavailable/,
    );
    db.run("UPDATE workspace_member SET active=1 WHERE workspace_id=? AND user_id=?", [
      workspace.id,
      userId,
    ]);
    await assert.rejects(
      coordinator.helpers.current(removed.command.id),
      /identity is unavailable/,
    );
    observe(
      "workspace membership, organization and runner fences are rechecked for helper work",
      true,
      {
        wrongOrganizationDenied: true,
        removedMemberDenied: true,
        membershipRestorationDoesNotRestoreRunner: true,
        changedFenceDenied: true,
      },
    );
    coordinator.helpers.finish(removed.command.id);
    const replacement = await pair("Revoked helper runner", RUNNER_IDENTITIES[1]);
    const pending = await coordinator.helpers.dispatch({ ...input, runnerId: replacement });
    await coordinator.control.setStatus(principal, replacement, "revoked");
    await assert.rejects(
      coordinator.helpers.current(pending.command.id),
      /identity is unavailable/,
    );
    await assert.rejects(coordinator.helpers.commands(replacement), /identity is unavailable/);
    observe("administrative runner revocation prevents helper result acceptance", true, {
      revoked: true,
    });
    assert.deepEqual(errors, []);
  } finally {
    await coordinator.stop();
    db.close();
  }
}

if (import.meta.main) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "paws-session-helpers-"));
  const observations: unknown[] = [];
  await probeRunnerSessionHelpers(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  process.stdout.write(JSON.stringify({ root, observations: observations.length }) + "\n");
}
