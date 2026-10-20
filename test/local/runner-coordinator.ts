import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { Agent, request } from "node:https";
import type { Socket } from "node:net";
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
  syncWorkspaceMember,
} from "../../src/db";
import { createRunnerKey } from "../../src/runner-identity";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { verifyRunnerCommand, type SignedRunnerCommand } from "../../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerCoordinator(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const identityRoot = join(root, "identity");
  const initialized = await initializeRunnerCoordinator(identityRoot);
  assert.equal(initialized.length, 1);
  assert.equal(statSync(identityRoot).mode & 0o777, 0o700);
  assert.equal(statSync(join(identityRoot, "runner-command-key.pem")).mode & 0o777, 0o600);
  assert(
    !readFileSync(join(identityRoot, "runner-command-key.pem"), "utf8").includes("PRIVATE KEY"),
  );
  await assert.rejects(initializeRunnerCoordinator(identityRoot));
  observe(
    "explicit initialization creates encrypted exclusive issuer and command identities",
    true,
    {
      directoryMode: "0700",
      keyMode: "0600",
      duplicateInitializationDenied: true,
    },
  );
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "coordinator-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "coordinator-org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "coordinator-org",
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
  const serverKey = join(root, "server.key");
  const serverCert = join(root, "server.pem");
  const openssl = Bun.spawn(
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
      serverKey,
      "-out",
      serverCert,
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
    {
      env: { PATH: "/usr/bin:/bin", HOME: root },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  assert.equal(await openssl.exited, 0);
  const tls = { key: readFileSync(serverKey, "utf8"), cert: readFileSync(serverCert, "utf8") };
  const errors: unknown[] = [];
  const memberId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "member",
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
  const member = { ...principal, userId: memberId, role: "member" as const };
  const options = {
    db,
    root: identityRoot,
    tls,
    port: 0,
    onError: (error: unknown) => errors.push(error),
  };
  await assert.rejects(openRunnerCoordinator({ ...options, root: join(root, "missing") }));
  let coordinator = await openRunnerCoordinator(options);
  assert.deepEqual(coordinator.signingKeys, initialized);
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    async fetch(input) {
      if (new URL(input.url).pathname === "/api/runner-pairings")
        return coordinator.enrollment(input);
      return (await coordinator.browser(input, principal)) ?? new Response(null, { status: 404 });
    },
  });
  let keepAlive: Agent | undefined;
  try {
    const client = await createRunnerKey(join(root, "client"));
    const pairing = await exchange<{ id: string; claim: string; code: string }>(
      browser.port!,
      "/api/runner-pairings",
      tls.cert,
      {
        name: "Fixture VM",
        csr: client.csr,
      },
    );
    const pending = await exchange(browser.port!, "/api/runner-pairings", tls.cert, {
      id: pairing.id,
      claim: pairing.claim,
    });
    assert.equal(pending.status, "pending");
    assert(!("signingKeys" in pending));
    await exchange(browser.port!, "/api/runners/pairings/approve", tls.cert, {
      code: pairing.code,
    });
    const identity = await exchange<{
      certificate: string;
      runnerId: string;
      workspaceId: string;
      signingKeys: unknown;
    }>(browser.port!, "/api/runner-pairings", tls.cert, {
      id: pairing.id,
      claim: pairing.claim,
    });
    assert.deepEqual(identity.signingKeys, initialized);
    assert(!JSON.stringify(identity).includes("PRIVATE KEY"));
    const peer = { cert: identity.certificate, key: readFileSync(client.keyPath, "utf8") };
    const renewed = await exchange(
      coordinator.port,
      "/v1/certificate",
      tls.cert,
      { csr: client.csr },
      peer,
    );
    assert.deepEqual(renewed.signingKeys, initialized);
    observe(
      "verified HTTPS pairing and actual mTLS renewal advertise only the persistent public command key",
      true,
      {
        keyId: initialized[0].keyId,
        pendingHasNoKeys: true,
        renewalHasSamePublicKey: true,
      },
    );
    const memberPairing = await coordinator.control.beginPairing({
      name: "Member transport",
      csr: client.csr,
    });
    await coordinator.control.approvePairing(member, memberPairing.code);
    const memberClaim = coordinator.control.claimPairing(memberPairing.id, memberPairing.claim);
    assert.equal(memberClaim.status, "approved");
    if (memberClaim.status !== "approved") throw new Error("Member identity missing");
    const memberPeer = { cert: memberClaim.certificate, key: peer.key };
    const memberAgent = new Agent({ keepAlive: true, maxSockets: 1, ca: tls.cert, ...memberPeer });
    let memberSocket: Socket | undefined;
    memberAgent.on("free", (socket: Socket) => {
      memberSocket = socket;
    });
    try {
      await exchange(
        coordinator.port,
        "/v1/commands",
        tls.cert,
        undefined,
        memberPeer,
        undefined,
        memberAgent,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert(memberSocket && !memberSocket.destroyed);
      const demotedAt = Date.now();
      syncWorkspaceMember(db, {
        workspaceId: workspace.id,
        userId: memberId,
        role: "observer",
        active: true,
        teamIds: [],
        now: demotedAt,
      });
      await assert.rejects(
        exchange(coordinator.port, "/v1/commands", tls.cert, undefined, memberPeer),
      );
      await assert.rejects(
        exchange(coordinator.port, "/v1/certificate", tls.cert, { csr: client.csr }, memberPeer),
      );
      while (!memberSocket.destroyed && Date.now() - demotedAt < 4500) await Bun.sleep(25);
      assert(memberSocket.destroyed);
      await assert.rejects(
        exchange(coordinator.port, "/v1/commands", tls.cert, undefined, memberPeer),
      );
      syncWorkspaceMember(db, {
        workspaceId: workspace.id,
        userId: memberId,
        role: "member",
        active: true,
        teamIds: [],
        now: Date.now() + 1,
      });
      await exchange(coordinator.port, "/v1/commands", tls.cert, undefined, memberPeer);
      const memberRenewed = await exchange<{ certificate: string }>(
        coordinator.port,
        "/v1/certificate",
        tls.cert,
        { csr: client.csr },
        memberPeer,
      );
      await exchange(coordinator.port, "/v1/commands", tls.cert, undefined, {
        ...memberPeer,
        cert: memberRenewed.certificate,
      });
    } finally {
      memberAgent.destroy();
    }
    observe(
      "production coordinator refuses observer reconnect and renewal before restoration without restart",
      true,
      {
        observerReconnectDenied: true,
        observerRenewalDenied: true,
        liveSocketClosed: true,
        restoredReconnect: true,
        restoredRenewal: true,
      },
    );
    const item = insertQueuedItem(db, {
      id: "coordinator-item",
      now,
      sessionKey: "coordinator-session",
    });
    const { run } = beginImplementRun(db, item.id, now);
    recordLinearInstallation(db, {
      organizationId: "coordinator-org",
      oauthClientId: "fixture-app",
      appUserId: "fixture-app-user",
      sessionId: "coordinator-session",
      teamId: "fixture-team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "coordinator-session", item.delegationId);
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
      "fixture-team",
    ]);
    coordinator.work.assign({
      id: workspaceId(),
      type: "run",
      runnerId: identity.runnerId,
      workspaceId: workspace.id,
      runId: run.id,
      itemId: item.id,
      generation: 1,
      issuedAt: now,
      expiresAt: now + 300_000,
      repository,
      profile: { agent: "codex", model: "scripted" },
      prompt: "Implement fixture.",
    });
    const commands = await exchange<{ commands: SignedRunnerCommand[] }>(
      coordinator.port,
      "/v1/commands",
      tls.cert,
      undefined,
      peer,
    );
    assert.equal(commands.commands.length, 1);
    const verified = verifyRunnerCommand(commands.commands[0], {
      trustedKeys: new Map([[initialized[0].keyId, createPublicKey(initialized[0].publicKeyPem)]]),
      runnerId: identity.runnerId,
      workspaceId: workspace.id,
      now: Date.now(),
      allowedRepositories: ["fixture/repository"],
      claimCommand: () => true,
    });
    assert(verified.ok);
    const command = verified.command;
    const firstPort = coordinator.port;
    await coordinator.stop();
    coordinator = await openRunnerCoordinator({ ...options, port: firstPort });
    assert.deepEqual(coordinator.signingKeys, initialized);
    assert.equal(
      (
        await exchange<{ commands: SignedRunnerCommand[] }>(
          coordinator.port,
          "/v1/commands",
          tls.cert,
          undefined,
          peer,
        )
      ).commands.length,
      1,
    );
    observe("reopening preserves signing keys and durable command delivery over mTLS", true, {
      keyId: initialized[0].keyId,
      samePort: coordinator.port === firstPort,
    });
    const heartbeat = await exchange<{ leases: { runId: string }[] }>(
      coordinator.port,
      "/v1/heartbeat",
      tls.cert,
      {},
      peer,
    );
    assert.equal(heartbeat.leases[0]?.runId, run.id);
    const grant = await exchange<{ token: string }>(
      coordinator.port,
      `/v1/runs/${run.id}/grant`,
      tls.cert,
      { commandId: command.id, generation: 1 },
      peer,
    );
    const result = {
      executionId: workspaceId(),
      commandId: command.id,
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      candidateSha: "b".repeat(40),
    };
    const resultPath = `/v1/runs/${run.id}/result`;
    await assert.rejects(
      exchange(
        coordinator.port,
        resultPath,
        tls.cert,
        { generation: 1, result },
        peer,
        "x".repeat(43),
      ),
      /HTTP 403/,
    );
    await assert.rejects(
      exchange(
        coordinator.port,
        resultPath,
        tls.cert,
        { generation: 2, result },
        peer,
        grant.token,
      ),
      /HTTP 409/,
    );
    assert.equal(
      (
        await exchange(
          coordinator.port,
          resultPath,
          tls.cert,
          { generation: 1, result },
          peer,
          grant.token,
        )
      ).duplicate,
      false,
    );
    assert.equal(
      (
        await exchange(
          coordinator.port,
          resultPath,
          tls.cert,
          { generation: 1, result },
          peer,
          grant.token,
        )
      ).duplicate,
      true,
    );
    assert.equal(
      db.query<{ status: string }, [string]>("SELECT status FROM run WHERE id=?").get(run.id)!
        .status,
      "active",
    );
    observe(
      "mTLS heartbeat and result routes preserve grants, generations and untrusted-result status",
      true,
      {
        wrongGrantDenied: true,
        staleGenerationDenied: true,
        replayAccepted: true,
        canonicalRunStatus: "active",
      },
    );
    const healthPath = `/api/runners/${identity.runnerId}/health`;
    const healthRequest = new Request(`https://localhost${healthPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "probe", profile: { agent: "codex", model: null } }),
    });
    assert.equal(
      (
        await coordinator.browser(
          new Request(healthRequest.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "probe", profile: { agent: "codex", model: null } }),
          }),
          member,
        )
      )?.status,
      403,
    );
    const pendingHealth = await coordinator.browser(healthRequest, principal);
    assert.equal(pendingHealth?.status, 200);
    const healthCommand = (await pendingHealth!.json()) as { commandId: string };
    const delivered = await exchange<{ commands: SignedRunnerCommand[] }>(
      coordinator.port,
      "/v1/commands",
      tls.cert,
      undefined,
      peer,
    );
    assert.equal(delivered.commands.length, 2);
    const healthResult = {
      ...result,
      commandId: healthCommand.commandId,
      models: [{ id: "scripted", name: "Scripted model" }],
    };
    delete (healthResult as { candidateSha?: string }).candidateSha;
    assert.equal(
      (await exchange(coordinator.port, "/v1/health", tls.cert, healthResult, peer)).duplicate,
      false,
    );
    assert.equal(
      (await exchange(coordinator.port, "/v1/health", tls.cert, healthResult, peer)).duplicate,
      true,
    );
    await assert.rejects(
      exchange(coordinator.port, "/v1/health", tls.cert, { ...healthResult, models: [] }, peer),
      /HTTP 403/,
    );
    const healthList = await coordinator.browser(
      new Request(`https://localhost${healthPath}`),
      member,
    );
    const healthBody = (await healthList!.json()) as {
      lastSeenAt: number;
      checks: { result: unknown }[];
    };
    assert(healthBody.lastSeenAt >= now);
    assert.deepEqual(healthBody.checks[0]!.result, healthResult);
    await coordinator.stop();
    coordinator = await openRunnerCoordinator({ ...options, port: firstPort });
    assert.deepEqual(
      coordinator.health.read(identity.runnerId, healthCommand.commandId),
      healthResult,
    );
    observe(
      "composed health routes enforce persisted roles and preserve immutable mTLS receipts across reopen",
      true,
      {
        memberMutationDenied: true,
        memberReadAllowed: true,
        changedReceiptDenied: true,
        reopenReceiptPreserved: true,
      },
    );
    keepAlive = new Agent({ keepAlive: true, maxSockets: 1, ca: tls.cert, ...peer });
    let retained: Socket | undefined;
    keepAlive.on("free", (socket: Socket) => {
      retained = socket;
    });
    await exchange(
      coordinator.port,
      "/v1/commands",
      tls.cert,
      undefined,
      peer,
      undefined,
      keepAlive,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert(retained && !retained.destroyed);
    const at = Date.now();
    db.run("UPDATE runner SET revoked_at=?,status='revoked' WHERE id=?", [at, identity.runnerId]);
    while (!retained.destroyed && Date.now() - at < 4500) await Bun.sleep(25);
    assert(retained.destroyed);
    await assert.rejects(exchange(coordinator.port, "/v1/commands", tls.cert, undefined, peer));
    observe(
      "the coordinator revocation sweep rejects a previously paired runner within five seconds",
      true,
      {
        elapsedMs: Date.now() - at,
        retainedSocketDestroyed: true,
        denied: true,
      },
    );
    assert.deepEqual(errors, []);
  } finally {
    keepAlive?.destroy();
    await browser.stop(true);
    await coordinator.stop();
    db.close();
  }
}

function exchange<T = Record<string, unknown>>(
  port: number,
  path: string,
  ca: string,
  body?: unknown,
  peer?: { cert: string; key: string },
  token?: string,
  agent?: Agent,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const input = request(
      {
        hostname: "localhost",
        port,
        path,
        ca,
        ...peer,
        agent: agent ?? false,
        minVersion: "TLSv1.3",
        method: bytes ? "POST" : "GET",
        headers: {
          ...(bytes
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(bytes)),
              }
            : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    input.setTimeout(10_000, () => input.destroy(new Error("Fixture timed out.")));
    input.once("error", reject);
    input.end(bytes);
  });
}
