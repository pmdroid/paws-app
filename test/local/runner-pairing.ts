import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:https";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  getRunner,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../../src/db";
import { createRunnerControl } from "../../src/runner-control";
import {
  createRunnerKey,
  describeRunnerCertificate,
  initializeRunnerAuthority,
} from "../../src/runner-identity";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../../src/workspace";

export async function probeRunnerPairing(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  let now = Date.now();
  function owner(organizationId: string): WorkspacePrincipal {
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: organizationId,
      name: "Fixture owner",
      email: `${organizationId}@example.invalid`,
    });
    const token = issueWorkspaceBootstrap(db, organizationId, now);
    const workspace = consumeWorkspaceBootstrap(db, {
      id: workspaceId(),
      organizationId,
      name: organizationId,
      userId,
      tokenHash: workspaceTokenHash(token),
      now,
    });
    return { workspaceId: workspace.id, userId, role: "owner", authenticatedAt: now, teamIds: [] };
  }
  const principal = owner("fixture-one");
  const outsider = owner("fixture-two");
  const memberUserId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "fixture-member",
    name: "Member",
    email: "member@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: principal.workspaceId,
    userId: memberUserId,
    role: "member",
    active: true,
    teamIds: [],
    now,
  });
  const member = { ...principal, userId: memberUserId };
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  const client = await createRunnerKey(join(root, "client"));
  now = Date.now();
  const disconnected: string[] = [];
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect: (fingerprint) => disconnected.push(fingerprint),
    now: () => now,
  });
  let child: Awaited<ReturnType<typeof startRegistry>> | undefined;
  try {
    const pending = await control.beginPairing({ name: "Fixture Linux VM", csr: client.csr });
    assert.equal(control.claimPairing(pending.id, pending.claim).status, "pending");
    assert.throws(() => control.claimPairing(pending.id, pending.code));
    assert.equal(control.inspectPairing(member, pending.code).name, "Fixture Linux VM");
    const inspected = control.inspectPairing(principal, pending.code);
    assert.equal(inspected.requestFingerprint, pending.requestFingerprint);
    const stored = db
      .query<{ claim_hash: string; code_hash: string }, [string]>(
        "SELECT claim_hash,code_hash FROM runner_pairing WHERE id=?",
      )
      .get(pending.id)!;
    assert.notEqual(stored.claim_hash, pending.claim);
    assert.notEqual(stored.code_hash, pending.code);
    observe("runner enrollment permits current members to inspect a pairing", true, {
      pending: true,
      requestFingerprint: inspected.requestFingerprint,
      memberInspectionAllowed: true,
      hashesOnly: true,
    });
    const approved = await control.approvePairing(principal, pending.code);
    const received = control.claimPairing(pending.id, pending.claim);
    assert.equal(received.status, "approved");
    if (received.status !== "approved") throw new Error("Runner approval missing");
    assert.equal(received.runnerId, approved.runnerId);
    const certificate = describeRunnerCertificate(received.certificate);
    const peer = {
      fingerprint: certificate.fingerprint,
      serial: certificate.serial,
      notAfter: certificate.notAfter,
    };
    assert.equal(control.authenticate(peer).ownerUserId, principal.userId);
    await assert.rejects(
      () => control.approvePairing(principal, pending.code),
      /invalid or expired/,
    );
    assert.equal(control.list(outsider).length, 0);
    assert.throws(() => control.setStatus(outsider, approved.runnerId, "revoked"), /unavailable/);
    observe("single-use approval binds the signed identity to its workspace and owner", true, {
      runnerId: approved.runnerId,
      workspaceId: received.workspaceId,
      serial: certificate.serial,
      approvalReplayDenied: true,
      crossWorkspaceDenied: true,
    });
    const expired = await control.beginPairing({ name: "Expired VM", csr: client.csr });
    now = expired.expiresAt;
    assert.throws(() => control.claimPairing(expired.id, expired.claim), /invalid or expired/);
    await assert.rejects(
      () => control.approvePairing({ ...principal, authenticatedAt: now }, expired.code),
      /invalid or expired/,
    );
    now = Date.now();
    observe("pairing expires at ten minutes without creating a runner", true, {
      expiresAt: expired.expiresAt,
      runners: control.list(principal).length,
    });
    const abandoned = await control.beginPairing({ name: "Unclaimed VM", csr: client.csr });
    now = abandoned.expiresAt - 1;
    const abandonedRunner = await control.approvePairing(
      { ...principal, authenticatedAt: now },
      abandoned.code,
    );
    now = abandoned.expiresAt;
    control.expireConnections();
    assert.equal(
      control.list(principal).find((runner) => runner.id === abandonedRunner.runnerId)?.status,
      "revoked",
    );
    assert.equal(
      control.list(principal).find((runner) => runner.id === approved.runnerId)?.status,
      "active",
    );
    assert.throws(() => control.claimPairing(abandoned.id, abandoned.claim), /invalid or expired/);
    assert.equal(
      db
        .query<{ action: string }, [string]>(
          "SELECT action FROM workspace_access_audit WHERE subject=? ORDER BY id DESC LIMIT 1",
        )
        .get(abandonedRunner.runnerId)?.action,
      "runner.pairing_expired",
    );
    now = Date.now();
    await control.beginPairing({ name: "Cleanup VM", csr: client.csr });
    assert.equal(
      control.list(principal).find((runner) => runner.id === abandonedRunner.runnerId)?.status,
      "revoked",
    );
    observe(
      "approval without certificate collection expires and revokes only the unclaimed runner",
      true,
      { unclaimedStatus: "revoked", claimedStatus: "active", audited: true },
    );
    const renewed = await control.renew(peer, client.csr);
    const renewedCertificate = describeRunnerCertificate(renewed.certificate);
    const renewedPeer = {
      fingerprint: renewedCertificate.fingerprint,
      serial: renewedCertificate.serial,
      notAfter: renewedCertificate.notAfter,
    };
    assert.equal(control.authenticate(peer).id, approved.runnerId);
    await assert.rejects(() => control.renew(peer, client.csr), /superseded/);
    assert.equal(control.authenticate(renewedPeer).id, approved.runnerId);
    now += 5 * 60_000;
    assert.throws(() => control.authenticate(peer), /revoked or expired/);
    assert.equal(control.authenticate(renewedPeer).id, approved.runnerId);
    now = Date.now();
    observe(
      "certificate renewal permits five minutes of overlap and preserves runner identity",
      true,
      {
        previousSerial: peer.serial,
        renewedSerial: renewedPeer.serial,
        runnerId: approved.runnerId,
        oldIdentityDeniedAtOverlapEnd: true,
        supersededIdentityCannotRenew: true,
      },
    );
    await makeServerIdentity(root);
    writeFileSync(join(root, "authority.pem"), authority.certificate);
    child = await startRegistry(root, 1);
    const first = await registryRequest(root, child.port, received.certificate, client.keyPath);
    assert.equal(first.status, 200);
    await child.stop();
    child = await startRegistry(root, 2);
    const restarted = await registryRequest(root, child.port, received.certificate, client.keyPath);
    assert.equal(restarted.status, 200);
    assert.equal(JSON.parse(restarted.body).id, approved.runnerId);
    observe("approved runner identity survives an actual coordinator process restart", true, {
      firstStatus: first.status,
      restartedStatus: restarted.status,
      runnerId: JSON.parse(restarted.body).id,
    });
    const liveAgent = new Agent({ keepAlive: true });
    const live = await registryRequest(
      root,
      child.port,
      renewed.certificate,
      client.keyPath,
      liveAgent,
    );
    assert.equal(live.status, 200);
    assert.equal(live.socket.destroyed, false);
    const revokedAt = Date.now();
    control.setStatus(principal, approved.runnerId, "revoked");
    while (!live.socket.destroyed && Date.now() - revokedAt < 4500)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const connectionClosed = live.socket.destroyed;
    liveAgent.destroy();
    assert(connectionClosed);
    assert(Date.now() - revokedAt < 4500);

    assert(disconnected.includes(peer.fingerprint));
    assert(disconnected.includes(renewedPeer.fingerprint));
    await child.stop();
    child = await startRegistry(root, 3);
    const revoked = await registryRequest(root, child.port, renewed.certificate, client.keyPath);
    assert.equal(revoked.status, 403);
    await assert.rejects(() => control.renew(renewedPeer, client.csr), /revoked or expired/);
    assert.equal(getRunner(db, approved.runnerId)!.fence, 1);
    observe("revocation persists across restart and blocks certificate renewal", true, {
      status: revoked.status,
      fence: getRunner(db, approved.runnerId)!.fence,
      disconnectedIdentities: disconnected.length,
      actualLiveConnectionClosed: true,
    });
    const memberPending = await control.beginPairing({ name: "Member transport", csr: client.csr });
    const memberApproval = await control.approvePairing(member, memberPending.code);
    const memberClaim = control.claimPairing(memberPending.id, memberPending.claim);
    assert.equal(memberClaim.status, "approved");
    if (memberClaim.status !== "approved") throw new Error("Member certificate missing");
    const memberCertificate = describeRunnerCertificate(memberClaim.certificate);
    const memberAgent = new Agent({ keepAlive: true });
    const memberLive = await registryRequest(
      root,
      child.port,
      memberClaim.certificate,
      client.keyPath,
      memberAgent,
    );
    assert.equal(memberLive.status, 200);
    assert.equal(memberLive.socket.destroyed, false);
    const demotedAt = Date.now();
    syncWorkspaceMember(db, {
      workspaceId: principal.workspaceId,
      userId: memberUserId,
      role: "observer",
      active: true,
      teamIds: [],
      now: demotedAt,
    });
    try {
      assert.throws(() => control.authenticate(memberCertificate), /revoked or expired/);
      await assert.rejects(
        () => control.renew(memberCertificate, client.csr),
        /revoked or expired/,
      );
      assert.throws(
        () => control.claimPairing(memberPending.id, memberPending.claim),
        /revoked or expired/,
      );
      control.expireConnections();
      assert(disconnected.includes(memberCertificate.fingerprint));
      while (!memberLive.socket.destroyed && Date.now() - demotedAt < 4500)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert(memberLive.socket.destroyed);
      let deniedStatus: number | string;
      try {
        const denied = await registryRequest(
          root,
          child.port,
          memberClaim.certificate,
          client.keyPath,
        );
        deniedStatus = denied.status;
      } catch (error) {
        deniedStatus = (error as NodeJS.ErrnoException).code ?? "unknown";
      }
      assert([403, "ECONNRESET"].includes(deniedStatus));
    } finally {
      memberAgent.destroy();
    }
    syncWorkspaceMember(db, {
      workspaceId: principal.workspaceId,
      userId: memberUserId,
      role: "member",
      active: true,
      teamIds: [],
      now: demotedAt + 1,
    });
    assert.equal(control.authenticate(memberCertificate).id, memberApproval.runnerId);
    const restored = await registryRequest(
      root,
      child.port,
      memberClaim.certificate,
      client.keyPath,
    );
    assert.equal(restored.status, 200);
    const restoredRenewal = await registryRequest(
      root,
      child.port,
      memberClaim.certificate,
      client.keyPath,
      undefined,
      { csr: client.csr },
    );
    assert.equal(restoredRenewal.status, 200);
    const restoredCertificate = JSON.parse(restoredRenewal.body) as { certificate: string };
    const restoredIdentity = await registryRequest(
      root,
      child.port,
      restoredCertificate.certificate,
      client.keyPath,
    );
    assert.equal(restoredIdentity.status, 200);
    observe(
      "active observer demotion closes transport and membership restoration permits fresh mTLS renewal without restart",
      true,
      {
        runnerId: memberApproval.runnerId,
        activeMembership: true,
        renewedIdentityDenied: true,
        claimDenied: true,
        liveConnectionClosed: true,
        newConnectionDenied: true,
      },
    );
    const another = await control.beginPairing({ name: "Member-owned VM", csr: client.csr });
    const anotherApproval = await control.approvePairing(principal, another.code);
    const anotherClaim = control.claimPairing(another.id, another.claim);
    assert.equal(anotherClaim.status, "approved");
    if (anotherClaim.status !== "approved") throw new Error("Runner approval missing");
    const anotherCertificate = describeRunnerCertificate(anotherClaim.certificate);
    syncWorkspaceMember(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      role: "member",
      active: false,
      teamIds: [],
      now: now + 1,
    });
    syncWorkspaceMember(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      role: "owner",
      active: true,
      teamIds: [],
      now: now + 2,
    });
    assert.equal(getRunner(db, anotherApproval.runnerId)!.status, "revoked");
    assert.throws(() => control.authenticate(anotherCertificate), /revoked or expired/);
    observe("membership removal permanently revokes existing runner certificates", true, {
      runnerId: anotherApproval.runnerId,
      status: getRunner(db, anotherApproval.runnerId)!.status,
      membershipRestored: true,
      oldCertificateStillDenied: true,
    });
  } finally {
    await child?.stop();
    db.close();
  }
}

