import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
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
import { migrations } from "../../src/db/migrations";
import { readSecretFile } from "../../src/credentials";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon, RunnerRequestError } from "../../src/runner-daemon";
import { openRunnerAuthority, startRunnerListener } from "../../src/runner-identity";
import { createRunnerWorkHttp } from "../../src/runner-work";
import { createRunnerChecks, createRunnerChecksHttp } from "../../src/runner-checks";
import { runnerCheckInputHash, type RunnerCheckResult } from "../../src/runner-check";
import { signRunnerCommand, type RunnerCommand } from "../../src/runner-protocol";
import {
  runnerCheckResultSigningBytes,
  runnerVerifierFingerprint,
} from "../../src/runner-verifier";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerChecks(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const verifier = generateKeyPairSync("ed25519");
  const verifierPublicKeyPem = verifier.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const db = openDatabase(join(root, "paws.sqlite"));
  db.run("CREATE TABLE schema_migration(id TEXT PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT");
  for (const migration of migrations.slice(
    0,
    migrations.findIndex((entry) => entry.id === "035_runner_check_commands"),
  )) {
    if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys=OFF");
    db.transaction(() => {
      db.run(migration.sql);
      db.run("INSERT INTO schema_migration VALUES(?,?)", [migration.id, Date.now()]);
    }).immediate();
    if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys=ON");
  }
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
  const signingKeys = await initializeRunnerCoordinator(issuer);
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
  const checks = createRunnerChecks({ db, work: coordinator.work, now: () => now });
  const checksHttp = createRunnerChecksHttp(checks);
  const workHttp = createRunnerWorkHttp(coordinator.work);
  let loseResponse = "";
  let malformed: unknown;
  let requests = 0;
  const peers = new Set<string>();
  const listener = await startRunnerListener({
    tls: { ...tls, ca: openRunnerAuthority(issuer).certificate },
    authorize(peer) {
      try {
        coordinator.control.authenticate(peer);
        return true;
      } catch {
        return false;
      }
    },
    async fetch(request, peer) {
      requests++;
      peers.add(peer.fingerprint);
      const runnerId = coordinator.control.authenticate(peer).id;
      const response =
        (await checksHttp(request, runnerId)) ??
        (await workHttp(request, runnerId)) ??
        new Response(null, { status: 404 });
      if (malformed !== undefined) return Response.json(malformed);
      if (loseResponse === new URL(request.url).pathname) {
        loseResponse = "";
        return Response.json({ error: "Scripted lost receipt" }, { status: 503 });
      }
      return response;
    },
  });
  const options = {
    root: join(root, "daemon"),
    controlPlaneUrl: `https://localhost:${enrollment.port}`,
    runnerApiUrl: `https://localhost:${listener.port}`,
    serverCa: tls.cert,
    allowedRepositories: ["fixture/repository"],
    verifierPublicKeyPem,
    now: () => now,
  };
  let daemon = openRunnerDaemon(options);
  const statusError = (status: number) => (error: unknown) =>
    error instanceof RunnerRequestError && error.status === status;
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
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    };
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "team",
    ]);
    const legacyCommand: RunnerCommand = {
      type: "probe",
      id: workspaceId(now),
      runnerId,
      workspaceId: workspace.id,
      issuedAt: now,
      expiresAt: now + 600_000,
      profile: { agent: "codex", model: "scripted" },
    };
    const legacyEnvelope = signRunnerCommand({
      keyId: signingKeys[0].keyId,
      privateKey: createPrivateKey(readSecretFile(join(issuer, "runner-command-key.pem"))!),
      command: legacyCommand,
    });
    db.run("INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at) VALUES(?,?,?,?,?)", [
      legacyCommand.id,
      runnerId,
      "probe",
      JSON.stringify(legacyEnvelope),
      legacyCommand.expiresAt,
    ]);
    const retainedCommands = db.query("SELECT * FROM runner_command ORDER BY ordinal").all();
    db.run("UPDATE sqlite_sequence SET seq=1000 WHERE name='runner_command'");
    migrate(db);
    assert.deepEqual(
      db.query("SELECT * FROM runner_command ORDER BY ordinal").all(),
      retainedCommands,
    );
    assert.equal(
      db
        .query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name='runner_command'")
        .get()?.seq,
      1000,
    );
    assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), []);
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
    bindWorkItemRepository(db, item.id, repository);
    async function dispatch(attempt = workspaceId(now)) {
      const assigned = checks.dispatch({
        runnerId,
        runId: run.id,
        verificationAttemptId: attempt,
        candidateSha: repository.baseSha,
        checkoutExclusions: ["large"],
        argv: ["/usr/bin/true"],
        cwd: ".",
        timeoutMs: 900_000,
      });
      const pending = (await daemon.pollCommands()).commands;
      const command = pending.find(
        (value) => value.type === "check" && value.executionId === assigned.input.executionId,
      );
      assert(command?.type === "check");
      assert.equal(command.repository.baseSha, command.candidateSha);
      assert.deepEqual(command.repository.checkoutExclusions, ["large"]);
      assert.deepEqual(assigned.input.checkoutExclusions, ["large"]);
      const grant = await daemon.issueRunGrant(run.id, {
        commandId: command.id,
        generation: command.generation,
      });
      const result: RunnerCheckResult = {
        format: 1,
        executionId: command.executionId,
        verificationAttemptId: attempt,
        candidateSha: repository.baseSha,
        inputSha256: runnerCheckInputHash(assigned.input),
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Unicode 🐕\0",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
        dirty: false,
        headMoved: false,
      };
      return { command, grant, result };
    }
    const signature = (result: RunnerCheckResult) =>
      sign(null, runnerCheckResultSigningBytes(result), verifier.privateKey).toString("base64");
    const first = await dispatch();
    const send = (
      value: typeof first,
      result = value.result,
      proof = signature(result),
      token = value.grant.token,
    ) => daemon.postCheckResult(run.id, value.command.generation, result, proof, token);
    assert.throws(() =>
      checks.dispatch({
        runnerId,
        runId: run.id,
        verificationAttemptId: first.result.verificationAttemptId,
        candidateSha: repository.baseSha,
        checkoutExclusions: ["large"],
        argv: ["/usr/bin/true"],
        cwd: ".",
        timeoutMs: 1000,
      }),
    );
    await assert.rejects(
      send(first, first.result, Buffer.alloc(64).toString("base64")),
      statusError(409),
    );
    await assert.rejects(
      send(first, first.result, signature(first.result), "A".repeat(43)),
      statusError(403),
    );
    const beforeBinding = requests;
    for (const result of [
      { ...first.result, executionId: workspaceId(now) },
      { ...first.result, verificationAttemptId: workspaceId(now) },
      { ...first.result, candidateSha: "b".repeat(40) },
      { ...first.result, inputSha256: "0".repeat(64) },
    ])
      await assert.rejects(send(first, result));
    assert.equal(requests, beforeBinding);
    loseResponse = `/v1/runs/${run.id}/check-result`;
    await assert.rejects(send(first), statusError(503));
    daemon.close();
    daemon = openRunnerDaemon(options);
    assert.deepEqual(await send(first), { duplicate: true });
    assert.deepEqual(checks.result(first.result.executionId)?.result, first.result);
    const changed = { ...first.result, dirty: true };
    await assert.rejects(send(first, changed), statusError(409));
    observe(
      "enrolled verifier signatures and canonical command bindings survive lost receipt and daemon reopen",
      true,
      {
        lostReceipt: 503,
        immutableMutation: 409,
        localBindingRefusals: 4,
        preservedPreCheckCommands: retainedCommands.length,
        preservedQueueHighWater: 1000,
        verifiedMtlsPeers: peers.size,
      },
    );
    for (const response of [{ duplicate: true, extra: true }, { duplicate: "yes" }]) {
      malformed = response;
      await assert.rejects(send(first));
    }
    malformed = undefined;
    assert.throws(() =>
      checks.dispatch({
        runnerId,
        runId: run.id,
        verificationAttemptId: first.result.verificationAttemptId,
        candidateSha: repository.baseSha,
        checkoutExclusions: ["different"],
        argv: ["/usr/bin/true"],
        cwd: ".",
        timeoutMs: 1000,
      }),
    );
    const second = await dispatch(first.result.verificationAttemptId);
    assert(second.command.generation > first.command.generation);
    assert.deepEqual(await send(first), { duplicate: true });
    assert.equal(
      coordinator.work.current(run.id, second.command.generation).command.id,
      second.command.id,
    );
    const maximal = {
      ...second.result,
      stdout: "\0".repeat(1_048_576),
      stderr: "\0".repeat(1_048_576),
    };
    const bytes = Buffer.byteLength(
      JSON.stringify({
        generation: second.command.generation,
        result: maximal,
        verifierSignature: signature(maximal),
      }),
    );
    assert(bytes > 12 * 1024 * 1024 && bytes < 13 * 1024 * 1024);
    assert.deepEqual(await send(second, maximal), { duplicate: false });
    assert.deepEqual(checks.result(second.result.executionId)?.result, maximal);
    let canceled = false;
    const oversized = new Request(`https://localhost/v1/runs/${run.id}/check-result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${second.grant.token}`,
      },
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(7 * 1024 * 1024));
        },
        cancel() {
          canceled = true;
        },
      }),
      duplex: "half",
    } as RequestInit);
    assert.equal((await checksHttp(oversized, runnerId))?.status, 403);
    assert(canceled);
    const paired = JSON.parse(readSecretFile(join(options.root, "identity/state.json"))!);
    async function rawRequest(path: string, size: number) {
      return new Promise<number>((resolve, reject) => {
        const request = httpsRequest(
          new URL(path, options.runnerApiUrl),
          {
            method: "POST",
            ca: tls.cert,
            cert: paired.certificate,
            key: readSecretFile(join(options.root, "identity/runner-key.pem"))!,
            headers: { "content-type": "application/json", "content-length": size },
            agent: false,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        request.once("error", reject);
        request.setTimeout(5000, () => request.destroy(new Error("Body budget proof timed out")));
        request.end(Buffer.alloc(size));
      });
    }
    assert.equal(await rawRequest(`/v1/runs/${run.id}/check-result`, 14 * 1024 * 1024), 413);
    assert.equal(await rawRequest("/v1/heartbeat", 2 * 1024 * 1024), 413);
    observe(
      "maximally escaped bounded output crosses mTLS while oversized streams cancel at the route budget",
      true,
      { serializedBytes: bytes, limitBytes: 13 * 1024 * 1024, oversizedStatus: 403, canceled },
    );
    const third = await dispatch();
    now += 60_001;
    await assert.rejects(send(third), statusError(409));
    const fourth = await dispatch();
    await assert.rejects(send(third), statusError(409));
    checks.cancel(fourth.result.executionId);
    await assert.rejects(send(fourth), statusError(409));
    assert.equal(checks.result(third.result.executionId), null);
    assert.equal(checks.result(fourth.result.executionId), null);
    now += 600_001;
    await assert.rejects(send(first), statusError(409));
    coordinator.control.setStatus(principal, runnerId, "revoked");
    await assert.rejects(send(second, maximal));
    observe(
      "expired leases, newer generations, cancellation, receipt expiry and revoked identities reject result publication",
      true,
      {
        expiredLease: 409,
        oldGeneration: 409,
        canceled: 409,
        expiredReceipt: 409,
        revokedRejected: true,
      },
    );
  } finally {
    daemon.close();
    await listener.stop();
    await enrollment.stop(true);
    await coordinator.stop();
    db.close();
  }
}
