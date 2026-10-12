import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../../src/db";
import { createRunnerControl } from "../../src/runner-control";
import { createRunnerHealth } from "../../src/runner-health";
import {
  createRunnerKey,
  initializeRunnerAuthority,
  startRunnerListener,
} from "../../src/runner-identity";
import {
  RunnerHealthResultSchema,
  RUNNER_RESULT_BODY_LIMIT,
  verifyRunnerCommand,
  type RunnerHealthResult,
} from "../../src/runner-protocol";
import { createRunnerWork } from "../../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerHealth(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "paws.sqlite");
  const db = openDatabase(path);
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "health-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "health-org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "health-org",
    name: "Fixture",
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
  const memberId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "health-member",
    name: "Member",
    email: "member@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: memberId,
    role: "member",
    active: true,
    teamIds: [],
    now,
  });
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  let listener: Awaited<ReturnType<typeof startRunnerListener>> | undefined;
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect: (fingerprint) => listener?.revoke(fingerprint),
    now: () => now,
  });
  const client = await createRunnerKey(join(root, "client"));
  const pairing = await control.beginPairing({ name: "Health proof", csr: client.csr });
  const { runnerId } = await control.approvePairing(principal, pairing.code);
  const identity = control.claimPairing(pairing.id, pairing.claim);
  assert.equal(identity.status, "approved");
  if (identity.status !== "approved") throw new Error("Expected approved fixture identity");
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "health-fixture",
    privateKey: signing.privateKey,
    now: () => now,
  });
  const health = createRunnerHealth({ db, work, now: () => now });
  const requestInput = {
    type: "probe" as const,
    profile: { agent: "codex" as const, model: null },
  };
  const keyPath = join(root, "server.key");
  const certPath = join(root, "server.pem");
  execFileSync(
    "/usr/bin/openssl",
    [
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
      "-sha256",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { env: { PATH: "/usr/bin:/bin", HOME: root }, stdio: "ignore" },
  );
  const server = { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  try {
    for (const actor of [
      { ...principal, userId: memberId },
      { ...principal, workspaceId: workspaceId() },
      { ...principal, authenticatedAt: now - 16 * 60_000 },
      { ...principal, authenticatedAt: now + 1 },
    ])
      assert.throws(() => health.request(actor, runnerId, requestInput));
    assert.throws(() =>
      health.request(principal, runnerId, { ...requestInput, extra: true } as never),
    );
    assert.equal(health.list({ ...principal, userId: memberId }, runnerId).checks.length, 0);
    const browserRequest = new Request(`https://localhost/api/runners/${runnerId}/health`);
    const browserResult = await health.browser(browserRequest, principal);
    assert.equal(browserResult?.status, 200);
    assert.equal(browserResult?.headers.get("cache-control"), "no-store");
    const memberWrite = await health.browser(
      new Request(browserRequest, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestInput),
      }),
      { ...principal, userId: memberId },
    );
    assert.equal(memberWrite?.status, 403);
    observe(
      "health administration uses current workspace membership and recent authentication",
      true,
      {
        deniedActors: 4,
        unknownRequestFieldDenied: true,
        memberRead: true,
      },
    );
    assert.equal(health.list(principal, runnerId).lastSeenAt, null);
    work.heartbeat(runnerId);
    assert.equal(health.list(principal, runnerId).lastSeenAt, now);
    now += 1000;
    work.heartbeat(runnerId);
    assert.equal(health.list(principal, runnerId).lastSeenAt, now);
    const pending = health.request(principal, runnerId, requestInput);
    const verified = verifyRunnerCommand(work.commands(runnerId)[0], {
      trustedKeys: new Map([["health-fixture", signing.publicKey]]),
      runnerId,
      workspaceId: workspace.id,
      now,
      allowedRepositories: [],
      claimCommand: () => true,
    });
    assert(verified.ok);
    assert.equal(verified.command.type, "probe");
    assert.equal(verified.command.id, pending.commandId);
    observe(
      "health commands are signed and authenticated heartbeats update persisted last-seen time",
      true,
      {
        commandId: pending.commandId,
        lastSeenAt: health.list(principal, runnerId).lastSeenAt,
      },
    );
    listener = await startRunnerListener({
      tls: { ...server, ca: authority.certificate },
      now: () => now,
      authorize(peer) {
        try {
          control.authenticate(peer);
          return true;
        } catch {
          return false;
        }
      },
      async fetch(input, peer) {
        return (
          (await health.fetch(input, control.authenticate(peer).id)) ??
          new Response(null, { status: 404 })
        );
      },
    });
    const clientKey = readFileSync(client.keyPath, "utf8");
    const clientCertificate = identity.certificate;
    assert(clientCertificate);
    function send(body: unknown, certificate: string | null = clientCertificate) {
      return new Promise<{ status: number; value: unknown }>((resolve, reject) => {
        const text = JSON.stringify(body);
        const outgoing = request(
          {
            hostname: "localhost",
            port: listener!.port,
            path: "/v1/health",
            ca: server.cert,
            ...(certificate ? { cert: certificate, key: clientKey } : {}),
            agent: false,
            method: "POST",
            timeout: 3000,
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(text)),
            },
          },
          (incoming) => {
            let value = "";
            incoming.on("data", (chunk) => (value += chunk));
            incoming.on("end", () =>
              resolve({ status: incoming.statusCode ?? 0, value: JSON.parse(value) }),
            );
            incoming.on("error", reject);
          },
        );
        outgoing.on("error", reject);
        outgoing.on("timeout", () => outgoing.destroy(new Error("Fixture request timed out")));
        outgoing.end(text);
      });
    }
    const result: RunnerHealthResult = {
      commandId: pending.commandId,
      executionId: workspaceId(),
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      models: [{ id: "scripted-model", name: "Scripted model" }],
    };
    assert.equal((await send(result)).status, 200);
    assert.deepEqual((await send(result)).value, { duplicate: true });
    const unicodeCommand = health.request(principal, runnerId, requestInput);
    const unicodeResult = {
      ...result,
      commandId: unicodeCommand.commandId,
      models: Array(128).fill({ id: "界".repeat(256), name: "界".repeat(256) }),
    };
    assert(RunnerHealthResultSchema.safeParse(unicodeResult).success);
    const unicodeBytes = Buffer.byteLength(JSON.stringify(unicodeResult));
    assert(unicodeBytes > 131_072 && unicodeBytes < RUNNER_RESULT_BODY_LIMIT);
    assert.equal((await send(unicodeResult)).status, 200);
    const escapedCommand = health.request(principal, runnerId, requestInput);
    const escapedResult = {
      ...result,
      commandId: escapedCommand.commandId,
      stopReason: "error" as const,
      sessionId: "\u0000".repeat(512),
      errorMessage: "\u0000".repeat(16384),
      identity: {
        session: "\u0000".repeat(512),
        model: "\u0000".repeat(512),
        provider: "\u0000".repeat(512),
      },
      models: Array(128).fill({ id: "\u0000".repeat(256), name: "\u0000".repeat(256) }),
      efforts: Array(32).fill({ id: "\u0000".repeat(64), name: "\u0000".repeat(256) }),
      effort: "\u0000".repeat(64),
    };
    assert(RunnerHealthResultSchema.safeParse(escapedResult).success);
    const escapedBytes = Buffer.byteLength(JSON.stringify(escapedResult));
    assert(escapedBytes > unicodeBytes && escapedBytes < RUNNER_RESULT_BODY_LIMIT);
    assert.equal((await send(escapedResult)).status, 200);
    assert.deepEqual((await send(escapedResult)).value, { duplicate: true });
    assert.equal((await send({ ...result, models: [] })).status, 403);
    assert.equal((await send({ ...result, commandId: workspaceId() })).status, 403);
    assert.throws(() => health.submit(workspaceId(), result));
    await assert.rejects(() => send(result, null));
    assert.equal((await send({ ...result, errorMessage: "x".repeat(131_072) })).status, 403);
    let pulls = 0;
    let cancelled = false;
    const oversized = new Request("https://runner.invalid/v1/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(600_000));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      duplex: "half",
    });
    assert.equal((await health.fetch(oversized, runnerId))!.status, 403);
    assert.equal(pulls, 2);
    assert(cancelled);
    assert(
      !RunnerHealthResultSchema.safeParse({ ...result, vendorCredential: "unwanted" }).success,
    );
    assert(
      !RunnerHealthResultSchema.safeParse({ ...result, candidateSha: "a".repeat(40) }).success,
    );
    assert(
      !RunnerHealthResultSchema.safeParse({
        ...result,
        models: Array(129).fill({ id: "x", name: "x" }),
      }).success,
    );
    assert.deepEqual(health.read(runnerId, pending.commandId), result);
    observe(
      "actual mTLS health delivery enforces immutable receipts, command binding and bounded public fields",
      true,
      {
        duplicate: true,
        changedDenied: true,
        missingCertificateDenied: true,
        boundedPayloadDenied: true,
        unicodeBytes,
        escapedBytes,
        resultBodyLimit: RUNNER_RESULT_BODY_LIMIT,
      },
    );
    const restarted = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        new URL("../fixtures/runner-health-restart.ts", import.meta.url).pathname,
        path,
        runnerId,
        pending.commandId,
        String(now),
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: root },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stdout, stderr] = await Promise.all([
      restarted.exited,
      new Response(restarted.stdout).text(),
      new Response(restarted.stderr).text(),
    ]);
    assert.equal(exit, 0, stderr);
    const recovered = JSON.parse(stdout) as { pid: number; result: RunnerHealthResult };
    assert.notEqual(recovered.pid, process.pid);
    assert.deepEqual(recovered.result, result);
    observe("a fresh process recovers the same persisted immutable health result", true, {
      childPid: recovered.pid,
      commandId: recovered.result.commandId,
    });
    const login = health.request(principal, runnerId, { type: "login_check", agent: "claude" });
    const loginResult = {
      ...result,
      commandId: login.commandId,
      login: { agent: "claude" as const, authenticated: true, method: "subscription" as const },
    };
    assert.throws(() =>
      health.submit(runnerId, { ...loginResult, login: { ...loginResult.login, agent: "codex" } }),
    );
    assert.throws(() => health.submit(runnerId, { ...loginResult, authRequired: true }));
    assert.throws(() =>
      health.submit(runnerId, { ...loginResult, login: { ...loginResult.login, method: "none" } }),
    );
    assert.throws(() => health.submit(runnerId, { ...result, login: loginResult.login }));
    health.submit(runnerId, loginResult);
    for (let count = 0; count < 4; count++) health.request(principal, runnerId, requestInput);
    assert.throws(() => health.request(principal, runnerId, requestInput));
    observe("login results match the signed agent and pending health commands are bounded", true, {
      loginAgent: "claude",
      contradictoryResultsDenied: 4,
      pendingLimit: 4,
    });
    now += 120_001;
    assert.throws(() => health.read(runnerId, pending.commandId));
    assert.equal((await send(result)).status, 403);
    const fresh = health.request(principal, runnerId, requestInput);
    control.setStatus(principal, runnerId, "revoked");
    assert.throws(() => health.submit(runnerId, { ...result, commandId: fresh.commandId }));
    assert.throws(() => health.read(runnerId, fresh.commandId));
    await assert.rejects(() => send({ ...result, commandId: fresh.commandId }));
    observe(
      "expired health commands and revoked runner identities cannot publish or recover results",
      true,
      {
        expiredDenied: true,
        revokedDenied: true,
      },
    );
  } finally {
    await listener?.stop();
    db.close();
  }
}
