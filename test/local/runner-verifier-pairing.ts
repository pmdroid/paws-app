import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import {
  consumeWorkspaceBootstrap,
  getRunnerVerifier,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../../src/db";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon, type RunnerDaemonOptions } from "../../src/runner-daemon";
import { createRunnerKey } from "../../src/runner-identity";
import { runnerVerifierFingerprint } from "../../src/runner-verifier";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerVerifierPairing(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dbPath = join(root, "paws.sqlite");
  const db = openDatabase(dbPath);
  migrate(db);
  let now = Date.now();
  const owner = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "verifier-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "verifier-org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "verifier-org",
    name: "Fixture",
    userId: owner,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const principal = {
    workspaceId: workspace.id,
    userId: owner,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const member = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "verifier-member",
    name: "Member",
    email: "member@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: member,
    role: "member",
    active: true,
    teamIds: [],
    now,
  });
  let actor = { ...principal, userId: owner };
  const keyPath = join(root, "server.key"),
    certPath = join(root, "server.pem");
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
    { stdout: "ignore", stderr: "ignore" },
  );
  assert.equal(await openssl.exited, 0);
  const tls = { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  const issuer = join(root, "issuer");
  await initializeRunnerCoordinator(issuer);
  now = Date.now();
  const errors: unknown[] = [];
  const coordinator = await openRunnerCoordinator({
    db,
    root: issuer,
    tls,
    port: 0,
    now: () => now,
    onError: (error) => errors.push(String(error)),
  });
  const publicKey = () =>
    generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
  const verifierPublicKeyPem = publicKey(),
    otherKey = publicKey();
  const fingerprint = runnerVerifierFingerprint(verifierPublicKeyPem),
    otherFingerprint = runnerVerifierFingerprint(otherKey);
  let replaceChallenge = false,
    replaceApproval = false;
  const browser = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    async fetch(input) {
      if (new URL(input.url).pathname === "/api/runner-pairings") {
        const response = await coordinator.enrollment(input);
        if (!response.ok) return response;
        const body = (await response.json()) as Record<string, unknown>;
        if ((replaceChallenge && "code" in body) || (replaceApproval && body.status === "approved"))
          body.verifierFingerprint = otherFingerprint;
        return Response.json(body);
      }
      return (await coordinator.browser(input, actor)) ?? new Response(null, { status: 404 });
    },
  });
  function exchange(path: string, body: unknown) {
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          servername: "localhost",
          port: browser.port,
          path,
          method: "POST",
          ca: tls.cert,
          headers: { "content-type": "application/json" },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode!, body: JSON.parse(text) }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }
  const options: RunnerDaemonOptions = {
    root: join(root, "daemon"),
    controlPlaneUrl: `https://localhost:${browser.port}`,
    runnerApiUrl: `https://localhost:${coordinator.port}`,
    serverCa: tls.cert,
    allowedRepositories: [],
    verifierPublicKeyPem,
  };
  let daemon = openRunnerDaemon(options);
  try {
    const fresh = await createRunnerKey(join(root, "malformed"));
    for (const badKey of [verifierPublicKeyPem + "\n", tls.cert, otherKey + verifierPublicKeyPem]) {
      const denied = await exchange("/api/runner-pairings", {
        name: "Malformed",
        csr: fresh.csr,
        verifierPublicKeyPem: badKey,
      });
      assert.equal(denied.status, 400);
    }
    observe(
      "verified HTTPS enrollment rejects malformed and noncanonical verifier identities",
      true,
      { refused: 3 },
    );
    replaceChallenge = true;
    await assert.rejects(daemon.beginPairing("Verifier VM"), /does not match/);
    assert.equal(daemon.status().phase, "unpaired");
    replaceChallenge = false;
    const pending = await daemon.beginPairing("Verifier VM");
    assert.equal(pending.phase, "pending");
    if (pending.phase !== "pending") throw new Error("Expected pending pairing");
    assert.equal(pending.verifierFingerprint, fingerprint);
    const inspected = await exchange("/api/runners/pairings/inspect", { code: pending.code });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.body.verifierFingerprint, fingerprint);
    assert.throws(
      () =>
        db.run("UPDATE runner_pairing SET verifier_fingerprint=? WHERE id=?", [
          otherFingerprint,
          pending.id,
        ]),
      /immutable/,
    );
    assert.throws(
      () => openRunnerDaemon({ ...options, verifierPublicKeyPem: otherKey }),
      /verifier identity/,
    );
    observe(
      "pairing challenge pins the canonical key and refuses changed pending identities",
      true,
      {
        fingerprint,
        inspected: inspected.body.verifierFingerprint,
        changedChallengeRejected: daemon.status().phase,
      },
    );
    const approve = (verifierFingerprint?: string) =>
      exchange("/api/runners/pairings/approve", {
        code: pending.code,
        ...(verifierFingerprint ? { verifierFingerprint } : {}),
      });
    const missing = await approve(),
      wrong = await approve(otherFingerprint);
    assert.equal(missing.status, 403);
    assert.equal(wrong.status, 403);
    actor = { ...principal, userId: member };
    const memberDenied = await approve(fingerprint);
    assert.equal(memberDenied.status, 403);
    actor = { ...principal, authenticatedAt: now - 15 * 60_000 - 1 };
    const stale = await approve(fingerprint);
    assert.equal(stale.status, 403);
    actor = { ...principal };
    assert.equal(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner").get()!.count,
      0,
    );
    const approved = await approve(fingerprint);
    assert.equal(approved.status, 200);
    const runnerId = approved.body.runnerId as string;
    assert.deepEqual(getRunnerVerifier(db, runnerId), {
      publicKeyPem: verifierPublicKeyPem,
      fingerprint,
    });
    assert.equal((await approve(fingerprint)).status, 403);
    assert.throws(
      () =>
        db.run("UPDATE runner_verifier SET public_key=? WHERE runner_id=?", [otherKey, runnerId]),
      /immutable/,
    );
    const audit = db
      .query<{ subject: string }, [string]>(
        "SELECT subject FROM workspace_access_audit WHERE action='runner.verifier.approved' AND user_id=?",
      )
      .all(owner);
    assert.deepEqual(
      audit.map((row) => row.subject),
      [`${runnerId}:${fingerprint}`],
    );
    observe("recent administrator approval binds one immutable verifier key atomically", true, {
      runnerId,
      missing: missing.status,
      wrong: wrong.status,
      member: memberDenied.status,
      stale: stale.status,
      replay: 403,
      audit: audit[0]!.subject,
    });
    replaceApproval = true;
    await assert.rejects(daemon.pollPairing(), /verifier identity/);
    assert.equal(daemon.status().phase, "pending");
    replaceApproval = false;
    const paired = await daemon.pollPairing();
    assert.equal(paired.phase, "paired");
    if (paired.phase !== "paired") throw new Error("Expected paired identity");
    assert.equal(paired.verifierFingerprint, fingerprint);
    const renewed = await daemon.renewCertificate();
    if (renewed.phase !== "paired") throw new Error("Expected renewed paired identity");
    assert.equal(renewed.verifierFingerprint, fingerprint);
    assert.deepEqual(getRunnerVerifier(db, runnerId), {
      publicKeyPem: verifierPublicKeyPem,
      fingerprint,
    });
    observe("approved identity and real mTLS renewal preserve the pairing verifier pin", true, {
      paired: paired.verifierFingerprint,
      renewed: renewed.verifierFingerprint,
      identity: renewed.fingerprint,
    });
    daemon.close();
    assert.throws(
      () => openRunnerDaemon({ ...options, verifierPublicKeyPem: otherKey }),
      /verifier identity/,
    );
    assert.throws(
      () => openRunnerDaemon({ ...options, verifierPublicKeyPem: undefined }),
      /verifier identity/,
    );
    const configPath = join(root, "restart.json");
    writeFileSync(configPath, JSON.stringify(options), { mode: 0o600 });
    const restart = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        import.meta.path,
        "inspect",
        configPath,
        dbPath,
        runnerId,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(restart.stdout).text(),
      new Response(restart.stderr).text(),
      restart.exited,
    ]);
    assert.equal(exit, 0, stderr);
    const persisted = JSON.parse(stdout);
    assert.equal(persisted.status.verifierFingerprint, fingerprint);
    assert.equal(persisted.verifier.fingerprint, fingerprint);
    assert.equal(persisted.status.runnerId, runnerId);
    observe(
      "an actual fresh daemon process and reopened SQLite retain the immutable pin",
      true,
      persisted,
    );
    daemon = openRunnerDaemon(options);
    const expires = await coordinator.control.beginPairing({
      name: "Expired",
      csr: fresh.csr,
      verifierPublicKeyPem,
    });
    now += 10 * 60_000 + 1;
    await assert.rejects(
      coordinator.control.approvePairing(
        { ...principal, authenticatedAt: now },
        expires.code,
        fingerprint,
      ),
      /expired/,
    );
    assert.throws(() => coordinator.control.claimPairing(expires.id, expires.claim), /expired/);
    coordinator.control.setStatus({ ...principal, authenticatedAt: now }, runnerId, "revoked");
    await assert.rejects(daemon.renewCertificate());
    assert.deepEqual(errors, []);
    observe("expiry and revocation prevent further approval and authenticated renewal", true, {
      expiredPairing: expires.id,
      revokedRunner: runnerId,
      errors,
    });
  } finally {
    daemon.close();
    await browser.stop(true);
    await coordinator.stop();
    db.close();
  }
}

