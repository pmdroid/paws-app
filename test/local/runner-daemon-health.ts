import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consumeWorkspaceBootstrap, migrate, openDatabase, putWorkspaceUser } from "../../src/db";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon, RunnerRequestError } from "../../src/runner-daemon";
import type { RunnerHealthResult } from "../../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerDaemonHealth(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const identity = join(root, "identity");
  await initializeRunnerCoordinator(identity);
  const keyPath = join(root, "server.key");
  const certPath = join(root, "server.pem");
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
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { env: { PATH: "/usr/bin:/bin", HOME: root }, stdout: "ignore", stderr: "pipe" },
  );
  assert.equal(generated.exitCode, 0, generated.stderr.toString());
  chmodSync(keyPath, 0o600);
  const tls = { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  const dbPath = join(root, "paws.db");
  let db = openDatabase(dbPath);
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
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const errors: unknown[] = [];
  const options = {
    root: identity,
    tls,
    hostname: "127.0.0.1",
    onError: (error: unknown) => errors.push(error),
  };
  let coordinator = await openRunnerCoordinator({ ...options, db, port: 0 });
  const runnerPort = coordinator.port;
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch: (input) => coordinator.enrollment(input),
  });
  const daemonOptions = {
    root: join(root, "daemon"),
    controlPlaneUrl: `https://127.0.0.1:${browser.port}`,
    runnerApiUrl: `https://127.0.0.1:${runnerPort}`,
    serverCa: tls.cert,
    allowedRepositories: [],
  };
  let daemon = openRunnerDaemon(daemonOptions);
  try {
    const pairing = await daemon.beginPairing("Health runner");
    assert.equal(pairing.phase, "pending");
    if (pairing.phase !== "pending") throw new Error("Missing pairing challenge");
    await coordinator.control.approvePairing(principal, pairing.code);
    const paired = await daemon.pollPairing();
    assert.equal(paired.phase, "paired");
    if (paired.phase !== "paired") throw new Error("Missing runner identity");
    const command = coordinator.health.request(principal, paired.runnerId, {
      type: "probe",
      profile: { agent: "codex", model: null },
    });
    const polled = await daemon.pollCommands();
    assert.equal(polled.rejected.length, 0);
    assert(
      polled.commands.some((entry) => entry.id === command.commandId && entry.type === "probe"),
    );
    const result: RunnerHealthResult = {
      executionId: workspaceId(),
      commandId: command.commandId,
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      models: [{ id: "scripted", name: "Scripted" }],
    };
    assert.deepEqual(await daemon.postHealth(result), { duplicate: false });
    assert.deepEqual(await daemon.postHealth(result), { duplicate: true });
    assert.deepEqual(coordinator.health.read(paired.runnerId, command.commandId), result);
    observe(
      "daemon validates signed health commands and delivers immutable results over real mTLS",
      true,
      {
        signedCommandVerified: true,
        firstDuplicate: false,
        retryDuplicate: true,
        persisted: true,
      },
    );
    await assert.rejects(daemon.postHealth({ ...result, agentExited: false }), RunnerRequestError);
    const login = coordinator.health.request(principal, paired.runnerId, {
      type: "login_check",
      agent: "codex",
    });
    await daemon.pollCommands();
    const loginResult: RunnerHealthResult = {
      ...result,
      executionId: workspaceId(),
      commandId: login.commandId,
      login: { agent: "codex", authenticated: false, method: "none" },
    };
    assert.deepEqual(await daemon.postHealth(loginResult), { duplicate: false });
    assert.deepEqual(coordinator.health.read(paired.runnerId, login.commandId), loginResult);
    observe(
      "daemon delivers command-bound login status without accepting a changed health result",
      true,
      {
        loginStored: true,
        changedReceiptRejected: true,
      },
    );
    let requests = 0;
    let override: unknown;
    const originalFetch = coordinator.health.fetch;
    coordinator.health.fetch = async (request, runnerId) => {
      requests++;
      return override === undefined ? originalFetch(request, runnerId) : Response.json(override);
    };
    await assert.rejects(
      daemon.postHealth({ ...result, models: [{ id: "x".repeat(257), name: "Invalid" }] }),
    );
    assert.equal(requests, 0);
    override = { duplicate: "false" };
    await assert.rejects(daemon.postHealth(result));
    override = { duplicate: false, token: "unexpected" };
    await assert.rejects(daemon.postHealth(result));
    coordinator.health.fetch = originalFetch;
    observe(
      "daemon rejects invalid outbound health data and malformed authenticated receipts",
      true,
      {
        invalidDataRequests: 0,
        wrongReceiptTypeRejected: true,
        extraReceiptFieldRejected: true,
      },
    );
    daemon.close();
    await coordinator.stop();
    db.close();
    db = openDatabase(dbPath);
    migrate(db);
    coordinator = await openRunnerCoordinator({ ...options, db, port: runnerPort });
    daemon = openRunnerDaemon(daemonOptions);
    assert.deepEqual(await daemon.postHealth(result), { duplicate: true });
    assert.deepEqual(coordinator.health.read(paired.runnerId, login.commandId), loginResult);
    coordinator.control.setStatus(principal, paired.runnerId, "revoked");
    await assert.rejects(daemon.postHealth(result));
    assert.equal(errors.length, 0);
    observe(
      "health receipts survive reopened daemon and coordinator identities and reject revoked peers",
      true,
      {
        duplicateAfterReopen: true,
        loginAfterReopen: true,
        revokedPeerDenied: true,
      },
    );
  } finally {
    daemon.close();
    await browser.stop(true);
    await coordinator.stop();
    db.close();
  }
}
