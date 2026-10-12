import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { openDatabase } from "../../src/db";
import { readSecretFile, writeSecretFile } from "../../src/credentials";
import { openRunnerDaemon } from "../../src/runner-daemon";
import {
  createRunnerKey,
  initializeRunnerAuthority,
  startRunnerListener,
} from "../../src/runner-identity";
import {
  signRunnerCommand,
  type RunnerCommand,
  type SignedRunnerCommand,
} from "../../src/runner-protocol";

export async function probeRunnerDaemon(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
): Promise<void> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const authority = await initializeRunnerAuthority(join(root, "issuer"));
  const foreignClient = await createRunnerKey(join(root, "foreign-client"));
  const server = await serverIdentity(join(root, "server"));
  const signingKey = generateKeyPairSync("ed25519");
  const active = new Set<string>();
  const peers: string[] = [];
  const enrollmentBodies: Record<string, unknown>[] = [];
  const acknowledgments: string[] = [];
  let approved = false;
  let challengeTtl = 60_000;
  let enrollmentNow = Date.now;
  let heldClaim: { entered: () => void; wait: Promise<void> } | undefined;
  let heldEnrollment: { entered: () => void; wait: Promise<void> } | undefined;
  let csr = "";
  let certificate = "";
  let wrongRenewalIdentity = false;
  let wrongRenewalKey = false;
  let commands: SignedRunnerCommand[] = [];
  let runnerId = "runner-local";
  const workspaceId = "workspace-local";
  const held = new Map<string, { entered: () => void; wait: Promise<void> }>();
  const enrollment = createServer(server, async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      enrollmentBodies.push(body);
      let result: unknown;
      if (typeof body.csr === "string") {
        assert.equal(request.url, "/api/runner-pairings");
        assert.deepEqual(Object.keys(body).sort(), ["csr", "name"]);
        csr = body.csr;
        const issued = await authority.issue(csr);
        certificate = issued.pem;
        active.add(issued.fingerprint);
        result = {
          id: "pairing-local",
          claim: "local-claim-with-at-least-sixteen-characters",
          code: "A1234567890ABCDE",
          requestFingerprint: createHash("sha256").update(csr).digest("hex"),
          expiresAt: enrollmentNow() + challengeTtl,
        };
      } else {
        assert.deepEqual(body, {
          id: "pairing-local",
          claim: "local-claim-with-at-least-sixteen-characters",
        });
        result = approved
          ? {
              status: "approved",
              runnerId,
              workspaceId,
              certificate,
              authority: authority.certificate,
            }
          : { status: "pending" };
      }
      const claimGate = "csr" in body ? heldEnrollment : heldClaim;
      claimGate?.entered();
      await claimGate?.wait;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(400);
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => enrollment.listen(0, "127.0.0.1", resolve));
  const address = enrollment.address();
  assert(address && typeof address !== "string");
  const listener = await startRunnerListener({
    tls: { ...server, ca: authority.certificate },
    authorize: (peer) => active.has(peer.fingerprint),
    async fetch(request, peer) {
      peers.push(peer.fingerprint);
      const path = new URL(request.url).pathname;
      async function deliver(value: unknown) {
        const gate = held.get(path);
        gate?.entered();
        await gate?.wait;
        return Response.json(value);
      }
      if (path === "/v1/commands") return deliver({ commands });
      if (path === "/v1/heartbeat") return deliver({ ok: true });
      if (path.endsWith("/ack")) {
        acknowledgments.push(path.split("/")[3]!);
        return deliver({ ok: true });
      }
      assert.equal(path, "/v1/certificate");
      assert.deepEqual(await request.json(), { csr });
      const renewed = await authority.issue(wrongRenewalKey ? foreignClient.csr : csr);
      active.add(renewed.fingerprint);
      return deliver({
        runnerId: wrongRenewalIdentity ? "wrong-runner" : runnerId,
        workspaceId,
        certificate: renewed.pem,
        authority: authority.certificate,
      });
    },
  });
  const daemonRoot = join(root, "daemon");
  const config = {
    root: daemonRoot,
    controlPlaneUrl: `https://localhost:${address.port}`,
    runnerApiUrl: `https://localhost:${listener.port}`,
    serverCa: server.cert,
    signingKey: signingKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const pids: number[] = [];
  async function child(action: string, extra: string[] = [], path = configPath, succeeds = true) {
    const process = Bun.spawn(
      [
        Bun.which("bun")!,
        "--no-env-file",
        new URL("../fixtures/runner-daemon-child.ts", import.meta.url).pathname,
        path,
        action,
        ...extra,
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          TMPDIR: root,
          KYOTOAGENT_ROOT: join(root, "kyoto"),
          PAWS_HOME: join(root, "paws"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => process.kill("SIGKILL"), 20_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      assert.equal(exit, succeeds ? 0 : 1, stdout + stderr);
      const output = JSON.parse(stdout);
      pids.push(output.pid);
      return output;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const paired = await child("pair");
    assert.equal(paired.result.phase, "pending");
    assert(!JSON.stringify(paired).includes("local-claim"));
    assert.equal((await child("claim")).result.phase, "pending");
    approved = true;
    const identity = (await child("claim")).result;
    assert.equal(identity.runnerId, runnerId);
    assert.equal(identity.workspaceId, workspaceId);
    const keyPath = join(daemonRoot, "identity", "runner-key.pem");
    const statePath = join(daemonRoot, "identity", "state.json");
    assert(!readFileSync(keyPath, "utf8").includes("PRIVATE KEY"));
    assert(!readFileSync(statePath, "utf8").includes("local-claim"));
    assert.equal(statSync(daemonRoot).mode & 0o777, 0o700);
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
    observe(
      "runner pairs through verified HTTPS and preserves its encrypted local identity across subprocess restarts",
      true,
      { runnerId, workspaceId, processIds: [...pids], keyMode: "0600", rootMode: "0700" },
    );
    const command: RunnerCommand = {
      id: "command-one",
      type: "run",
      runnerId,
      workspaceId,
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
      runId: "run-one",
      itemId: "item-one",
      generation: 1,
      repository: {
        owner: "local",
        repo: "fixture",
        remoteUrl: "https://github.com/local/fixture.git",
        baseSha: "a".repeat(40),
      },
      profile: { agent: "claude", model: null },
      prompt: "Preserve rows.",
    };
    const signed = (value: RunnerCommand) =>
      signRunnerCommand({
        keyId: "coordinator",
        privateKey: signingKey.privateKey,
        command: { ...value, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 },
      });
    commands = [signed({ ...command, runnerId: "another-runner" })];
    assert.deepEqual((await child("commands")).result, {
      ids: [],
      rejected: ["identity_mismatch"],
    });
    commands = [signed(command)];
    assert.deepEqual((await child("commands")).result, { ids: [command.id], rejected: [] });
    const replay = (await child("commands")).result;
    assert.deepEqual(replay, { ids: [command.id], rejected: ["replayed"] });
    assert.deepEqual((await child("ack", [command.id])).result.ids, []);
    assert.deepEqual(acknowledgments, [command.id]);
    observe(
      "mTLS command polling persists one pending signed job across process restart and acknowledges it",
      true,
      { commandId: command.id, replay, acknowledgments },
    );
    const dbPath = join(daemonRoot, "commands.db");
    let db = openDatabase(dbPath);
    db.run(
      "CREATE TRIGGER reject_pending BEFORE INSERT ON pending_command BEGIN SELECT RAISE(ABORT,'fixture rejection'); END",
    );
    db.close();
    commands = [signed({ ...command, id: "command-two" })];
    await child("commands", [], configPath, false);
    db = openDatabase(dbPath);
    assert.equal(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM command_receipt WHERE id='command-two'",
        )
        .get()!.count,
      0,
    );
    db.run("DROP TRIGGER reject_pending");
    db.close();
    assert.deepEqual((await child("commands")).result.ids, ["command-two"]);
    observe(
      "pending-job storage failure rolls back the durable replay receipt before retry",
      true,
      { retriedCommandId: "command-two" },
    );
    db = openDatabase(dbPath);
    db.run(
      "CREATE TRIGGER reject_ack BEFORE UPDATE ON pending_command WHEN NEW.acknowledged=2 BEGIN SELECT RAISE(ABORT,'fixture acknowledgment rejection'); END",
    );
    db.close();
    await child("ack", ["command-two"], configPath, false);
    db = openDatabase(dbPath);
    assert.equal(
      db
        .query<{ acknowledged: number }, []>(
          "SELECT acknowledged FROM pending_command WHERE id='command-two'",
        )
        .get()!.acknowledged,
      1,
    );
    db.run("DROP TRIGGER reject_ack");
    db.close();
    commands = [];
    assert.deepEqual((await child("commands")).result.ids, []);
    assert.deepEqual(acknowledgments, ["command-one", "command-two", "command-two"]);
    db = openDatabase(dbPath);
    assert.equal(
      db
        .query<{ acknowledged: number }, []>(
          "SELECT acknowledged FROM pending_command WHERE id='command-two'",
        )
        .get()!.acknowledged,
      2,
    );
    db.close();
    observe(
      "accepted command acknowledgment survives local completion failure without redelivering work after restart",
      true,
      { commandId: "command-two", acknowledgments: [...acknowledgments], pending: [] },
    );
    const before = readFileSync(statePath);
    wrongRenewalIdentity = true;
    await child("renew", [], configPath, false);
    assert(before.equals(readFileSync(statePath)));
    wrongRenewalIdentity = false;
    wrongRenewalKey = true;
    await child("renew", [], configPath, false);
    assert(before.equals(readFileSync(statePath)));
    wrongRenewalKey = false;
    const renewed = (await child("renew")).result;
    assert.notEqual(renewed.fingerprint, identity.fingerprint);
    const heartbeat = (await child("heartbeat")).result;
    assert.equal(heartbeat.fingerprint, renewed.fingerprint);
    assert.equal(peers.at(-1), renewed.fingerprint);
    observe(
      "certificate replacement rejects identity changes atomically and survives restart with actual mTLS",
      true,
      {
        previousFingerprint: identity.fingerprint,
        renewedFingerprint: renewed.fingerprint,
        peerFingerprint: peers.at(-1),
      },
    );
    const unacknowledged = {
      ...command,
      id: "unacknowledged-before-expiry",
      issuedAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
    };
    commands = [signed(unacknowledged)];
    assert.deepEqual((await child("commands")).result.ids, ["unacknowledged-before-expiry"]);
    active.clear();
    const count = peers.length;
    await child("heartbeat", [], configPath, false);
    assert.equal(peers.length, count);
    const hostileConfig = join(root, "wrong-host.json");
    writeFileSync(
      hostileConfig,
      JSON.stringify({
        ...config,
        root: join(root, "wrong-host"),
        controlPlaneUrl: config.controlPlaneUrl.replace("localhost", "127.0.0.1"),
      }),
    );
    const enrollmentCount = enrollmentBodies.length;
    await child("pair", [], hostileConfig, false);
    assert.equal(enrollmentBodies.length, enrollmentCount);
    const untrustedConfig = join(root, "wrong-trust.json");
    writeFileSync(
      untrustedConfig,
      JSON.stringify({
        ...config,
        root: join(root, "wrong-trust"),
        serverCa: authority.certificate,
      }),
    );
    await child("pair", [], untrustedConfig, false);
    assert.equal(enrollmentBodies.length, enrollmentCount);
    assert(enrollmentBodies.every((body) => !JSON.stringify(body).includes("PRIVATE KEY")));
    assert.equal(new Set(pids).size, pids.length);
    observe(
      "revoked runner identity, mismatched server hostname and untrusted server CA fail before application delivery",
      true,
      {
        processCount: pids.length,
        revocationRejected: peers.length === count,
        hostnameRejected: enrollmentBodies.length === enrollmentCount,
      },
    );
    const expired = await authority.issue(csr, 60_000, Date.now() - 120_000);
    const state = JSON.parse(readSecretFile(statePath)!);
    writeSecretFile(statePath, JSON.stringify({ ...state, certificate: expired.pem }));
    const previousState = readFileSync(statePath);
    const previousKey = readFileSync(keyPath);
    const open = () =>
      openRunnerDaemon({
        ...config,
        trustedKeys: new Map([["coordinator", signingKey.publicKey]]),
        allowedRepositories: ["local/fixture"],
      });
    let daemon = open();
    const expiredStatus = daemon.status();
    assert.equal(expiredStatus.phase, "expired");
    assert.throws(() => daemon.pendingCommands());
    for (const action of [
      () => daemon.heartbeat(),
      () => daemon.pollCommands(),
      () => daemon.renewCertificate(),
      () => daemon.acknowledgeCommand(command.id),
    ])
      await assert.rejects(action);
    assert.equal(peers.length, count);
    approved = false;
    runnerId = "runner-repaired";
    assert.equal((await daemon.beginPairing("Repaired Linux runner")).phase, "pending");
    daemon.close();
    assert.equal((await child("claim")).result.phase, "pending");
    assert(previousState.equals(readFileSync(statePath)));
    approved = true;
    daemon = open();
    runnerId = state.runnerId;
    await assert.rejects(() => daemon.pollPairing(), /new runner identity/);
    assert(previousState.equals(readFileSync(statePath)));
    runnerId = "runner-repaired";
    db = openDatabase(dbPath);
    db.run(
      "CREATE TRIGGER reject_clear BEFORE DELETE ON command_receipt BEGIN SELECT RAISE(ABORT,'fixture clear rejection'); END",
    );
    await assert.rejects(() => daemon.pollPairing());
    assert.equal(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM pending_command").get()!.count,
      3,
    );
    assert(previousState.equals(readFileSync(statePath)));
    db.run("DROP TRIGGER reject_clear");
    renameSync(statePath, `${statePath}.saved`);
    mkdirSync(statePath);
    try {
      await assert.rejects(() => daemon.pollPairing());
      assert.equal(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM command_receipt").get()!
          .count,
        0,
      );
    } finally {
      rmSync(statePath, { recursive: true });
      renameSync(`${statePath}.saved`, statePath);
      daemon.close();
      db.close();
    }
    assert.equal((await child("claim")).result.runnerId, runnerId);
    assert(previousKey.equals(readFileSync(keyPath)));
    commands = [signed(unacknowledged)];
    const afterRepair = (await child("commands")).result;
    assert.deepEqual(afterRepair, { ids: [], rejected: ["identity_mismatch"] });
    observe(
      "expired runner explicitly re-pairs after interrupted replacement without reviving old work",
      true,
      {
        expiredStatus,
        runnerId,
        afterRepair,
        retainedLocalKey: previousKey.equals(readFileSync(keyPath)),
      },
    );
    const short = await authority.issue(csr, 60_000, Date.now() - 50_000);
    active.add(short.fingerprint);
    const repaired = JSON.parse(readSecretFile(statePath)!);
    writeSecretFile(statePath, JSON.stringify({ ...repaired, certificate: short.pem }));
    let clock = Date.now();
    daemon = openRunnerDaemon({
      ...config,
      now: () => clock,
      trustedKeys: new Map([["coordinator", signingKey.publicKey]]),
      allowedRepositories: ["local/fixture"],
    });
    const raceCommand = {
      ...command,
      id: "command-race",
      runnerId,
      expiresAt: Date.now() + 60_000,
    };
    commands = [signed(raceCommand)];
    await daemon.pollCommands();
    const entered: Promise<void>[] = [];
    const releases: (() => void)[] = [];
    for (const path of [
      "/v1/commands",
      "/v1/heartbeat",
      "/v1/certificate",
      "/v1/commands/command-race/ack",
    ]) {
      let signal!: () => void;
      entered.push(
        new Promise<void>((resolve) => {
          signal = resolve;
        }),
      );
      held.set(path, {
        entered: signal,
        wait: new Promise<void>((resolve) => releases.push(resolve)),
      });
    }
    const outstanding = [
      daemon.pollCommands(),
      daemon.heartbeat(),
      daemon.renewCertificate(),
      daemon.acknowledgeCommand(raceCommand.id),
    ];
    const settled = Promise.allSettled(outstanding);
    await Promise.all(entered);
    clock += 20_000;
    await daemon.beginPairing("Concurrent repair");
    runnerId = "runner-race-repaired";
    await daemon.pollPairing();
    const replacement = readFileSync(statePath);
    releases.forEach((release) => release());
    const responses = await settled;
    assert(
      responses.every(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          /identity changed/.test(result.reason.message),
      ),
    );
    assert(replacement.equals(readFileSync(statePath)));
    assert.deepEqual(daemon.pendingCommands(), []);
    daemon.close();
    held.clear();
    const expiredAgain = await authority.issue(csr, 60_000, Date.now() - 120_000);
    const latest = JSON.parse(readSecretFile(statePath)!);
    writeSecretFile(statePath, JSON.stringify({ ...latest, certificate: expiredAgain.pem }));
    daemon = open();
    assert.equal(daemon.status().phase, "expired");
    clock = Date.now();
    enrollmentNow = () => clock;
    const beforeFreshPair = enrollmentBodies.length;
    const freshPairing = await daemon.beginPairing("Fresh recovery after restart");
    assert(freshPairing.phase === "pending");
    assert.equal(freshPairing.expiresAt, clock + challengeTtl);
    assert.equal(enrollmentBodies.length, beforeFreshPair + 1);
    daemon.close();
    observe(
      "re-pair fences older HTTPS responses and ignores consumed recovery after restart",
      true,
      {
        rejectedResponses: responses.map((response) =>
          response.status === "rejected" ? response.reason.message : response.status,
        ),
        runnerId,
        freshPairingRequests: enrollmentBodies.length - beforeFreshPair,
        fencedReplacement: responses.every((response) => response.status === "rejected"),
      },
    );
    daemon = openRunnerDaemon({
      ...config,
      now: () => clock,
      trustedKeys: new Map([["coordinator", signingKey.publicKey]]),
      allowedRepositories: ["local/fixture"],
    });
    let enteredClaim!: () => void;
    let releaseClaim!: () => void;
    const claimEntered = new Promise<void>((resolve) => {
      enteredClaim = resolve;
    });
    heldClaim = {
      entered: enteredClaim,
      wait: new Promise<void>((resolve) => {
        releaseClaim = resolve;
      }),
    };
    runnerId = "runner-stale-approval";
    const lateClaim = daemon.pollPairing();
    const lateResult = lateClaim.then(
      () => "approved",
      (error: Error) => error.message,
    );
    await claimEntered;
    clock += 65_000;
    challengeTtl = 180_000;
    await daemon.beginPairing("Replace expired challenge");
    const freshRecovery = readFileSync(join(daemonRoot, "identity", "recovery.json"));
    const unchangedState = readFileSync(statePath);
    releaseClaim();
    assert.match(await lateResult, /pairing changed/);
    assert(freshRecovery.equals(readFileSync(join(daemonRoot, "identity", "recovery.json"))));
    assert(unchangedState.equals(readFileSync(statePath)));
    heldClaim = undefined;
    runnerId = "runner-current-approval";
    assert.equal((await daemon.pollPairing()).phase, "paired");
    daemon.close();
    observe("expired pairing response cannot overwrite a newer challenge", true, {
      lateResponse: await lateResult,
      runnerId,
    });
    enrollmentNow = Date.now;
    const enrollmentRaces: string[] = [];
    for (const approve of [false, true]) {
      const expiredIdentity = await authority.issue(csr, 60_000, Date.now() - 120_000);
      const previousIdentity = JSON.parse(readSecretFile(statePath)!);
      writeSecretFile(
        statePath,
        JSON.stringify({ ...previousIdentity, certificate: expiredIdentity.pem }),
      );
      daemon = open();
      let enteredEnrollment!: () => void;
      let releaseEnrollment!: () => void;
      const enrollmentEntered = new Promise<void>((resolve) => {
        enteredEnrollment = resolve;
      });
      heldEnrollment = {
        entered: enteredEnrollment,
        wait: new Promise<void>((resolve) => {
          releaseEnrollment = resolve;
        }),
      };
      const lateEnrollment = daemon.beginPairing("Delayed enrollment").then(
        () => "pending",
        (error: Error) => error.message,
      );
      await enrollmentEntered;
      heldEnrollment = undefined;
      await daemon.beginPairing("Current enrollment");
      runnerId = approve ? "runner-new-enrollment" : "runner-pending-enrollment";
      if (approve) await daemon.pollPairing();
      const currentState = readFileSync(statePath);
      const currentRecovery = readFileSync(join(daemonRoot, "identity", "recovery.json"));
      releaseEnrollment();
      const result = await lateEnrollment;
      assert.match(result, /pairing changed/);
      assert(currentState.equals(readFileSync(statePath)));
      assert(currentRecovery.equals(readFileSync(join(daemonRoot, "identity", "recovery.json"))));
      if (!approve) await daemon.pollPairing();
      enrollmentRaces.push(result);
      daemon.close();
    }
    observe("late enrollment cannot replace a newer challenge or approved identity", true, {
      rejectedResponses: enrollmentRaces,
    });
  } finally {
    await listener.stop();
    await new Promise<void>((resolve) => enrollment.close(() => resolve()));
  }
}

async function serverIdentity(root: string): Promise<{ key: string; cert: string }> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const process = Bun.spawn(
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
      stderr: "pipe",
    },
  );
  const [exit, error] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  assert.equal(exit, 0, error);
  return {
    key: readFileSync(join(root, "server.key"), "utf8"),
    cert: readFileSync(join(root, "server.pem"), "utf8"),
  };
}