if (import.meta.main) {
  if (process.argv[2] === "inspect") {
    const options = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as RunnerDaemonOptions;
    const daemon = openRunnerDaemon(options),
      db = openDatabase(process.argv[4]!);
    try {
      console.log(
        JSON.stringify({
          status: daemon.status(),
          verifier: getRunnerVerifier(db, process.argv[5]!),
        }),
      );
    } finally {
      daemon.close();
      db.close();
    }
  } else if (process.argv[2] === "exercise") {
    const observations: unknown[] = [];
    await probeRunnerVerifierPairing(process.argv[3]!, (name, passed, observed) => {
      assert(passed, name);
      observations.push({ name, passed, observed });
    });
    console.log(JSON.stringify({ passed: true, observations }));
  } else {
    const root = mkdtempSync("/tmp/paws-verifier-pairing-");
    const home = join(root, "home");
    mkdirSync(home, { mode: 0o700 });
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      KYOTOAGENT_ROOT: home,
      PAWS_HOME: join(home, "paws"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null",
    };
    const files = Bun.spawnSync([
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    assert.equal(files.exitCode, 0);
    const snapshot = () =>
      Object.fromEntries(
        files.stdout
          .toString()
          .split("\0")
          .filter(Boolean)
          .map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
      );
    const source = snapshot();
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", import.meta.path, "exercise", root],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    writeFileSync(join(root, "native.log"), stdout + stderr);
    assert.equal(exit, 0, `Evidence ${root}\n${stderr}`);
    assert.deepEqual(snapshot(), source);
    writeFileSync(
      join(root, "observations.json"),
      JSON.stringify({ ...JSON.parse(stdout), source }, null, 2),
    );
    console.log(`VERIFIED pairing verifier binding; evidence ${root}`);
  }
}
