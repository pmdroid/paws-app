import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
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
} from "../../src/db";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon } from "../../src/runner-daemon";
import { runnerCheckInputHash, type RunnerCheckResult } from "../../src/runner-check";
import {
  runnerCheckResultSigningBytes,
  runnerVerifierFingerprint,
} from "../../src/runner-verifier";
import { createRemoteAgentRunner } from "../../src/runner-backend";
import { setTimeout as delay } from "node:timers/promises";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerTrustedCloseout(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const verifier = generateKeyPairSync("ed25519");
  const verifierPublicKeyPem = verifier.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "relay-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "relay-org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "relay-org",
    name: "Relay",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const key = join(root, "server.key");
  const cert = join(root, "server.pem");
  const generated = Bun.spawnSync(
    [
      "/usr/bin/openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdout: "ignore", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: root } },
  );
  assert.equal(generated.exitCode, 0, generated.stderr.toString());
  const tls = { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  const issuer = join(root, "issuer");
  await initializeRunnerCoordinator(issuer);
  const coordinator = await openRunnerCoordinator({
    db,
    root: issuer,
    tls,
    port: 0,
    now: () => now,
    onError(error) {
      throw error;
    },
  });
  now = Date.now();
  const enrollment = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch: (request) => coordinator.enrollment(request),
  });
  const options = {
    root: join(root, "daemon"),
    controlPlaneUrl: `https://localhost:${enrollment.port}`,
    runnerApiUrl: `https://localhost:${coordinator.port}`,
    serverCa: tls.cert,
    allowedRepositories: ["fixture/repository"],
    verifierPublicKeyPem,
    now: () => now,
  };
  let daemon = openRunnerDaemon(options);
  try {
    const pairing = await daemon.beginPairing("Evidence relay");
    assert(pairing.phase === "pending");
    const { runnerId } = await coordinator.control.approvePairing(
      principal,
      pairing.code,
      runnerVerifierFingerprint(verifierPublicKeyPem),
    );
    now = Date.now();
    assert.equal((await daemon.pollPairing()).phase, "paired");
    const item = insertQueuedItem(db, { id: "relay-item", now, sessionKey: "relay-session" });
    const { run } = beginImplementRun(db, item.id, now);
    recordLinearInstallation(db, {
      organizationId: "relay-org",
      oauthClientId: "fixture",
      appUserId: "app",
      sessionId: "relay-session",
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "relay-session", item.epicId, { actorId: "relay-owner" });
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    };
    bindWorkItemRepository(db, item.id, repository);
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "team",
    ]);
    const backend = createRemoteAgentRunner({
      db,
      work: coordinator.work,
      results: coordinator.results,
      health: coordinator.health,
      checks: coordinator.checks,
      now: () => now,
      pollIntervalMs: 1,
      async fetchCandidate() {
        throw new Error("Unexpected candidate import");
      },
    });
    const seen = new Set<string>();
    const executions: { attempt: string; candidate: string; generation: number }[] = [];
    async function next() {
      for (let retry = 0; retry < 100; retry++) {
        const pending = (await daemon.pollCommands()).commands;
        const command = pending.find((value) => value.type === "check" && !seen.has(value.id));
        if (command?.type === "check") {
          seen.add(command.id);
          return command;
        }
        await delay(5);
      }
      throw new Error("Trusted check was not dispatched");
    }
    async function deliver(change: Partial<RunnerCheckResult> = {}, invalid = false) {
      const command = await next();
      const grant = await daemon.issueRunGrant(run.id, {
        commandId: command.id,
        generation: command.generation,
      });
      const execution = db
        .query<{ payload: string }, [string]>(
          "SELECT input AS payload FROM runner_check_execution WHERE id=?",
        )
        .get(command.executionId)!;
      const input = JSON.parse(execution.payload);
      const result: RunnerCheckResult = {
        format: 1,
        executionId: command.executionId,
        verificationAttemptId: command.verificationAttemptId,
        candidateSha: command.candidateSha,
        inputSha256: runnerCheckInputHash(input),
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Trusted production route\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
        dirty: false,
        headMoved: false,
        ...change,
      };
      const signature = sign(
        null,
        runnerCheckResultSigningBytes(result),
        verifier.privateKey,
      ).toString("base64");
      if (invalid)
        await assert.rejects(
          daemon.postCheckResult(
            run.id,
            command.generation,
            result,
            Buffer.alloc(64).toString("base64"),
            grant.token,
          ),
        );
      const posted = await daemon.postCheckResult(
        run.id,
        command.generation,
        result,
        signature,
        grant.token,
      );
      assert.equal(posted.duplicate, false);
      executions.push({
        attempt: command.verificationAttemptId,
        candidate: command.candidateSha,
        generation: command.generation,
      });
      return { command, result };
    }
    const gate = backend.closeoutForItem(item.id);
    async function execute(
      name: string,
      change: Partial<RunnerCheckResult> = {},
      invalid = false,
      candidate = repository.baseSha,
    ) {
      db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now, runnerId]);
      const logFile = join(root, `evidence/${name}.log`);
      const promise = gate.runLogged({
        argv: ["/usr/bin/true", name],
        cwd: root,
        expectedHead: candidate,
        timeoutSeconds: 5,
        logFile,
        artifactPath: `${name}.log`,
      });
      const delivered = await deliver(change, invalid);
      const value = await promise;
      assert.equal(value.dirty, change.dirty ?? false);
      assert.equal(value.headMoved, change.headMoved ?? false);
      assert.equal(value.timedOut, change.timedOut ?? false);
      assert.equal(value.exitCode, change.exitCode ?? 0);
      assert(existsSync(logFile));
      return delivered;
    }
    await execute("setup", {}, true);
    const competitor = insertQueuedItem(db, {
      id: "competing-item",
      now,
      sessionKey: "competing-session",
    });
    beginImplementRun(db, competitor.id, now);
    recordLinearInstallation(db, {
      organizationId: "relay-org",
      oauthClientId: "fixture",
      appUserId: "app",
      sessionId: "competing-session",
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "competing-session", competitor.epicId, { actorId: "relay-owner" });
    bindWorkItemRepository(db, competitor.id, repository);
    const competingController = new AbortController();
    const competing = backend.forItem(competitor.id)({
      profile: { agent: "codex", model: null },
      role: "implementer",
      itemId: competitor.id,
      runId: "competing-output",
      worktreePath: root,
      pawsRoot: root,
      prompt: "Prepare",
      prepareOnly: true,
      signal: competingController.signal,
    });
    const competingStopped = assert.rejects(competing);
    for (
      let retry = 0;
      retry < 100 &&
      !(await daemon.pollCommands()).commands.some((value) => value.type === "probe");
      retry++
    )
      await delay(1);
    const waitingCheck = execute("check", {
      dirty: true,
      headMoved: true,
      timedOut: true,
      exitCode: 2,
    });
    const waitingObserved = waitingCheck.then(
      () => "completed",
      () => "rejected",
    );
    assert.equal(await Promise.race([waitingObserved, delay(20).then(() => "waiting")]), "waiting");
    competingController.abort();
    await competingStopped;
    await waitingCheck;
    observe(
      "A competing item temporarily occupying the preferred runner does not fail the same candidate attempt",
      true,
      { boundedWait: true, competingStopped: true },
    );
    assert.equal(executions[0]!.attempt, executions[1]!.attempt);
    assert(executions[1]!.generation > executions[0]!.generation);
    for (const busyMode of ["abort", "timeout", "fence"] as const) {
      const queuedController = new AbortController();
      const queueStarted = performance.now();
      const queued = backend.closeoutForItem(item.id, queuedController.signal);
      const primed = queued.runLogged({
        argv: ["/usr/bin/true"],
        cwd: root,
        expectedHead: repository.baseSha,
        timeoutSeconds: 5,
        logFile: join(root, `prime-${busyMode}.log`),
        artifactPath: `prime-${busyMode}.log`,
      });
      await deliver();
      await primed;
      const blockerController = new AbortController();
      const blocker = backend.forItem(competitor.id)({
        profile: { agent: "codex", model: null },
        role: "implementer",
        itemId: competitor.id,
        runId: `blocker-${busyMode}`,
        worktreePath: root,
        pawsRoot: root,
        prompt: "Prepare",
        prepareOnly: true,
        signal: blockerController.signal,
      });
      const blockerStopped = assert.rejects(blocker);
      await delay(5);
      const deniedLog = join(root, `waiting-${busyMode}.log`);
      const waiting = queued.runLogged({
        argv: ["/usr/bin/true"],
        cwd: root,
        expectedHead: repository.baseSha,
        timeoutSeconds: busyMode === "timeout" ? 0.02 : 5,
        logFile: deniedLog,
        artifactPath: `waiting-${busyMode}.log`,
      });
      const deniedWait = assert.rejects(
        waiting,
        busyMode === "abort"
          ? /aborted|Queue cancelled/
          : busyMode === "fence"
            ? /authority changed/
            : /No available paired runner/,
      );
      if (busyMode === "abort") queuedController.abort(new Error("Queue cancelled"));
      if (busyMode === "fence") db.run("UPDATE runner SET fence=fence+1 WHERE id=?", [runnerId]);
      await deniedWait;
      assert(performance.now() - queueStarted < 2000);
      assert(!existsSync(deniedLog));
      blockerController.abort();
      await blockerStopped;
      observe(
        `Preferred runner busy waiting rejects ${busyMode} without trusted evidence or capacity leakage`,
        true,
        { logCreated: false },
      );
    }
    await execute("changed-candidate", {}, false, "b".repeat(40));
    assert.notEqual(executions[1]!.attempt, executions[executions.length - 1]!.attempt);
    observe(
      "Production coordinator mTLS verifies root-approved signatures and reuses candidate attempts across setup and checks",
      true,
      { executions, invalidSignatureRejected: true, gateFlagsPreserved: true },
    );
    for (const mode of ["abort", "generation", "revoke"] as const) {
      db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now, runnerId]);
      const controller = new AbortController();
      const blocked = backend.closeoutForItem(item.id, controller.signal).runLogged({
        argv: ["/usr/bin/true"],
        cwd: root,
        expectedHead: repository.baseSha,
        timeoutSeconds: 5,
        logFile: join(root, mode + ".log"),
        artifactPath: mode + ".log",
      });
      const rejected = assert.rejects(blocked);
      const command = await next();
      if (mode === "abort") controller.abort(new Error("Fixture cancellation"));
      else if (mode === "generation")
        db.run("UPDATE runner_work SET generation=generation+1 WHERE run_id=?", [run.id]);
      else coordinator.control.setStatus(principal, runnerId, "revoked");
      await rejected;
      assert(!existsSync(join(root, mode + ".log")));
      const state = db
        .query<{ ended: number | null }, [string]>(
          "SELECT ended_at AS ended FROM runner_work WHERE run_id=?",
        )
        .get(run.id)!;
      const execution = db
        .query<{ cancelled: number | null }, [string]>(
          "SELECT cancelled_at AS cancelled FROM runner_check_execution WHERE id=?",
        )
        .get(command.executionId)!;
      assert(execution.cancelled !== null);
      if (mode === "generation") {
        assert.equal(state.ended, null);
        db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [now, run.id]);
      } else assert(state.ended !== null, mode);
      observe(`Trusted verification ${mode} refuses evidence and cancels its own execution`, true, {
        generation: command.generation,
        logCreated: false,
      });
    }
  } finally {
    daemon.close();
    await enrollment.stop(true);
    await coordinator.stop();
    db.close();
  }
}
