import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:https";
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
import { createRunnerControl } from "../../src/runner-control";
import {
  createRunnerKey,
  initializeRunnerAuthority,
  startRunnerListener,
} from "../../src/runner-identity";
import { createRunnerWork } from "../../src/runner-work";
import {
  RunnerCommandSchema,
  RunnerInputFilesSchema,
  RUNNER_INPUT_CHUNK_BYTES,
  type RunnerCommand,
} from "../../src/runner-protocol";
import { createRunnerInputStore } from "../../src/runner-inputs";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerInputs(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
  contextPrompt?: string,
  initializeAuthority = initializeRunnerAuthority,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "paws.sqlite");
  const db = openDatabase(path);
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "transcript-org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "transcript-org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  const authorityRoot = join(root, "issuer");
  const authority = await initializeAuthority(authorityRoot);
  now = Date.now();
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: authorityRoot,
    disconnect() {},
    now: () => now,
  });
  const client = await createRunnerKey(join(root, "client"));
  const pending = await control.beginPairing({ name: "VM", csr: client.csr });
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const { runnerId } = await control.approvePairing(principal, pending.code);
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  const identity = control.claimPairing(pending.id, pending.claim);
  assert.equal(identity.status, "approved");
  if (identity.status !== "approved") throw new Error("Pairing must be approved");
  const keys = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: keys.privateKey,
    now: () => now,
  });
  const item = insertQueuedItem(db, {
    id: "transcript-item",
    now,
    sessionKey: "transcript-session",
  });
  const { run } = beginImplementRun(db, item.id, now);
  recordLinearInstallation(db, {
    organizationId: "transcript-org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "transcript-session",
    teamId: "team",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, "transcript-session", item.delegationId, { actorId: "owner" });
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
  const command: Extract<RunnerCommand, { type: "run" }> = {
    id: workspaceId(),
    runnerId,
    workspaceId: workspace.id,
    issuedAt: now,
    expiresAt: now + 300_000,
    type: "run",
    runId: run.id,
    itemId: item.id,
    generation: 1,
    repository,
    profile: { agent: "codex", model: "scripted" },
    prompt: "Produce the fixture.",
  };

  const storageRoot = join(root, "inputs");
  const inputs = createRunnerInputStore({ root: storageRoot, work });
  const bytes = Buffer.alloc(10 * 1024 * 1024 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const original = Buffer.from(bytes);
  const supplied = [
    { path: ".paws-linear-inputs/turn/日本語.bin", mimeType: "application/octet-stream", bytes },
    { path: "empty.txt", mimeType: "text/plain", bytes: Buffer.alloc(0) },
  ];
  command.inputFiles = inputs.stage(command.id, supplied);
  if (contextPrompt !== undefined) {
    command.promptContext = inputs.stagePrompt(command.id, contextPrompt);
    assert.deepEqual(inputs.stagePrompt(command.id, contextPrompt), command.promptContext);
    assert.throws(() => inputs.stagePrompt(command.id, contextPrompt + "changed"));
  }
  bytes.fill(0);
  assert.deepEqual(
    inputs.stage(command.id, [{ ...supplied[0]!, bytes: original }, supplied[1]!]),
    command.inputFiles,
  );
  assert.throws(() => inputs.stage(command.id, supplied));
  assert.equal(RunnerCommandSchema.parse(command).type, "run");
  assert.equal(RunnerCommandSchema.parse({ ...command, type: "review" }).type, "review");
  work.assign(command);
  const grant = () =>
    work.issueGrant({ runnerId, runId: run.id, commandId: command.id, generation: 1 }).token;
  let token = grant();
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
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  assert.equal(await openssl.exited, 0);
  const tls = {
    key: readFileSync(serverKey, "utf8"),
    cert: readFileSync(serverCert, "utf8"),
    ca: authority.certificate,
  };
  const listener = await startRunnerListener({
    tls,
    hostname: "127.0.0.1",
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
        (await inputs.fetch(input, control.authenticate(peer).id)) ??
        new Response(null, { status: 404 })
      );
    },
  });
  const payload = { commandId: command.id, generation: 1, fileId: 0, offset: 0 };
  const send = (
    body: unknown,
    override: { token?: string; runId?: string; channel?: "context" } = {},
  ) =>
    new Promise<{ status: number; body: { data: string; sha256: string } }>((resolve, reject) => {
      const raw = JSON.stringify(body);
      const outgoing = request(
        {
          hostname: "localhost",
          port: listener.port,
          path: `/v1/runs/${override.runId ?? run.id}/${override.channel ?? "inputs"}/read`,
          ca: tls.cert,
          cert: identity.certificate,
          key: readFileSync(client.keyPath, "utf8"),
          agent: false,
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${override.token ?? token}`,
            "content-length": Buffer.byteLength(raw),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on("end", () => {
            try {
              resolve({
                status: incoming.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
              });
            } catch (error) {
              reject(error);
            }
          });
          incoming.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(raw);
    });
  try {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < original.length; offset += RUNNER_INPUT_CHUNK_BYTES) {
      const response = await send({ ...payload, offset });
      assert.equal(response.status, 200);
      const part = Buffer.from(response.body.data, "base64");
      assert.equal(createHash("sha256").update(part).digest("hex"), response.body.sha256);
      chunks.push(part);
    }
    assert.deepEqual(Buffer.concat(chunks), original);
    assert.equal((await send({ ...payload, fileId: 1 })).body.data, "");
    observe(
      "real mTLS transfers binary and Unicode-named inputs over bounded digest-bound chunks with exact immutable retry",
      true,
      { bytes: original.length, chunks: chunks.length, sha256: command.inputFiles![0]!.sha256 },
    );
    for (const inputPath of [
      "/absolute",
      "../escape",
      "a/../b",
      "a//b",
      "a\\b",
      ".git/config",
      "A/.GiT/config",
      "nul\0file",
    ]) {
      assert.throws(() => inputs.stage(workspaceId(), [{ ...supplied[1]!, path: inputPath }]));
    }
    assert.throws(() =>
      inputs.stage(workspaceId(), [
        { ...supplied[1]!, path: "a" },
        { ...supplied[1]!, path: "a/b" },
      ]),
    );
    assert.throws(() =>
      inputs.stage(workspaceId(), [
        { ...supplied[1]!, path: "same" },
        { ...supplied[1]!, path: "same" },
      ]),
    );
    const twentyOne = Array.from({ length: 21 }, (_, id) => ({
      ...supplied[1]!,
      path: `${id}.txt`,
    }));
    assert.equal(inputs.stage(workspaceId(), twentyOne).length, 21);
    assert.throws(() =>
      inputs.stage(workspaceId(), [...twentyOne, { ...supplied[1]!, path: "21.txt" }]),
    );
    const maximum = { ...supplied[1]!, bytes: Buffer.alloc(20 * 1024 * 1024) };
    assert.equal(inputs.stage(workspaceId(), [maximum])[0]!.sizeBytes, 20 * 1024 * 1024);
    assert.throws(() =>
      inputs.stage(workspaceId(), [{ ...maximum, bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }]),
    );
    assert.throws(() => RunnerInputFilesSchema.parse([{ ...command.inputFiles![0], id: 1 }]));
    assert.throws(() => RunnerCommandSchema.parse({ ...command, type: "probe" }));
    observe(
      "manifests enforce twenty-one transfer files and twenty MiB, normalized disjoint safe paths, canonical IDs and no health attachment authority",
      true,
      { maxFiles: 21, maxBytes: 20 * 1024 * 1024 },
    );
    for (const changed of [
      { ...payload, commandId: workspaceId() },
      { ...payload, generation: 2 },
      { ...payload, fileId: 19 },
      { ...payload, offset: 1 },
      { ...payload, offset: 20 * 1024 * 1024 },
      { ...payload, unknown: true },
    ])
      assert.notEqual((await send(changed)).status, 200);
    assert.notEqual((await send(payload, { token: "A".repeat(43) })).status, 200);
    assert.notEqual((await send(payload, { runId: "wrong-run" })).status, 200);
    assert.throws(() => inputs.read({ runnerId: "wrong-runner", runId: run.id, token }, payload));
    const directory = join(storageRoot, createHash("sha256").update(command.id).digest("hex"));
    const file = join(directory, "0.bytes");
    assert.equal(readFileSync(file).equals(original), true);
    assert.equal(readdirSync(directory).length, contextPrompt === undefined ? 3 : 5);
    const saved = join(directory, "saved");
    renameSync(file, saved);
    symlinkSync(saved, file);
    assert.equal((await send(payload)).status, 403);
    unlinkSync(file);
    renameSync(saved, file);
    chmodSync(file, 0o644);
    assert.equal((await send(payload)).status, 403);
    chmodSync(file, 0o600);
    writeFileSync(file, "corrupt");
    assert.equal((await send(payload)).status, 503);
    writeFileSync(file, original);
    assert.equal((await send(payload)).status, 200);
    observe(
      "wrong peer/run/command/generation/grant and malformed ranges fail closed; unsafe files deny and repaired storage retries exactly",
      true,
      { symlink: 403, mode: 403, corruption: 503, repaired: 200 },
    );
    if (contextPrompt !== undefined) {
      const contextPayload = { commandId: command.id, generation: 1, offset: 0 };
      const expected = Buffer.from(contextPrompt, "utf8");
      const contextChunks: Buffer[] = [];
      for (let offset = 0; offset < expected.length; offset += RUNNER_INPUT_CHUNK_BYTES) {
        const response = await send({ ...contextPayload, offset }, { channel: "context" });
        assert.equal(response.status, 200);
        assert.deepEqual(
          await send({ ...contextPayload, offset }, { channel: "context" }),
          response,
        );
        const part = Buffer.from(response.body.data, "base64");
        assert.equal(createHash("sha256").update(part).digest("hex"), response.body.sha256);
        contextChunks.push(part);
      }
      assert.deepEqual(Buffer.concat(contextChunks), expected);
      const restarted = JSON.parse(
        execFileSync(
          process.execPath,
          ["--no-env-file", "test/local/runner-prompt-context-restart.ts"],
          {
            input: JSON.stringify({
              dbPath: path,
              root: storageRoot,
              runnerId,
              runId: run.id,
              token,
              commandId: command.id,
              generation: 1,
              now,
              sizeBytes: expected.length,
            }),
            encoding: "utf8",
          },
        ),
      );
      assert.deepEqual(restarted, command.promptContext);
      observe(
        "restored large UTF-8 prompt transfers exactly over real mTLS and survives fresh-process store/database reopen",
        true,
        { ...restarted, characters: contextPrompt.length, chunks: contextChunks.length },
      );
      for (const changed of [
        { ...contextPayload, fileId: 0 },
        { ...contextPayload, generation: 2 },
        { ...contextPayload, commandId: "wrong" },
        { ...contextPayload, offset: 1 },
      ])
        assert.notEqual((await send(changed, { channel: "context" })).status, 200);
      assert.notEqual(
        (await send(contextPayload, { channel: "context", token: "A".repeat(43) })).status,
        200,
      );
      const promptFile = join(directory, "prompt.bytes");
      writeFileSync(promptFile, "corrupt");
      assert.equal((await send(contextPayload, { channel: "context" })).status, 503);
      writeFileSync(promptFile, expected);
      assert.equal((await send(contextPayload, { channel: "context" })).status, 200);
      const savedPrompt = join(directory, "saved-prompt");
      renameSync(promptFile, savedPrompt);
      symlinkSync(savedPrompt, promptFile);
      assert.equal((await send(contextPayload, { channel: "context" })).status, 403);
      unlinkSync(promptFile);
      renameSync(savedPrompt, promptFile);
      assert.throws(() => inputs.stagePrompt(workspaceId(), "\uD800"));
      assert.throws(() => inputs.stagePrompt(workspaceId(), "x".repeat(64 * 1024 * 1024 + 1)));
      assert.throws(() => RunnerCommandSchema.parse({ ...command, prompt: contextPrompt }));
      observe(
        "prompt context enforces signed command/range/grant, UTF-8 and separate byte limits while repaired storage retries exactly",
        true,
        {
          corruption: 503,
          repaired: 200,
          symlink: 403,
          maximumBytes: 64 * 1024 * 1024,
          inlineMaximumCharacters: 65536,
        },
      );
    }
    now += 60001;
    assert.notEqual((await send(payload)).status, 200);
    now -= 60001;
    let releaseBody: () => void = () => undefined;
    const incoming = new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(Buffer.from(JSON.stringify(payload)));
          controller.close();
        };
      },
    });
    const pendingRead = inputs.fetch(
      new Request(`https://localhost/v1/runs/${run.id}/inputs/read`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: incoming,
      }),
      runnerId,
    );
    await Promise.resolve();
    db.run("UPDATE workspace_member SET active=0 WHERE workspace_id=? AND user_id=?", [
      workspace.id,
      userId,
    ]);
    if (contextPrompt !== undefined) {
      const deniedContext = await send(
        { commandId: command.id, generation: 1, offset: 0 },
        { channel: "context" },
      );
      assert.notEqual(deniedContext.status, 200);
    }
    releaseBody();
    const denied = await pendingRead;
    assert.notEqual(denied!.status, 200);
    observe(
      "membership invalidation during request-body I/O and subsequent lease expiry prevent private input disclosure",
      true,
      { revokedDuringRead: denied!.status, expired: true },
    );
  } finally {
    await listener.stop();
    db.close();
  }
}
if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-inputs-"));
  const observations: unknown[] = [];
  await probeRunnerInputs(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(
    join(root, "observations.json"),
    JSON.stringify({ passed: true, observations }, null, 2),
  );
  console.log(JSON.stringify({ root, observations }));
}
