import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { Agent, createServer, request } from "node:https";
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
import {
  createRunnerControl,
  createRunnerHttp,
  RunnerEnrollmentDenied,
} from "../../src/runner-control";
import { openRunnerDaemon } from "../../src/runner-daemon";
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
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  const client = await createRunnerKey(join(root, "client"));
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
    assert.throws(() => control.inspectPairing(member, pending.code), /administrator/);
    const inspected = control.inspectPairing(principal, pending.code);
    assert.equal(inspected.requestFingerprint, pending.requestFingerprint);
    const stored = db
      .query<{ claim_hash: string; code_hash: string }, [string]>(
        "SELECT claim_hash,code_hash FROM runner_pairing WHERE id=?",
      )
      .get(pending.id)!;
    assert.notEqual(stored.claim_hash, pending.claim);
    assert.notEqual(stored.code_hash, pending.code);
    observe("runner enrollment waits for a current administrator", true, {
      pending: true,
      requestFingerprint: inspected.requestFingerprint,
      memberDenied: true,
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
) {
  return new Promise<{ status: number; body: string; socket: Socket }>((resolve, reject) => {
    let socket: Socket;
    const req = request(
      {
        hostname: "localhost",
        port,
        path: "/identity",
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
    req.end();
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

/** Paws approves a pairing it started on a VM it created, owned by the member who asked for it. */
export async function probeProvisionedPairing(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  const client = await createRunnerKey(join(root, "client"));
  let now = Date.now();
  const ownerUserId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "provision-owner",
    name: "Fixture owner",
    email: "provision-owner@example.invalid",
  });
  const token = issueWorkspaceBootstrap(db, "provision-org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "provision-org",
    name: "provision-org",
    userId: ownerUserId,
    tokenHash: workspaceTokenHash(token),
    now,
  });
  function person(name: string, role: "member" | "observer", active: boolean) {
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: `provision-${name}`,
      name,
      email: `${name}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId,
      role,
      active,
      teamIds: [],
      now,
    });
    return userId;
  }
  const memberUserId = person("member", "member", true);
  const observerUserId = person("observer", "observer", true);
  const formerUserId = person("former", "member", false);
  const ownerPrincipal: WorkspacePrincipal = {
    workspaceId: workspace.id,
    userId: ownerUserId,
    role: "owner",
    authenticatedAt: now,
    teamIds: [],
  };
  const memberPrincipal: WorkspacePrincipal = {
    ...ownerPrincipal,
    userId: memberUserId,
    role: "member",
  };
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect: () => {},
    now: () => now,
  });
  const pairingRunner = (id: string) =>
    db
      .query<{ runner_id: string | null }, [string]>(
        "SELECT runner_id FROM runner_pairing WHERE id=?",
      )
      .get(id)?.runner_id ?? null;
  try {
    const pending = await control.beginPairing({ name: "member-paws", csr: client.csr });
    const other = await createRunnerKey(join(root, "other"));
    const wrongFingerprint = (await control.beginPairing({ name: "other", csr: other.csr }))
      .requestFingerprint;
    await assert.rejects(
      () =>
        control.approveProvisionedPairing({
          workspaceId: workspace.id,
          userId: memberUserId,
          code: pending.code,
          requestFingerprint: wrongFingerprint,
        }),
      /fingerprint does not match/,
    );
    assert.equal(pairingRunner(pending.id), null);
    assert.equal(control.claimPairing(pending.id, pending.claim).status, "pending");
    observe("a provisioned pairing with another fingerprint stays pending", true, {
      pairingId: pending.id,
    });

    for (const userId of [observerUserId, formerUserId]) {
      await assert.rejects(
        () =>
          control.approveProvisionedPairing({
            workspaceId: workspace.id,
            userId,
            code: pending.code,
            requestFingerprint: pending.requestFingerprint,
          }),
        /Active workspace membership/,
      );
    }
    assert.equal(pairingRunner(pending.id), null);
    observe("observers and inactive members cannot own a provisioned runner", true, {
      observerDenied: true,
      inactiveDenied: true,
    });

    await assert.rejects(
      () =>
        control.approveProvisionedPairing({
          workspaceId: workspace.id,
          userId: memberUserId,
          code: "0000000000000000",
          requestFingerprint: pending.requestFingerprint,
        }),
      /invalid or expired/,
    );
    const expired = await control.beginPairing({ name: "expired-paws", csr: client.csr });
    now = expired.expiresAt;
    await assert.rejects(
      () =>
        control.approveProvisionedPairing({
          workspaceId: workspace.id,
          userId: memberUserId,
          code: expired.code,
          requestFingerprint: expired.requestFingerprint,
        }),
      /invalid or expired/,
    );
    now = Date.now();
    observe("an unknown or expired provisioned pairing code is refused", true, {
      unknownDenied: true,
      expiredDenied: true,
    });

    const approved = await control.approveProvisionedPairing({
      workspaceId: workspace.id,
      userId: memberUserId,
      code: pending.code,
      requestFingerprint: pending.requestFingerprint,
    });
    assert.equal(approved.pairingId, pending.id);
    assert.equal(getRunner(db, approved.runnerId)!.ownerUserId, memberUserId);
    const received = control.claimPairing(pending.id, pending.claim);
    assert.equal(received.status, "approved");
    if (received.status !== "approved") throw new Error("Runner approval missing");
    const certificate = describeRunnerCertificate(received.certificate);
    assert.equal(control.authenticate(certificate).ownerUserId, memberUserId);
    await assert.rejects(
      () =>
        control.approveProvisionedPairing({
          workspaceId: workspace.id,
          userId: memberUserId,
          code: pending.code,
          requestFingerprint: pending.requestFingerprint,
        }),
      /invalid or expired/,
    );
    const audit = db
      .query<{ user_id: string; action: string; subject: string }, [string]>(
        "SELECT user_id,action,subject FROM workspace_access_audit WHERE workspace_id=? AND action LIKE 'runner.%' ORDER BY id",
      )
      .all(workspace.id);
    assert.deepEqual(audit, [
      { user_id: memberUserId, action: "runner.paired", subject: approved.runnerId },
      { user_id: memberUserId, action: "runner.pairing_provisioned", subject: pending.id },
    ]);
    observe("Paws approves its own VM's pairing as the member, who owns the runner", true, {
      runnerId: approved.runnerId,
      ownerUserId: memberUserId,
      audited: audit.length,
    });

    const dashboard = await control.beginPairing({ name: "dashboard", csr: client.csr });
    assert.throws(() => control.inspectPairing(memberPrincipal, dashboard.code), /administrator/);
    await assert.rejects(
      () => control.approvePairing(memberPrincipal, dashboard.code),
      /administrator/,
    );
    const viaDashboard = await control.approvePairing(ownerPrincipal, dashboard.code);
    assert.equal(getRunner(db, viaDashboard.runnerId)!.ownerUserId, ownerUserId);
    observe("dashboard inspect and approve still require an owner or administrator", true, {
      memberDenied: true,
    });
  } finally {
    db.close();
  }
}

/**
 * A member mints a single-use enrollment token; the host trades it with its CSR for a certificate
 * in one round trip, owned by that member. Replays, expiry and lost membership answer 401.
 */
export async function probeRunnerEnrollment(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const authorityRoot = join(root, "issuer");
  const authority = await initializeRunnerAuthority(authorityRoot);
  let now = Date.now();
  const ownerUserId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "enroll-owner",
    name: "Fixture owner",
    email: "enroll-owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "enroll-org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "enroll-org",
    name: "enroll-org",
    userId: ownerUserId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  function person(name: string, role: "member" | "observer") {
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: `enroll-${name}`,
      name,
      email: `${name}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId,
      role,
      active: true,
      teamIds: [],
      now,
    });
    const principal: WorkspacePrincipal = {
      workspaceId: workspace.id,
      userId,
      role,
      authenticatedAt: now,
      teamIds: [],
    };
    return principal;
  }
  const member = person("member", "member");
  const observer = person("observer", "observer");
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect: () => {},
    now: () => now,
  });
  const http = createRunnerHttp(control, {
    hostConfig: () => ({
      controlPlaneUrl: "https://paws.example.invalid",
      runnerApiUrl: "https://paws.example.invalid:8788",
      allowedRepositories: ["local/fixture"],
    }),
  });
  const runners = () =>
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner").get()!.count;
  const post = (path: string, body: unknown) =>
    new Request(`https://paws.example.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.throws(
      () => control.createEnrollment(observer, { name: "observer-host" }),
      /Active workspace membership/,
    );
    const minted = await http.browser(
      post("/api/runners/enrollments", { name: "member-host" }),
      member,
    );
    assert.equal(minted?.status, 200);
    const issued = (await minted!.json()) as {
      token: string;
      expiresAt: number;
      config: { runnerApiUrl: string };
    };
    assert.equal(issued.expiresAt, now + 10 * 60_000);
    assert.equal(issued.config.runnerApiUrl, "https://paws.example.invalid:8788");
    const stored = db
      .query<{ token_hash: string }, []>("SELECT token_hash FROM runner_enrollment")
      .all();
    assert.deepEqual(stored, [{ token_hash: workspaceTokenHash(issued.token) }]);
    observe("any active member mints a ten-minute token and only its hash is stored", true, {
      observerDenied: true,
      hashesOnly: true,
    });

    const host = await createRunnerKey(join(root, "host"));
    const enrolled = await http.hostEnrollment(
      post("/api/runner-enrollments", { token: issued.token, name: "member-host", csr: host.csr }),
    );
    assert.equal(enrolled.status, 200);
    const identity = (await enrolled.json()) as {
      status: string;
      runnerId: string;
      workspaceId: string;
      certificate: string;
      authority: string;
    };
    assert.deepEqual(Object.keys(identity).sort(), [
      "authority",
      "certificate",
      "runnerId",
      "status",
      "workspaceId",
    ]);
    assert.equal(identity.status, "approved");
    assert.equal(identity.workspaceId, workspace.id);
    assert.equal(identity.authority, authority.certificate);
    const peer = describeRunnerCertificate(identity.certificate);
    assert.equal(control.authenticate(peer).id, identity.runnerId);
    assert.equal(getRunner(db, identity.runnerId)!.ownerUserId, member.userId);
    assert.equal(getRunner(db, identity.runnerId)!.name, "member-host");
    observe(
      "one POST with token, name and CSR returns the identity of a member-owned runner",
      true,
      {
        runnerId: identity.runnerId,
      },
    );

    const replay = await http.hostEnrollment(
      post("/api/runner-enrollments", { token: issued.token, name: "again", csr: host.csr }),
    );
    assert.equal(replay.status, 401);
    const unknown = await http.hostEnrollment(
      post("/api/runner-enrollments", { token: "x".repeat(43), name: "again", csr: host.csr }),
    );
    assert.equal(unknown.status, 401);
    const expiring = control.createEnrollment(member, { name: "late" });
    now = expiring.expiresAt;
    await assert.rejects(
      () => control.enroll({ token: expiring.token, name: "late", csr: host.csr }),
      RunnerEnrollmentDenied,
    );
    now = Date.now();
    assert.equal(runners(), 1);
    observe("a used, unknown or expired token answers 401 and creates nothing", true, {
      replay: replay.status,
      unknown: unknown.status,
      runners: runners(),
    });

    const demoted = control.createEnrollment(member, { name: "demoted" });
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId: member.userId,
      role: "observer",
      active: true,
      teamIds: [],
      now: now + 1,
    });
    const asObserver = await http.hostEnrollment(
      post("/api/runner-enrollments", { token: demoted.token, name: "demoted", csr: host.csr }),
    );
    assert.equal(asObserver.status, 401);
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId: member.userId,
      role: "member",
      active: true,
      teamIds: [],
      now: now + 2,
    });
    const leaving = control.createEnrollment(member, { name: "leaving" });
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId: member.userId,
      role: "member",
      active: false,
      teamIds: [],
      now: now + 3,
    });
    await assert.rejects(
      () => control.enroll({ token: leaving.token, name: "leaving", csr: host.csr }),
      RunnerEnrollmentDenied,
    );
    assert.equal(runners(), 1);
    observe("a token whose member became an observer or inactive before use is refused", true, {
      observer: asObserver.status,
    });

    const audit = db
      .query<{ user_id: string; action: string; subject: string }, [string]>(
        "SELECT user_id,action,subject FROM workspace_access_audit WHERE workspace_id=? AND action LIKE 'runner.%' ORDER BY id",
      )
      .all(workspace.id);
    assert.deepEqual(
      audit.filter((row) => row.action === "runner.paired"),
      [{ user_id: member.userId, action: "runner.paired", subject: identity.runnerId }],
    );
    const everything = JSON.stringify(
      db
        .query("SELECT * FROM workspace_access_audit")
        .all()
        .concat(db.query("SELECT * FROM runner_enrollment").all()),
    );
    for (const token of [issued.token, expiring.token, demoted.token, leaving.token])
      assert(!everything.includes(token));
    observe("runner.paired names the member and no audit or enrollment row holds a token", true, {
      audited: audit.length,
    });
  } finally {
    db.close();
  }
}

/** `enroll` on the daemon posts once, stores the identity, and is a no-op once paired. */
export async function probeDaemonEnrollment(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const authority = await initializeRunnerAuthority(join(root, "issuer"));
  await makeServerIdentity(root);
  const tls = {
    key: readFileSync(join(root, "server.key"), "utf8"),
    cert: readFileSync(join(root, "server.pem"), "utf8"),
  };
  const signing = generateKeyPairSync("ed25519");
  const publicKeyPem = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
  const token = "t".repeat(43);
  const bodies: { url: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(tls, async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    bodies.push({ url: incoming.url, body });
    if (body.token !== token) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const certificate = await authority.issue(String(body.csr));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "approved",
        runnerId: "runner-enrolled",
        workspaceId: "workspace-enrolled",
        certificate: certificate.pem,
        authority: authority.certificate,
        signingKeys: [{ keyId: "coordinator", publicKeyPem }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const open = () =>
    openRunnerDaemon({
      root: join(root, "daemon"),
      controlPlaneUrl: `https://localhost:${address.port}`,
      runnerApiUrl: `https://localhost:${address.port + 1}`,
      serverCa: tls.cert,
      allowedRepositories: ["local/fixture"],
    });
  try {
    let daemon = open();
    await assert.rejects(() => daemon.enroll("fixture-host", "w".repeat(43)));
    assert.equal(daemon.status().phase, "unpaired");
    const status = await daemon.enroll("fixture-host", token);
    assert.equal(status.phase, "paired");
    if (status.phase !== "paired") throw new Error("Enrollment did not pair");
    assert.equal(status.runnerId, "runner-enrolled");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1]!.url, "/api/runner-enrollments");
    assert.deepEqual(Object.keys(bodies[1]!.body).sort(), ["csr", "name", "token"]);
    assert.equal(bodies[0]!.body.csr, bodies[1]!.body.csr);
    observe("the daemon enrolls in one POST with its token, name and CSR", true, {
      requests: bodies.length,
    });
    daemon.close();
    daemon = open();
    const again = await daemon.enroll("fixture-host", "");
    assert.equal(again.phase, "paired");
    assert.equal(bodies.length, 2);
    daemon.close();
    observe(
      "enroll on an already paired daemon returns its identity without contacting Paws",
      true,
      {
        requests: bodies.length,
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
