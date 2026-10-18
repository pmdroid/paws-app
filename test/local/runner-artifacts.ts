import assert from "node:assert/strict";
import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import { createRunnerControl } from "../../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../../src/runner-identity";
import type { RunnerCommand, RunnerArtifact } from "../../src/runner-protocol";
import { createRunnerArtifactStore, RUNNER_ARTIFACT_CHUNK_BYTES } from "../../src/runner-artifacts";
import { createRunnerWork } from "../../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

type Observe = (name: string, passed: boolean, observed: unknown) => void;
export async function probeRunnerArtifacts(root: string, observe: Observe) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  try {
    const now = Date.now();
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: "owner",
      name: "Owner",
      email: "owner@example.invalid",
    });
    const bootstrap = issueWorkspaceBootstrap(db, "fixture-org", now);
    const workspace = consumeWorkspaceBootstrap(db, {
      id: workspaceId(),
      organizationId: "fixture-org",
      name: "Fixture",
      userId,
      tokenHash: workspaceTokenHash(bootstrap),
      now,
    });
    const authorityRoot = join(root, "issuer");
    const authority = await initializeRunnerAuthority(authorityRoot);
    const control = createRunnerControl({
      db,
      authority,
      certificateRoot: authorityRoot,
      disconnect() {},
    });
    const client = await createRunnerKey(join(root, "client"));
    const pending = await control.beginPairing({ name: "Result channel proof", csr: client.csr });
    const runnerId = (
      await control.approvePairing(
        { workspaceId: workspace.id, userId, role: "owner", authenticatedAt: now, teamIds: [] },
        pending.code,
      )
    ).runnerId;
    const item = insertQueuedItem(db, { id: "result-item", now, sessionKey: "result-session" });
    const { run } = beginImplementRun(db, item.id, now);
    recordLinearInstallation(db, {
      organizationId: "fixture-org",
      oauthClientId: "fixture",
      appUserId: "app",
      sessionId: "result-session",
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "result-session", item.delegationId, { actorId: "owner" });
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
    const keys = generateKeyPairSync("ed25519");
    const work = createRunnerWork({ db, keyId: "fixture", privateKey: keys.privateKey });
    const command: Extract<RunnerCommand, { type: "run" }> = {
      type: "run",
      id: workspaceId(),
      runnerId,
      workspaceId: workspace.id,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 300000,
      runId: run.id,
      itemId: item.id,
      generation: 1,
      repository,
      profile: { agent: "codex", model: "scripted" },
      prompt: "Publish evidence",
    };
    work.assign(command);
    const access = {
      runnerId,
      runId: run.id,
      token: work.issueGrant({
        runnerId,
        runId: run.id,
        commandId: command.id,
        generation: 1,
      }).token,
    };
    const storage = join(root, "artifacts");
    const artifacts = createRunnerArtifactStore({ root: storage, work });
    const bytes = Buffer.alloc(RUNNER_ARTIFACT_CHUNK_BYTES + 19, 65);
    const descriptor: RunnerArtifact = {
      id: randomUUID(),
      path: "evidence/report.txt",
      displayName: "Report",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      attachToIssue: true,
    };
    const chunk = (index: number) => ({
      generation: 1,
      artifact: descriptor,
      index,
      data: bytes
        .subarray(index * RUNNER_ARTIFACT_CHUNK_BYTES, (index + 1) * RUNNER_ARTIFACT_CHUNK_BYTES)
        .toString("base64"),
    });
    const request = (value: unknown, token = access.token) =>
      new Request(`https://runner.invalid/v1/runs/${run.id}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(value),
      });
    assert.equal((await artifacts.fetch(request(chunk(0)), runnerId))!.status, 200);
    assert.throws(() => artifacts.snapshot(run.id, 1, descriptor));
    assert.equal((await artifacts.fetch(request(chunk(1)), runnerId))!.status, 200);
    assert.equal((await artifacts.fetch(request(chunk(0)), runnerId))!.status, 200);
    const snapshot = artifacts.snapshot(run.id, 1, descriptor);
    assert.deepEqual(Buffer.from(await snapshot.bytes.arrayBuffer()), bytes);
    assert.equal(snapshot.sha256, descriptor.sha256);
    assert.equal(snapshot.evidence, undefined);
    const videoBytes = Buffer.alloc(21 * RUNNER_ARTIFACT_CHUNK_BYTES + 7, 66);
    const video: RunnerArtifact = {
      id: randomUUID(),
      path: "videos/flow.webm",
      displayName: "flow.webm",
      mimeType: "video/webm",
      sizeBytes: videoBytes.length,
      sha256: createHash("sha256").update(videoBytes).digest("hex"),
      attachToIssue: false,
      evidence: { checkId: "ui-video", attempt: 1, headCommit: "c".repeat(40) },
    };
    const videoChunk = (index: number, artifact: RunnerArtifact = video) => ({
      generation: 1,
      artifact,
      index,
      data: videoBytes
        .subarray(index * RUNNER_ARTIFACT_CHUNK_BYTES, (index + 1) * RUNNER_ARTIFACT_CHUNK_BYTES)
        .toString("base64"),
    });
    const { evidence: _evidence, ...plain } = video;
    assert.equal(
      (await artifacts.fetch(request(videoChunk(0, { ...plain, id: randomUUID() })), runnerId))!
        .status,
      403,
    );
    for (let index = 0; index < 22; index++)
      assert.equal((await artifacts.fetch(request(videoChunk(index)), runnerId))!.status, 200);
    const recorded = artifacts.snapshot(run.id, 1, video);
    assert.deepEqual(Buffer.from(await recorded.bytes.arrayBuffer()), videoBytes);
    assert.deepEqual(recorded.evidence, video.evidence);
    work.event({
      ...access,
      generation: 1,
      sequence: 1,
      event: { type: "artifact", artifact: descriptor },
    });
    observe(
      "private chunked evidence is retrievable with exact replay and descriptor-bound events",
      true,
      {
        bytes: bytes.length,
        chunks: 2,
        sha256: snapshot.sha256,
        exactReplay: 200,
      },
    );
    assert.equal((await artifacts.fetch(request(chunk(0), "a".repeat(43)), runnerId))!.status, 403);
    assert.equal(
      (await artifacts.fetch(request({ ...chunk(0), generation: 2 }), runnerId))!.status,
      409,
    );
    assert.equal(
      (await artifacts.fetch(
        request({ ...chunk(0), artifact: { ...descriptor, displayName: "Changed" } }),
        runnerId,
      ))!.status,
      403,
    );
    for (const path of [
      ".env",
      "credentials/token.txt",
      "evidence/key.pem",
      "../outside",
      ".git/config",
    ]) {
      assert.equal(
        (await artifacts.fetch(
          request({ ...chunk(0), artifact: { ...descriptor, id: randomUUID(), path } }),
          runnerId,
        ))!.status,
        403,
      );
    }
    assert.throws(() => artifacts.snapshot(run.id, 1, { ...descriptor, sha256: "a".repeat(64) }));
    const directory = join(storage, createHash("sha256").update(command.id).digest("hex"));
    assert.equal(statSync(storage).mode & 0o777, 0o700);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    const chunkPath = join(directory, `${descriptor.id}.0.bytes`);
    assert.equal(statSync(chunkPath).mode & 0o777, 0o600);
    const outside = join(root, "outside");
    writeFileSync(outside, readFileSync(chunkPath), { mode: 0o600 });
    rmSync(chunkPath);
    symlinkSync(outside, chunkPath);
    assert.throws(() => artifacts.snapshot(run.id, 1, descriptor));
    rmSync(chunkPath);
    writeFileSync(chunkPath, bytes.subarray(0, RUNNER_ARTIFACT_CHUNK_BYTES), { mode: 0o600 });
    chmodSync(chunkPath, 0o644);
    assert.throws(() => artifacts.snapshot(run.id, 1, descriptor));
    chmodSync(chunkPath, 0o600);
    assert.deepEqual(
      Buffer.from(await artifacts.snapshot(run.id, 1, descriptor).bytes.arrayBuffer()),
      bytes,
    );
    observe(
      "artifact grants, generation, secrets, mutations and redirected files are denied",
      true,
      {
        wrongGrant: 403,
        staleGeneration: 409,
        changedMetadata: 403,
        deniedPaths: 5,
        redirectedChunkDenied: true,
        publicModeDenied: true,
        rootMode: 0o700,
        directoryMode: 0o700,
        fileMode: 0o600,
      },
    );
    for (let count = 2; count < 20; count++)
      artifacts.upload({
        ...access,
        chunk: {
          generation: 1,
          index: 0,
          data: "",
          artifact: {
            ...descriptor,
            id: randomUUID(),
            sizeBytes: 0,
            sha256: createHash("sha256").update("").digest("hex"),
          },
        },
      });
    assert.throws(
      () =>
        artifacts.upload({
          ...access,
          chunk: {
            generation: 1,
            index: 0,
            data: "",
            artifact: {
              ...descriptor,
              id: randomUUID(),
              sizeBytes: 0,
              sha256: createHash("sha256").update("").digest("hex"),
            },
          },
        }),
      /count exceeds/,
    );
    work.finish(run.id, 1);
    assert.equal((await artifacts.fetch(request(chunk(0)), runnerId))!.status, 409);
    assert.throws(() => artifacts.snapshot(run.id, 1, descriptor));
    observe("per-command evidence is bounded and finished work loses storage access", true, {
      maximumArtifacts: 20,
      extraArtifactDenied: true,
      finishedGrant: 409,
    });
  } finally {
    db.close();
  }
}
