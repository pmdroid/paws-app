import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
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
  RunnerEventSchema,
  RunnerResultSchema,
  signRunnerCommand,
  type RunnerCommand,
  type SignedRunnerCommand,
} from "../../src/runner-protocol";
import { z } from "zod";

export async function probeRunnerDaemon(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
): Promise<void> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const authority = await initializeRunnerAuthority(join(root, "issuer"));
  const foreignClient = await createRunnerKey(join(root, "foreign-client"));
  const server = await serverIdentity(join(root, "server"));
  const signingKey = generateKeyPairSync("ed25519");
  const publicKeyPem = signingKey.publicKey.export({ type: "spki", format: "pem" }).toString();
  let signingKeys: unknown = [{ keyId: "coordinator", publicKeyPem }];
  const active = new Set<string>();
  const peers: string[] = [];
  const enrollmentBodies: Record<string, unknown>[] = [];
  const acknowledgments: string[] = [];
  const workRequests: { path: string; body: unknown; bearer: boolean }[] = [];
  const heartbeatBodies: unknown[] = [];
  const runGrant = randomBytes(32).toString("base64url");
  const repositoryToken = `ghs_${randomBytes(32).toString("base64url")}`;
  const generations = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
  let heartbeatResponse: unknown = { leases: [], fenced: [] };
  let grantResponse: unknown = { token: runGrant, expiresAt: Date.now() + 60_000 };
  let eventResponse: unknown;
  let repositoryResponse: Record<string, unknown> | undefined;
  let answersResponse: unknown;
  let resultResponse: unknown;
  let resultFenced = false;
  const results = new Set<string>();
  let deliveredEvents = 0;
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
              signingKeys,
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
      if (path === "/v1/heartbeat") {
        const body = await request.json();
        heartbeatBodies.push(body);
        if (/"waiting"|"runtimes"|"agents"/.test(JSON.stringify(body)))
          return Response.json({}, { status: 403 });
        return deliver(heartbeatResponse);
      }
      if (path === "/v1/runs/run-one/grant") {
        assert.equal(request.headers.get("authorization"), null);
        const body = z
          .strictObject({ commandId: z.literal("command-one"), generation: generations })
          .parse(await request.json());
        assert.equal(body.generation, 1);
        workRequests.push({ path, body, bearer: false });
        return deliver(grantResponse);
      }
      if (path === "/v1/events") {
        assert.equal(request.headers.get("authorization"), `Bearer ${runGrant}`);
        assert.equal(request.headers.get("content-type"), "application/json");
        const body = z
          .strictObject({
            runId: z.literal("run-one"),
            generation: generations,
            sequence: generations,
            event: RunnerEventSchema,
          })
          .parse(await request.json());
        assert.equal(body.generation, 1);
        assert.equal(body.sequence, 1);
        workRequests.push({ path, body, bearer: true });
        deliveredEvents++;
        return deliver(eventResponse ?? { duplicate: deliveredEvents > 1 });
      }
      if (path === "/v1/runs/run-one/repository-credential") {
        assert.equal(request.headers.get("authorization"), `Bearer ${runGrant}`);
        const body = z
          .strictObject({ generation: generations, access: z.enum(["read", "write"]) })
          .parse(await request.json());
        assert.equal(body.generation, 1);
        workRequests.push({ path, body, bearer: true });
        return deliver({
          token: repositoryToken,
          expiresAt: Date.now() + 60_000,
          remoteUrl: "https://github.com/local/fixture.git",
          branch: body.access === "write" ? "paws/local-1" : null,
          ...repositoryResponse,
        });
      }
      if (path === "/v1/runs/run-one/result") {
        assert.equal(request.headers.get("authorization"), `Bearer ${runGrant}`);
        const body = z
          .strictObject({ generation: generations, result: RunnerResultSchema })
          .parse(await request.json());
        assert.equal(body.generation, 1);
        assert.equal(body.result.commandId, "command-one");
        if (resultFenced)
          return Response.json({ error: repositoryToken, code: "fenced" }, { status: 409 });
        const payload = JSON.stringify(body);
        const duplicate = results.has(payload);
        results.add(payload);
        workRequests.push({ path, body, bearer: true });
        return Response.json(resultResponse ?? { duplicate });
      }
      if (path === "/v1/runs/run-one/answers") {
        assert.equal(request.headers.get("authorization"), `Bearer ${runGrant}`);
        const body = z
          .strictObject({
            generation: generations,
            after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          })
          .parse(await request.json());
        assert.equal(body.generation, 1);
        workRequests.push({ path, body, bearer: true });
        return Response.json(
          answersResponse ?? {
            answers: [
              { sequence: 2, answer: "Include archived rows." },
              { sequence: 5, answer: "Keep existing columns." },
            ].filter((answer) => answer.sequence > body.after),
          },
        );
      }
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
        signingKeys,
      });
    },
  });
  const daemonRoot = join(root, "daemon");
  const config = {
    root: daemonRoot,
    controlPlaneUrl: `https://localhost:${address.port}`,
    runnerApiUrl: `https://localhost:${listener.port}`,
    serverCa: server.cert,
    signingKey: publicKeyPem,
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
      assert(!stdout.includes(runGrant));
      assert(!stderr.includes(runGrant));
      assert(!stdout.includes(repositoryToken));
      assert(!stderr.includes(repositoryToken));
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
    const statePath = join(daemonRoot, "identity", "state.json");
    const pendingState = readFileSync(statePath);
    const validSigningKeys = signingKeys;
    const malformedSigningKeys = [
      undefined,
      [],
      Array.from({ length: 9 }, (_, index) => ({ keyId: `key-${index}`, publicKeyPem })),
      [
        { keyId: "duplicate", publicKeyPem },
        { keyId: "duplicate", publicKeyPem },
      ],
      [{ keyId: "coordinator", publicKeyPem: `${publicKeyPem}\n` }],
      [{ keyId: "coordinator", publicKeyPem: "invalid" }],
      [{ keyId: "coordinator", publicKeyPem, unexpected: true }],
      [{ keyId: "coordinator", publicKeyPem: server.cert }],
      [
        {
          keyId: "coordinator",
          publicKeyPem: signingKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        },
      ],
      [
        {
          keyId: "coordinator",
          publicKeyPem: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
            .publicKey.export({ type: "spki", format: "pem" })
            .toString(),
        },
      ],
    ];
    for (const malformed of malformedSigningKeys) {
      signingKeys = malformed;
      await child("claim", [], configPath, false);
      assert(pendingState.equals(readFileSync(statePath)));
    }
    signingKeys = validSigningKeys;
    const identity = (await child("claim")).result;
    assert.equal(identity.runnerId, runnerId);
    assert.equal(identity.workspaceId, workspaceId);
    const keyPath = join(daemonRoot, "identity", "runner-key.pem");
    assert.deepEqual(JSON.parse(readSecretFile(statePath)!).signingKeys, signingKeys);
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
    assert.deepEqual(heartbeatBodies.at(-1), {});
    const configured = openRunnerDaemon({
      ...config,
      allowedRepositories: ["local/fixture"],
      concurrency: 4,
      sampleHost: () => ({ cpuPercent: 12.5, osId: "debian", runnerVersion: "1.4.0" }),
    });
    try {
      assert.equal(configured.capacity(), 4);
      await configured.heartbeat();
      assert.deepEqual(heartbeatBodies.at(-1), {
        cpuPercent: 12.5,
        osId: "debian",
        runnerVersion: "1.4.0",
        capacity: 4,
        ceiling: 4,
      });
      heartbeatResponse = { leases: [], fenced: [], concurrency: 2 };
      await configured.heartbeat();
      assert.equal(configured.capacity(), 2);
      heartbeatResponse = { leases: [], fenced: [], concurrency: 9 };
      await configured.heartbeat();
      assert.equal((heartbeatBodies.at(-1) as { capacity: number }).capacity, 2);
      assert.equal(configured.capacity(), 4);
      const pending = {
        name: "impeccable",
        version: "2.5.0",
        sha256: "a".repeat(64),
        status: "pending" as const,
      };
      const reported = { ...pending, waiting: 2 };
      await configured.heartbeat([reported]);
      assert.deepEqual((heartbeatBodies.at(-1) as { skills?: unknown }).skills, [pending]);
      // A Paws release without runtimes refuses them; the skills still go through.
      const runtime = { tool: "node", version: "22", status: "installed" as const };
      const sent = heartbeatBodies.length;
      await configured.heartbeat([reported], [runtime]);
      const attempts = heartbeatBodies.slice(sent) as { skills?: unknown; runtimes?: unknown }[];
      assert.deepEqual(
        attempts.map((body) => [body.skills, body.runtimes]),
        [
          [[reported], [runtime]],
          [[reported], undefined],
          [[pending], undefined],
        ],
      );
      // A Paws release without coding agent updates refuses the agents; the rest still goes through.
      const agent = { agent: "claude" as const, version: "2.0.0", status: "current" as const };
      const before = heartbeatBodies.length;
      await configured.heartbeat([reported], [runtime], [agent]);
      const withAgents = heartbeatBodies.slice(before) as {
        skills?: unknown;
        runtimes?: unknown;
        agents?: unknown;
      }[];
      assert.deepEqual(
        withAgents.map((body) => [body.skills, body.runtimes, body.agents]),
        [
          [[reported], [runtime], [agent]],
          [[reported], [runtime], undefined],
          [[reported], undefined, undefined],
          [[pending], undefined, undefined],
        ],
      );
    } finally {
      heartbeatResponse = { leases: [], fenced: [] };
      configured.close();
    }
    assert.throws(() => openRunnerDaemon({ ...config, allowedRepositories: [], concurrency: 0 }));
    assert.throws(() => openRunnerDaemon({ ...config, allowedRepositories: [], concurrency: 17 }));
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
    heartbeatResponse = {
      leases: [{ runId: "run-one", generation: 1, expiresAt: Date.now() + 60_000 }],
      fenced: [{ runId: "run-old", generation: 2 }],
    };
    assert.deepEqual((await child("leases")).result, heartbeatResponse);
    assert.deepEqual((await child("events")).result, {
      first: { duplicate: false },
      replay: { duplicate: true },
    });
    assert.equal(workRequests.length, 3);
    assert(!JSON.stringify(workRequests).includes(runGrant));
    assert(!readFileSync(statePath, "utf8").includes(runGrant));
    assert(!readFileSync(dbPath).includes(Buffer.from(runGrant)));
    observe(
      "mTLS heartbeat returns validated leases and fences while events use a separate in-memory bearer grant",
      true,
      { heartbeat: heartbeatResponse, requests: [...workRequests], deliveredEvents },
    );
    commands = [signed({ ...command, id: "command-review", type: "review", runId: "run-review" })];
    assert.deepEqual((await child("commands")).result.ids, [
      "unacknowledged-before-expiry",
      "command-review",
    ]);
    await child("ack", ["command-review"]);
    commands = [];
    const requestsBeforeInvalid = peers.length;
    assert.deepEqual((await child("invalid-work")).result, { rejected: 9 });
    assert.equal(peers.length, requestsBeforeInvalid);
    const validHeartbeat = heartbeatResponse;
    for (const malformed of [
      { leases: [], fenced: [], unexpected: true },
      { leases: [{ runId: "run-one", generation: 0, expiresAt: 1 }], fenced: [] },
    ]) {
      heartbeatResponse = malformed;
      await child("leases", [], configPath, false);
    }
    heartbeatResponse = validHeartbeat;
    const validGrant = grantResponse;
    for (const malformed of [
      { token: runGrant, expiresAt: 1 },
      { token: runGrant, expiresAt: Date.now() + 60_000, credential: "forbidden" },
      { token: "invalid", expiresAt: Date.now() + 60_000 },
    ]) {
      grantResponse = malformed;
      await child("events", [], configPath, false);
    }
    grantResponse = validGrant;
    eventResponse = { duplicate: false, unexpected: true };
    await child("events", [], configPath, false);
    eventResponse = undefined;
    observe(
      "invalid work identities, generations, bearer tokens and server response fields fail closed",
      true,
      {
        localRejections: 9,
        malformedHeartbeatResponses: 2,
        malformedGrantResponses: 3,
        malformedEventResponses: 1,
      },
    );
    assert.deepEqual((await child("repository")).result, [
      { remoteUrl: "https://github.com/local/fixture.git", branch: null },
      { remoteUrl: "https://github.com/local/fixture.git", branch: "paws/local-1" },
    ]);
    const invalidCredentials = [
      { expiresAt: 1 },
      { expiresAt: Date.now() + 2 * 60 * 60_000 },
      { token: "contains whitespace" },
      { token: "contains\u0000control" },
      { remoteUrl: "https://github.com/local/other.git" },
      { remoteUrl: "https://user@github.com/local/fixture.git" },
      { remoteUrl: "https://github.com/local/fixture.git?token=forbidden" },
      { branch: null },
      { branch: "main" },
      { branch: "paws/../main" },
      { branch: "paws/unsafe..branch" },
      { branch: "paws/unsafe.lock" },
      { credential: "forbidden" },
    ];
    for (const invalid of invalidCredentials) {
      repositoryResponse = invalid;
      await child("repository-write", [], configPath, false);
    }
    repositoryResponse = { branch: "paws/local-1" };
    await child("repository-read", [], configPath, false);
    repositoryResponse = undefined;
    assert(!readFileSync(statePath, "utf8").includes(repositoryToken));
    assert(!readFileSync(dbPath).includes(Buffer.from(repositoryToken)));
    observe(
      "repository credentials bind the admitted signed repository and access mode without persisting tokens",
      true,
      {
        readBranch: null,
        writeBranch: "paws/local-1",
        malformedResponsesRejected: invalidCredentials.length + 1,
      },
    );
    assert.deepEqual((await child("results")).result, {
      first: { duplicate: false },
      replay: { duplicate: true },
    });
    assert.deepEqual((await child("answers")).result, {
      first: {
        answers: [
          { sequence: 2, answer: "Include archived rows." },
          { sequence: 5, answer: "Keep existing columns." },
        ],
      },
      next: { answers: [] },
    });
    const beforeInvalidResults = peers.length;
    assert.deepEqual((await child("invalid-results")).result, { rejected: 6 });
    assert.equal(peers.length, beforeInvalidResults);
    resultResponse = { duplicate: false, rawOutput: "forbidden" };
    await child("results", [], configPath, false);
    resultResponse = undefined;
    const malformedAnswers = [
      { answers: [{ sequence: 0, answer: "invalid" }] },
      { answers: [{ sequence: 1, answer: "" }] },
      { answers: [{ sequence: 2, answer: "valid", rawOutput: "forbidden" }] },
      {
        answers: [
          { sequence: 2, answer: "first" },
          { sequence: 2, answer: "duplicate" },
        ],
      },
      {
        answers: [
          { sequence: 5, answer: "first" },
          { sequence: 2, answer: "out of order" },
        ],
      },
      { answers: [], unexpected: true },
    ];
    for (const malformed of malformedAnswers) {
      answersResponse = malformed;
      await child("answers", [], configPath, false);
    }
    answersResponse = { answers: [{ sequence: 2, answer: "older than requested cursor" }] };
    await child("answers", [], configPath, false);
    answersResponse = undefined;
    resultFenced = true;
    assert.deepEqual((await child("fenced-result")).result, { status: 409 });
    resultFenced = false;
    observe(
      "mTLS results and ordered question answers validate strict payloads and expose safe numeric fencing status",
      true,
      {
        resultPayloads: results.size,
        localRejections: 6,
        malformedResponses: malformedAnswers.length + 2,
        fencedStatus: 409,
      },
    );
    const legacyState = JSON.parse(readSecretFile(statePath)!);
    delete legacyState.signingKeys;
    writeSecretFile(statePath, JSON.stringify(legacyState));
    commands = [];
    const requestsBeforeMissingKeys = peers.length;
    await child("commands", [], configPath, false);
    assert.equal(peers.length, requestsBeforeMissingKeys);
    await child("heartbeat");
    const pinnedConfig = join(root, "pinned.json");
    writeFileSync(pinnedConfig, JSON.stringify({ ...config, pinned: true }));
    assert.deepEqual((await child("commands", [], pinnedConfig)).result.ids, [
      "unacknowledged-before-expiry",
    ]);
    await child("renew");
    const enrolledState = readFileSync(statePath);
    for (const malformed of malformedSigningKeys) {
      signingKeys = malformed;
      await child("renew", [], configPath, false);
      assert(enrolledState.equals(readFileSync(statePath)));
    }
    signingKeys = validSigningKeys;
    const wrongPins = join(root, "wrong-pins.json");
    const rotatedKey = generateKeyPairSync("ed25519");
    const rotatedPem = rotatedKey.publicKey.export({ type: "spki", format: "pem" }).toString();
    writeFileSync(wrongPins, JSON.stringify({ ...config, pinned: true, signingKey: rotatedPem }));
    await child("commands", [], wrongPins, false);
    await child("renew", [], wrongPins, false);
    assert(enrolledState.equals(readFileSync(statePath)));
    signingKeys = [{ keyId: "rotated", publicKeyPem: rotatedPem }];
    const pinnedRejection = await child("renew", [], pinnedConfig, false);
    assert(enrolledState.equals(readFileSync(statePath)));
    await child("renew");
    commands = [
      signed({ ...command, id: "old-key-command" }),
      signRunnerCommand({
        keyId: "rotated",
        privateKey: rotatedKey.privateKey,
        command: { ...command, id: "rotated-key-command", expiresAt: Date.now() + 60_000 },
      }),
    ];
    const rotated = (await child("commands")).result;
    assert.deepEqual(rotated, {
      ids: ["unacknowledged-before-expiry", "rotated-key-command"],
      rejected: ["untrusted_key"],
    });
    await child("ack", ["rotated-key-command"]);
    observe(
      "verified enrollment bootstraps public signing keys and authenticated renewal atomically rotates admission trust",
      true,
      {
        malformedEnrollmentKeys: malformedSigningKeys.length,
        malformedRenewalKeys: malformedSigningKeys.length,
        legacyPollingRejectedBeforeRequest: requestsBeforeMissingKeys,
        pinnedRenewalError: pinnedRejection.error,
        rotated,
      },
    );
    signingKeys = validSigningKeys;
    await child("renew");
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
      5,
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
