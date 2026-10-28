import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
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
import { RUNNER_ARTIFACT_CHUNK_BYTES } from "../../src/runner-artifacts";
import {
  createS3RunnerTranscriptObjects,
  RUNNER_TRANSCRIPT_CHUNK_BYTES,
} from "../../src/runner-transcripts";
import { S3Client } from "bun";
import { createFetchGitHubClient, createGitHubApp } from "../../src/github";
import { RUNNER_LEASE_GRACE_MS, type RunnerCommand } from "../../src/runner-protocol";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerCoordinatorData(
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
    role: "owner" as const,
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
  chmodSync(key, 0o600);
  const objectBytes = new Map<string, Uint8Array>();
  const objectRequests: string[] = [];
  const objectServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      assert(request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 "));
      const path = new URL(request.url).pathname;
      objectRequests.push(request.method);
      if (request.method === "PUT") {
        objectBytes.set(path, new Uint8Array(await request.arrayBuffer()));
        return new Response(null, { headers: { etag: '"fixture"' } });
      }
      return new Response(objectBytes.get(path) ?? null, {
        status: objectBytes.has(path) ? 200 : 404,
      });
    },
  });
  const objects = createS3RunnerTranscriptObjects({
    bucket: "fixture-transcripts",
    client: new S3Client({
      bucket: "fixture-transcripts",
      endpoint: `http://127.0.0.1:${objectServer.port}`,
      region: "fixture",
      accessKeyId: "fixture-access",
      secretAccessKey: "fixture-secret",
    }),
  });
  let mints = 0;
  const githubApi = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/app/installations/2/access_tokens");
      assert(request.headers.get("authorization")?.startsWith("Bearer "));
      const body = (await request.json()) as {
        repositories: string[];
        permissions: Record<string, string>;
      };
      assert.deepEqual(body.repositories, ["repository"]);
      mints++;
      return Response.json(
        {
          token: `fixture-installation-token-${mints}`,
          expires_at: new Date(now + 60_000).toISOString(),
          repository_selection: "selected",
          repositories: [{ name: "repository", full_name: "fixture/repository" }],
          permissions: body.permissions,
        },
        { status: 201 },
      );
    },
  });
  const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  let installation: string | null = "2";
  const coordinatorOptions = {
    root: issuer,
    tls,
    hostname: "127.0.0.1",
    now: () => now,
    onError: (error: unknown) => {
      throw error;
    },
    repositoryAccess: {
      github: createGitHubApp({
        appId: "1",
        privateKeyPem,
        client: createFetchGitHubClient(fetch, `http://127.0.0.1:${githubApi.port}`),
        now: () => new Date(now),
      }),
      installationForRepository: (repository: string) => {
        assert.equal(repository, "fixture/repository");
        return installation;
      },
    },
    transcripts: { objects, key: randomBytes(32) },
  };
  let coordinator = await openRunnerCoordinator({ ...coordinatorOptions, db, port: 0 });
  now = Date.now();
  const enrollment = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch: (request) => coordinator.hostEnrollment(request),
  });
  const options = {
    root: join(root, "daemon"),
    controlPlaneUrl: `https://localhost:${enrollment.port}`,
    runnerApiUrl: `https://localhost:${coordinator.port}`,
    serverCa: tls.cert,
    allowedRepositories: ["fixture/repository"],
    now: () => now,
  };
  let daemon = openRunnerDaemon(options);
  const statusError = (status: number) => (error: unknown) =>
    error instanceof RunnerRequestError && error.status === status;
  try {
    const enrollmentGrant = coordinator.control.createEnrollment(principal, {
      name: "Coordinator data",
    });
    const enrolled = await daemon.enroll("Coordinator data", enrollmentGrant.token);
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
    assert.equal((await daemon.pollCommands()).rejected.length, 0);
    assert.equal(daemon.pendingCommands()[0]?.id, command.id);
    const read = await daemon.repositoryCredential(run.id, 1, "read", grant.token);
    const write = await daemon.repositoryCredential(run.id, 1, "write", grant.token);
    assert.equal(read.branch, null);
    assert(write.branch?.startsWith("paws/"));
    assert.equal(mints, 2);
    installation = null;
    await assert.rejects(
      daemon.repositoryCredential(run.id, 1, "read", grant.token),
      statusError(403),
    );
    await assert.rejects(
      daemon.repositoryCredential(run.id, 1, "read", grant.token),
      new RegExp(
        `POST /v1/runs/${run.id}/repository-credential failed with HTTP 403 after \\d+ ms`,
      ),
    );
    installation = "2";
    assert.equal(mints, 2);
    observe(
      "normal coordinator routes repository credentials through scoped GitHub App minting",
      true,
      { mints, readBranch: null, writeBranch: write.branch, missingInstallation: 403 },
    );
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
    await daemon.uploadArtifact(run.id, artifactChunk(0), grant.token);
    await daemon.uploadArtifact(run.id, artifactChunk(1), grant.token);
    await daemon.uploadArtifact(run.id, artifactChunk(0), grant.token);
    assert.deepEqual(
      Buffer.from(await coordinator.artifacts.snapshot(run.id, 1, artifact).bytes.arrayBuffer()),
      bytes,
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
    await daemon.uploadTranscript(run.id, transcriptChunk(0), grant.token);
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
    const receipt = await daemon.finishTranscript(run.id, finish, grant.token);
    assert(receipt.uri.startsWith("s3://fixture-transcripts/"));
    assert.deepEqual(
      await coordinator.transcripts!.download(run.id, 1, executionId),
      transcriptBytes,
    );
    assert(objectRequests.includes("PUT") && objectRequests.includes("GET"));
    observe(
      "normal coordinator persists artifacts and transcripts through production disk and S3 adapters",
      true,
      {
        artifactBytes: bytes.length,
        transcriptBytes: transcriptBytes.length,
        signedS3Requests: objectRequests.length,
      },
    );
    daemon.close();
    const port = coordinator.port;
    await coordinator.stop();
    coordinator = await openRunnerCoordinator({ ...coordinatorOptions, db, port });
    daemon = openRunnerDaemon(options);
    assert.deepEqual(await daemon.uploadTranscript(run.id, transcriptChunk(0), grant.token), {
      offset: RUNNER_TRANSCRIPT_CHUNK_BYTES,
      duplicate: true,
    });
    assert.equal((await daemon.finishTranscript(run.id, finish, grant.token)).uri, receipt.uri);
    assert.deepEqual(
      Buffer.from(await coordinator.artifacts.snapshot(run.id, 1, artifact).bytes.arrayBuffer()),
      bytes,
    );
    const mintsBeforeDenial = mints;
    await assert.rejects(
      daemon.repositoryCredential(run.id, 1, "read", "A".repeat(43)),
      statusError(403),
    );
    await assert.rejects(
      daemon.uploadArtifact(run.id, artifactChunk(0), "A".repeat(43)),
      statusError(403),
    );
    await assert.rejects(
      daemon.uploadTranscript(run.id, { ...transcriptChunk(0), generation: 2 }, grant.token),
      statusError(409),
    );
    assert.equal(mints, mintsBeforeDenial);
    observe(
      "coordinator reopen retains exact receipts and enforces grants and generation fences",
      true,
      { retainedArtifact: true, retainedTranscript: true, wrongGrant: 403, staleGeneration: 409 },
    );
    now += 60_001 + RUNNER_LEASE_GRACE_MS;
    await assert.rejects(
      daemon.repositoryCredential(run.id, 1, "read", grant.token),
      statusError(409),
    );
    await assert.rejects(
      daemon.uploadArtifact(run.id, artifactChunk(0), grant.token),
      statusError(409),
    );
    await assert.rejects(daemon.finishTranscript(run.id, finish, grant.token), statusError(409));
    coordinator.control.setStatus(principal, runnerId, "revoked");
    await assert.rejects(daemon.uploadArtifact(run.id, artifactChunk(0), grant.token));
    observe("every mounted coordinator data route rejects expired leases and revoked peers", true, {
      leaseStatuses: [409, 409, 409],
      revokedPeerDenied: true,
    });
  } finally {
    daemon.close();
    await enrollment.stop(true);
    await coordinator.stop();
    await githubApi.stop(true);
    await objectServer.stop(true);
    db.close();
  }
}