async function startRegistry(root: string, attempt: number) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "../fixtures/runner-registry-server.ts"),
      root,
    ],
    {
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        KYOTOAGENT_ROOT: join(root, "kyoto"),
        PAWS_HOME: join(root, "paws"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: Bun.file(join(root, `registry-${attempt}.log`)),
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    const exit = await child.exited;
    clearTimeout(timeout);
    assert.equal(exit, 0);
  };
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    const parsed = JSON.parse(new TextDecoder().decode(ready.value)) as { port: number };
    assert(Number.isInteger(parsed.port));
    return { port: parsed.port, stop };
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    clearTimeout(timeout);
    throw error;
  }
}

async function registryRequest(
  root: string,
  port: number,
  certificate: string,
  keyPath: string,
  agent?: Agent,
  payload?: { csr: string },
) {
  return new Promise<{ status: number; body: string; socket: Socket }>((resolve, reject) => {
    let socket: Socket;
    const req = request(
      {
        hostname: "localhost",
        port,
        path: payload ? "/v1/certificate" : "/identity",
        method: payload ? "POST" : "GET",
        headers: payload ? { "content-type": "application/json" } : {},
        ca: readFileSync(join(root, "server.pem")),
        cert: certificate,
        key: readFileSync(keyPath),
        agent: agent ?? false,
        timeout: 2000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, socket }));
        res.on("error", reject);
      },
    );
    req.on("socket", (value) => (socket = value));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Registry TLS timeout")));
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

async function makeServerIdentity(root: string) {
  const child = Bun.spawn(
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
      "server.key",
      "-out",
      "server.pem",
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
      cwd: root,
      env: { PATH: "/usr/bin:/bin", HOME: root },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  assert.equal(await child.exited, 0);
}
