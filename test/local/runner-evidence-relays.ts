import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
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
} from "../../src/db";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon, RunnerRequestError } from "../../src/runner-daemon";
import { openRunnerAuthority, startRunnerListener } from "../../src/runner-identity";
import { createRunnerArtifactStore, RUNNER_ARTIFACT_CHUNK_BYTES } from "../../src/runner-artifacts";
import {
  createFakeRunnerTranscriptObjects,
  createRunnerTranscripts,
  createRunnerTranscriptsHttp,
  RUNNER_TRANSCRIPT_CHUNK_BYTES,
} from "../../src/runner-transcripts";
import { createRunnerWorkHttp } from "../../src/runner-work";
import { RUNNER_LEASE_GRACE_MS, type RunnerCommand } from "../../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerEvidenceRelays(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
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
    role: "admin" as const,
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
  await initializeRunnerCoordinator(issuer);
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
    fetch: (request) => coordinator.hostEnrollment(request),
  });
  const artifacts = createRunnerArtifactStore({
    root: join(root, "artifacts"),
    work: coordinator.work,
  });
  const objects = createFakeRunnerTranscriptObjects();
  const transcripts = createRunnerTranscripts({
    db,
    work: coordinator.work,
    objects,
    key: randomBytes(32),
  });
  const transcriptHttp = createRunnerTranscriptsHttp(transcripts);
  const workHttp = createRunnerWorkHttp(coordinator.work);
  let loseResponse = "";
  let malformed: unknown;
  let requests = 0;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let gate: Promise<void> | undefined;
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
        (await artifacts.fetch(request, runnerId)) ??
        (await transcriptHttp(request, runnerId)) ??
        (await workHttp(request, runnerId)) ??
        new Response(null, { status: 404 });
      if (gate) {
        entered!();
        await gate;
      }
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
    now: () => now,
  };
  let daemon = openRunnerDaemon(options);
  const statusError = (status: number) => (error: unknown) =>
    error instanceof RunnerRequestError && error.status === status;
  try {
    const enrollmentGrant = coordinator.control.createEnrollment(principal, {
      name: "Evidence relay",
    });
    const enrolled = await daemon.enroll("Evidence relay", enrollmentGrant.token);
    if (enrolled.phase !== "paired") throw new Error("Runner enrollment failed");
    const { runnerId } = enrolled;
    db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
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
    bindLinearSessionTask(db, "relay-session", item.delegationId, { actorId: "relay-owner" });
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
      type: "run",
      id: workspaceId(),
      runnerId,
      workspaceId: workspace.id,
      issuedAt: now,
      expiresAt: now + 300_000,
      runId: run.id,
      itemId: item.id,
      generation: 1,
      repository,
      profile: { agent: "codex", model: "scripted" },
      prompt: "Relay fixture evidence",
    };
    coordinator.work.assign(command);
    const grant = await daemon.issueRunGrant(run.id, { commandId: command.id, generation: 1 });
    const bytes = Buffer.alloc(RUNNER_ARTIFACT_CHUNK_BYTES + 19, 65);
    const artifact = {
      id: randomUUID(),
      path: "evidence/report.txt",
      displayName: "Report",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: hash(bytes),
      attachToIssue: true,
    };
    const artifactChunk = (index: number) => ({
      generation: 1,
      artifact,
      index,
      data: bytes
        .subarray(index * RUNNER_ARTIFACT_CHUNK_BYTES, (index + 1) * RUNNER_ARTIFACT_CHUNK_BYTES)
        .toString("base64"),
    });
    loseResponse = `/v1/runs/${run.id}/artifacts`;
    await assert.rejects(
      daemon.uploadArtifact(run.id, artifactChunk(0), grant.token),
      statusError(503),
    );
    daemon.close();
    daemon = openRunnerDaemon(options);
    assert.deepEqual(await daemon.uploadArtifact(run.id, artifactChunk(0), grant.token), {
      ok: true,
    });
    await daemon.uploadArtifact(run.id, artifactChunk(1), grant.token);
    assert.deepEqual(
      Buffer.from(await artifacts.snapshot(run.id, 1, artifact).bytes.arrayBuffer()),
      bytes,
    );
    await assert.rejects(
      daemon.uploadArtifact(
        run.id,
        {
          ...artifactChunk(0),
          artifact: { ...artifact, displayName: "Changed" },
        },
        grant.token,
      ),
      statusError(403),
    );
    const empty = (path: string) => ({
      generation: 1,
      index: 0,
      data: "",
      artifact: {
        ...artifact,
        id: randomUUID(),
        path,
        sizeBytes: 0,
        sha256: hash(Buffer.alloc(0)),
      },
    });
    for (let count = 1; count < 20; count++)
      await daemon.uploadArtifact(run.id, empty(`evidence/screen-${count}.png`), grant.token);
    await assert.rejects(
      daemon.uploadArtifact(run.id, empty("evidence/screen-20.png"), grant.token),
      (error: unknown) =>
        error instanceof RunnerRequestError &&
        error.status === 422 &&
        error.reason === "Paws keeps at most 20 artifacts per run",
    );
    observe(
      "mTLS artifact delivery survives a lost receipt and daemon reopen with immutable private disk bytes",
      true,
      {
        bytes: bytes.length,
        chunks: 2,
        lostReceipt: 503,
        changedMetadata: 403,
        sha256: artifact.sha256,
      },
    );
    const executionId = workspaceId(now);
    const transcriptBytes = Buffer.alloc(RUNNER_TRANSCRIPT_CHUNK_BYTES + 21, 66);
    const transcriptChunk = (offset: number) => {
      const part = transcriptBytes.subarray(offset, offset + RUNNER_TRANSCRIPT_CHUNK_BYTES);
      return {
        generation: 1,
        executionId,
        offset,
        sha256: hash(part),
        data: part.toString("base64"),
      };
    };
    loseResponse = `/v1/runs/${run.id}/transcript/chunks`;
    await assert.rejects(
      daemon.uploadTranscript(run.id, transcriptChunk(0), grant.token),
      statusError(503),
    );
    daemon.close();
    daemon = openRunnerDaemon(options);
    assert.deepEqual(await daemon.uploadTranscript(run.id, transcriptChunk(0), grant.token), {
      offset: RUNNER_TRANSCRIPT_CHUNK_BYTES,
      duplicate: true,
    });
    await daemon.uploadTranscript(
      run.id,
      transcriptChunk(RUNNER_TRANSCRIPT_CHUNK_BYTES),
      grant.token,
    );
    const finish = {
      generation: 1,
      executionId,
      offset: transcriptBytes.length,
      sizeBytes: transcriptBytes.length,
      sha256: hash(transcriptBytes),
    };
    loseResponse = `/v1/runs/${run.id}/transcript/finish`;
    await assert.rejects(daemon.finishTranscript(run.id, finish, grant.token), statusError(503));
    const receipt = await daemon.finishTranscript(run.id, finish, grant.token);
    assert.equal((await daemon.finishTranscript(run.id, finish, grant.token)).uri, receipt.uri);
    assert.deepEqual(await transcripts.download(run.id, 1, executionId), transcriptBytes);
    observe(
      "mTLS transcript chunks and finish retry preserve canonical metadata and exact object bytes",
      true,
      {
        bytes: transcriptBytes.length,
        chunks: 2,
        lostReceipts: 2,
        uri: receipt.uri,
        storage: "in-memory object-store fixture",
      },
    );
    const beforeInvalid = requests;
    await assert.rejects(daemon.uploadArtifact("../escape", artifactChunk(0), grant.token));
    await assert.rejects(
      daemon.uploadTranscript(
        run.id,
        { ...transcriptChunk(0), unexpected: true } as never,
        grant.token,
      ),
    );
    await assert.rejects(daemon.finishTranscript(run.id, finish, "invalid"));
    assert.equal(requests, beforeInvalid);
    for (const value of [{ ok: false }, { ok: true, extra: true }]) {
      malformed = value;
      await assert.rejects(daemon.uploadArtifact(run.id, artifactChunk(0), grant.token));
    }
    for (const value of [
      { offset: 1, duplicate: true },
      { offset: RUNNER_TRANSCRIPT_CHUNK_BYTES, duplicate: true, extra: true },
    ]) {
      malformed = value;
      await assert.rejects(daemon.uploadTranscript(run.id, transcriptChunk(0), grant.token));
    }
    for (const value of [{ uri: "" }, { uri: receipt.uri, extra: true }]) {
      malformed = value;
      await assert.rejects(daemon.finishTranscript(run.id, finish, grant.token));
    }
    malformed = undefined;
    await assert.rejects(
      daemon.uploadArtifact(run.id, artifactChunk(0), "A".repeat(43)),
      statusError(403),
    );
    await assert.rejects(
      daemon.uploadTranscript(run.id, { ...transcriptChunk(0), generation: 2 }, grant.token),
      statusError(409),
    );
    await assert.rejects(
      daemon.finishTranscript(run.id, { ...finish, generation: 2 }, grant.token),
      statusError(409),
    );
    observe(
      "relay requests and receipts fail closed and actual grants and generations remain enforced",
      true,
      {
        localRejections: 3,
        malformedReceipts: 6,
        wrongGrant: 403,
        staleGeneration: 409,
      },
    );
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const outstanding = daemon.uploadArtifact(run.id, artifactChunk(0), grant.token);
    const rejected = assert.rejects(outstanding, /closed/);
    await waiting;
    daemon.close();
    gate = undefined;
    release!();
    await rejected;
    daemon = openRunnerDaemon(options);
    await daemon.uploadArtifact(run.id, artifactChunk(0), grant.token);
    now += 60_001 + RUNNER_LEASE_GRACE_MS;
    await assert.rejects(
      daemon.uploadArtifact(run.id, artifactChunk(0), grant.token),
      statusError(409),
    );
    await assert.rejects(
      daemon.uploadTranscript(run.id, transcriptChunk(0), grant.token),
      statusError(409),
    );
    await assert.rejects(daemon.finishTranscript(run.id, finish, grant.token), statusError(409));
    observe(
      "an old daemon response is fenced after close and expired leases deny every evidence relay",
      true,
      {
        heldResponseRejected: true,
        expiredRelayStatuses: [409, 409, 409],
        verifiedMtlsPeers: peers.size,
      },
    );
  } finally {
    release?.();
    daemon.close();
    await listener.stop();
    await enrollment.stop(true);
    await coordinator.stop();
    db.close();
  }
}
