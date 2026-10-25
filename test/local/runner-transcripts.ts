import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
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
import { createRunnerControl } from "../../src/runner-control";
import { createRunnerKey, initializeRunnerAuthority } from "../../src/runner-identity";
import { createRunnerWork } from "../../src/runner-work";
import type { RunnerCommand } from "../../src/runner-protocol";
import {
  createRunnerTranscripts,
  createRunnerTranscriptsHttp,
  createFakeRunnerTranscriptObjects,
  RUNNER_TRANSCRIPT_CHUNK_BYTES,
  type RunnerTranscriptObjects,
} from "../../src/runner-transcripts";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerTranscripts(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
  providedObjects?: RunnerTranscriptObjects,
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
  const authority = await initializeRunnerAuthority(authorityRoot);
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
  work.assign(command);
  const token = work.issueGrant({
    runnerId,
    runId: run.id,
    commandId: command.id,
    generation: 1,
  }).token;
  const access = { runnerId, runId: run.id, token };
  const objects = providedObjects ?? createFakeRunnerTranscriptObjects();
  let readFault: "throw" | "short" | "long" | "digest" | undefined;
  const faultObjects: RunnerTranscriptObjects = {
    ...objects,
    read(key) {
      if (readFault === "throw") throw new Error("Injected object read outage");
      if (readFault) {
        const source = objects.read(key);
        return new ReadableStream({
          async start(controller) {
            const bytes = Buffer.from(await new Response(source).arrayBuffer());
            if (readFault === "short") controller.enqueue(bytes.subarray(0, bytes.length - 1));
            if (readFault === "long") controller.enqueue(Buffer.concat([bytes, Buffer.from("x")]));
            if (readFault === "digest") {
              bytes[0] = bytes[0]! ^ 1;
              controller.enqueue(bytes);
            }
            controller.close();
          },
        });
      }
      return objects.read(key);
    },
  };
  let transcripts = createRunnerTranscripts({ db, work, objects: faultObjects });
  const execution = { id: workspaceId(now) };
  const marker = "RAW_TRANSCRIPT_ONLY_1ab8f9";
  const line = Buffer.from(
    `${JSON.stringify({ type: "acp", event: { type: "session_update", sessionId: "session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${"x".repeat(8000)}${marker}` } } } })}\n`,
  );
  const bytes = Buffer.concat(
    Array.from({ length: Math.ceil(10_485_760 / line.length) }, () => line),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    let lastChunk: Parameters<typeof transcripts.upload>[1] | undefined;
    for (let offset = 0; offset < bytes.length; offset += RUNNER_TRANSCRIPT_CHUNK_BYTES) {
      const part = bytes.subarray(offset, offset + RUNNER_TRANSCRIPT_CHUNK_BYTES);
      const chunk = {
        generation: 1,
        executionId: execution.id,
        offset,
        sha256: createHash("sha256").update(part).digest("hex"),
        data: part.toString("base64"),
      };
      const receipt = await transcripts.upload(access, chunk);
      assert.equal(receipt.offset, offset + part.length);
      assert.equal(receipt.duplicate, false);
      assert.equal((await transcripts.upload(access, chunk)).duplicate, true);
      assert.equal((await transcripts.upload(access, chunk)).duplicate, true);
      lastChunk = chunk;
    }
    assert(lastChunk);
    await assert.rejects(
      transcripts.upload(access, {
        ...lastChunk,
        data: Buffer.from("changed").toString("base64"),
        sha256: createHash("sha256").update("changed").digest("hex"),
      }),
    );
    transcripts = createRunnerTranscripts({ db, work, objects: faultObjects });
    const finish = {
      generation: 1,
      executionId: execution.id,
      offset: bytes.length,
      sizeBytes: bytes.length,
      sha256,
    };
    const storageHttp = createRunnerTranscriptsHttp(transcripts);
    const storageRequest = () =>
      new Request(`https://runner.invalid/v1/runs/${run.id}/transcript/finish`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(finish),
      });
    const faultStatuses: unknown[] = [];
    for (const fault of ["throw", "short", "long", "digest"] as const) {
      readFault = fault;
      const failed = await storageHttp(storageRequest(), runnerId);
      assert.equal(failed!.status, 503);
      assert.equal(transcripts.read(run.id, 1)!.uri, null);
      faultStatuses.push({ fault, status: failed!.status });
    }
    readFault = undefined;
    const lock = openDatabase(path);
    lock.exec("BEGIN IMMEDIATE");
    db.exec("PRAGMA busy_timeout=1");
    try {
      assert.equal((await storageHttp(storageRequest(), runnerId))!.status, 503);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      db.exec("PRAGMA busy_timeout=5000");
    }
    assert.equal((await storageHttp(storageRequest(), runnerId))!.status, 200);
    observe("storage reads and SQLite busy failures preserve same-grant finish retry", true, {
      faults: faultStatuses,
      sqliteBusyStatus: 503,
      recoveredStatus: 200,
    });
    const result = await transcripts.finish(access, finish);
    const objectKey = `paws/transcripts/${workspace.id}/${command.id}/${finish.executionId}/acp.jsonl`;
    assert.equal(result.uri, objects.uri(objectKey));
    assert.equal((await transcripts.finish(access, finish)).uri, result.uri);
    const readBack = await transcripts.download(run.id, 1);
    for (const fault of ["throw", "short", "long", "digest"] as const) {
      readFault = fault;
      await assert.rejects(transcripts.download(run.id, 1), {
        message: "Runner transcript storage is unavailable",
      });
    }
    readFault = undefined;
    assert.deepEqual(await transcripts.download(run.id, 1), bytes);
    await assert.rejects(transcripts.download(run.id, 1, workspaceId()));
    assert.deepEqual(readBack, bytes);
    const rawDb = Buffer.concat([readFileSync(path), readFileSync(`${path}-wal`)]);
    assert(!rawDb.includes(Buffer.from(marker)));
    observe("a ten-megabyte raw transcript is retrievable while SQLite holds only metadata", true, {
      transcriptBytes: bytes.length,
      metadataChunks: Math.ceil(bytes.length / RUNNER_TRANSCRIPT_CHUNK_BYTES),
      sha256,
      rawMarkerAbsentFromDatabaseAndWal: true,
      uri: result.uri,
      storage: providedObjects ? "provided object storage" : "in-memory fake object storage",
    });
    await assert.rejects(transcripts.upload({ ...access, token: "A".repeat(43) }, lastChunk));
    await assert.rejects(transcripts.upload({ ...access, runnerId: "another-runner" }, lastChunk));
    await assert.rejects(transcripts.upload({ ...access, runId: "another-run" }, lastChunk));
    await assert.rejects(transcripts.upload(access, { ...lastChunk, offset: 1 }));
    await assert.rejects(transcripts.finish(access, { ...finish, executionId: workspaceId() }));
    const http = createRunnerTranscriptsHttp(transcripts);
    const response = await http(
      new Request(`https://fixture.invalid/v1/runs/${run.id}/transcript/chunks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(lastChunk),
      }),
      runnerId,
    );
    assert.equal(response!.status, 200);
    assert.deepEqual(await response!.json(), { offset: bytes.length, duplicate: true });
    const oversized = await http(
      new Request(`https://fixture.invalid/v1/runs/${run.id}/transcript/chunks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "x".repeat(737_281),
      }),
      runnerId,
    );
    assert.equal(oversized!.status, 403);
    observe(
      "transcript retries are immutable and current runner, assignment and grant checks cannot be bypassed",
      true,
      {
        exactReplayAcceptedThreeTimes: true,
        changedReplayDenied: true,
        crossRunDenied: true,
        crossRunnerDenied: true,
        wrongGrantDenied: true,
        changedExecutionDenied: true,
        oversizedStatus: oversized!.status,
      },
    );
    now += 60_001;
    await assert.rejects(transcripts.finish(access, finish));
    await assert.rejects(transcripts.upload(access, lastChunk));
    observe(
      "an expired lease cannot republish a transcript or replay a formerly valid chunk",
      true,
      { expiredAfterMs: 60_001 },
    );
    await objects.write(objectKey, new Blob(["changed object"]));
    await assert.rejects(transcripts.download(run.id, 1));
    observe(
      "retrieving a changed transcript object fails its accepted byte count and digest",
      true,
      { changedObjectDenied: true },
    );
    const emptyCommand = {
      ...command,
      id: workspaceId(now),
      issuedAt: now,
      expiresAt: now + 300_000,
      generation: 2,
    };
    work.assign(emptyCommand);
    const emptyToken = work.issueGrant({
      runnerId,
      runId: run.id,
      commandId: emptyCommand.id,
      generation: 2,
    }).token;
    await transcripts.finish(
      { ...access, token: emptyToken },
      {
        generation: 2,
        executionId: workspaceId(now),
        offset: 0,
        sizeBytes: 0,
        sha256: createHash("sha256").update("").digest("hex"),
      },
    );
    assert.equal((await transcripts.download(run.id, 2)).length, 0);
    work.finish(run.id, 2);
    observe("an empty transcript produces a complete retrievable zero-byte object", true, {
      transcriptBytes: 0,
    });
    const next = { ...emptyCommand, id: workspaceId(now), generation: 3 };
    work.assign(next);
    const nextToken = work.issueGrant({
      runnerId,
      runId: run.id,
      commandId: next.id,
      generation: 3,
    }).token;
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const interrupted = createRunnerTranscripts({
      db,
      work,
      objects: {
        ...objects,
        async write(key, content) {
          entered();
          await held;
          await objects.write(key, content);
        },
      },
    });
    const tiny = Buffer.from("fixture");
    const pendingWrite = interrupted.upload(
      { ...access, token: nextToken },
      {
        generation: 3,
        executionId: workspaceId(now),
        offset: 0,
        sha256: createHash("sha256").update(tiny).digest("hex"),
        data: tiny.toString("base64"),
      },
    );
    const deniedWrite = assert.rejects(pendingWrite);
    await writing;
    control.setStatus(principal, runnerId, "revoked");
    release();
    await deniedWrite;
    assert.equal(interrupted.read(run.id, 3)!.sizeBytes, 0);
    assert.equal(interrupted.read(run.id, 3)!.uri, null);
    observe(
      "revocation during object storage I/O prevents durable acceptance after the write returns",
      true,
      { acceptedBytes: 0, transcriptUri: null },
    );
  } finally {
    db.close();
  }
}
