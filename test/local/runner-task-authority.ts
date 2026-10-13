import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
  saveTaskMode,
} from "../../src/db";
import { migrations } from "../../src/db/migrations";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon, RunnerRequestError } from "../../src/runner-daemon";
import {
  RunnerCommandSchema,
  type RunnerCommand,
  type RunnerResult,
} from "../../src/runner-protocol";
import { createFakeRunnerTranscriptObjects } from "../../src/runner-transcripts";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";

export async function probeRunnerTaskAuthority(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
  downloadInputs = false,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  db.run("CREATE TABLE schema_migration(id TEXT PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT");
  for (const migration of migrations.slice(
    0,
    migrations.findIndex((value) => value.id === "038_runner_task_commands"),
  )) {
    if (migration.foreignKeys === false) db.run("PRAGMA foreign_keys=OFF");
    db.transaction(() => {
      db.run(migration.sql);
      db.run("INSERT INTO schema_migration VALUES(?,?)", [migration.id, Date.now()]);
    }).immediate();
    db.run("PRAGMA foreign_keys=ON");
  }
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "task-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "task-org",
    name: "Tasks",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "task-org", now)),
    now,
  });
  const identity = join(root, "identity");
  await initializeRunnerCoordinator(identity);
  const key = join(root, "server.key");
  const cert = join(root, "server.pem");
  const certificate = Bun.spawnSync([
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
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  assert.equal(certificate.exitCode, 0, certificate.stderr.toString());
  chmodSync(key, 0o600);
  const tls = { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  const objects = createFakeRunnerTranscriptObjects();
  const mints: string[] = [];
  let onMint: (() => void) | undefined;
  const coordinator = await openRunnerCoordinator({
    root: identity,
    db,
    tls,
    hostname: "127.0.0.1",
    port: 0,
    now: () => now,
    transcriptObjects: objects,
    repositoryAccess: {
      github: {
        async mintInstallationToken(input) {
          assert(input.access);
          mints.push(input.access);
          onMint?.();
          return {
            token: "fixture-read-token",
            repository: input.repository,
            expiresAt: now + 3_600_000,
          };
        },
      },
      installationForRepository: () => "fixture-installation",
    },
    onError(error) {
      throw error;
    },
  });
  now = Date.now();
  const enrollment = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch: (request) => coordinator.enrollment(request),
  });
  const daemon = openRunnerDaemon({
    root: join(root, "daemon"),
    controlPlaneUrl: `https://localhost:${enrollment.port}`,
    runnerApiUrl: `https://localhost:${coordinator.port}`,
    serverCa: tls.cert,
    allowedRepositories: ["fixture/repository"],
    now: () => now,
  });
  const status = (code: number) => (error: unknown) =>
    error instanceof RunnerRequestError && error.status === code;
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  try {
    const pairing = await daemon.beginPairing("Response task proof");
    assert(pairing.phase === "pending");
    const { runnerId } = await coordinator.control.approvePairing(
      { workspaceId: workspace.id, userId, role: "owner", authenticatedAt: now, teamIds: [] },
      pairing.code,
    );
    assert.equal((await daemon.pollPairing()).phase, "paired");
    db.run(
      "INSERT INTO runner_command(ordinal,id,runner_id,kind,envelope,expires_at,acknowledged_at) VALUES(12,'retained-task-migration',?,'probe','{}',?,?)",
      [runnerId, now, now],
    );
    db.run("UPDATE sqlite_sequence SET seq=1000 WHERE name='runner_command'");
    db.run("INSERT INTO runner_health_result VALUES('retained-task-migration',?,'{}',?)", [
      runnerId,
      now,
    ]);
    const rows = db.query("SELECT * FROM runner_command").all();
    const catalog = () =>
      db
        .query(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name<>'runner_command' ORDER BY name",
        )
        .all();
    const before = catalog();
    migrate(db);
    assert.deepEqual(catalog(), before);
    assert.deepEqual(db.query("SELECT * FROM runner_command").all(), rows);
    assert.equal(
      db.query<{ command_id: string }, []>("SELECT command_id FROM runner_health_result").get()
        ?.command_id,
      "retained-task-migration",
    );
    assert.equal(
      db
        .query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name='runner_command'")
        .get()?.seq,
      1000,
    );
    assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), []);
    observe(
      "task migration preserves command rows, ordinal highwater, indexes, triggers and foreign keys",
      true,
      { rows: rows.length, highwater: 1000, objects: before.length },
    );
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    };
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "team",
    ]);
    let taskCount = 0;
    for (const purpose of ["answer", "artifact"] as const) {
      for (const withRepository of [false, true]) {
        const sessionId = `task-session-${++taskCount}`;
        const item = insertQueuedItem(db, {
          id: `task-item-${taskCount}`,
          now,
          sessionKey: sessionId,
        });
        const { run } = beginImplementRun(db, item.id, now);
        recordLinearInstallation(db, {
          organizationId: "task-org",
          oauthClientId: "fixture",
          appUserId: "app",
          sessionId,
          teamId: "team",
          observedAtMs: now,
        });
        bindLinearSessionTask(db, sessionId, item.epicId, { actorId: "task-owner" });
        saveTaskMode(db, item.id, purpose, 0, withRepository);
        if (withRepository) bindWorkItemRepository(db, item.id, repository);
        const scope = coordinator.work.scopeTask(run.id, workspace.id);
        const command: Extract<RunnerCommand, { type: "task" }> = {
          id: workspaceId(),
          type: "task",
          runnerId,
          workspaceId: workspace.id,
          issuedAt: now,
          expiresAt: now + 300_000,
          runId: run.id,
          itemId: item.id,
          generation: 1,
          sessionId,
          sessionGeneration: scope.sessionGeneration,
          taskModeGeneration: scope.taskModeGeneration,
          purpose,
          profile: { agent: "codex", model: "scripted" },
          prompt: "Respond in Linear",
          ...(withRepository ? { repository } : {}),
        };
        command.inputFiles = coordinator.inputs.stage(command.id, [
          {
            path: ".paws-linear-inputs/task/data.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("Private task attachment"),
          },
        ]);
        const preparedTaskPrompt =
          "Full prepared task prompt 日本語" +
          (downloadInputs && purpose === "answer" && !withRepository ? "x".repeat(20_972_002) : "");
        command.promptContext = coordinator.inputs.stagePrompt(command.id, preparedTaskPrompt);
        assert.equal(scope.purpose, purpose);
        assert.equal(scope.repository !== undefined, withRepository);
        assert.throws(() =>
          coordinator.work.assign({
            ...command,
            taskModeGeneration: command.taskModeGeneration + 1,
          }),
        );
        assert.throws(() =>
          coordinator.work.assign({ ...command, sessionGeneration: command.sessionGeneration + 1 }),
        );
        assert.throws(() => coordinator.work.assign({ ...command, sessionId: "other-session" }));
        assert.throws(() =>
          coordinator.work.assign({
            ...command,
            purpose: purpose === "answer" ? "artifact" : "answer",
          }),
        );
        assert.throws(() =>
          coordinator.work.assign({
            ...command,
            repository: withRepository ? undefined : repository,
          }),
        );
        assert.equal(
          RunnerCommandSchema.safeParse({ ...command, candidateSha: repository.baseSha }).success,
          false,
        );
        coordinator.work.assign(command);
        const poll = await daemon.pollCommands();
        assert(poll.commands.some((value) => value.type === "task" && value.id === command.id));
        assert.equal(poll.rejected.length, 0);
        const grant = await daemon.issueRunGrant(run.id, { commandId: command.id, generation: 1 });
        const access = { runnerId, runId: run.id, generation: 1, token: grant.token };
        assert.equal(coordinator.work.authorize(access).branch, null);
        if (downloadInputs) {
          let grantReads = 0;
          const downloaded = await daemon.readInputs(
            command,
            async () => {
              grantReads++;
              return grant.token;
            },
            new AbortController().signal,
          );
          assert.equal(
            Buffer.from(downloaded.inputFiles[0]!).toString("utf8"),
            "Private task attachment",
          );
          assert.equal(Buffer.from(downloaded.promptContext!).toString("utf8"), preparedTaskPrompt);
          assert.equal(grantReads, 1 + Math.ceil(Buffer.byteLength(preparedTaskPrompt) / 524_288));
          await assert.rejects(
            daemon.readInputs(
              { ...command, prompt: "forged" },
              async () => grant.token,
              new AbortController().signal,
            ),
          );
          const readContext = coordinator.inputs.readContext;
          try {
            for (const alter of [
              (value: ReturnType<typeof readContext>) => ({ ...value, commandId: "other-command" }),
              (value: ReturnType<typeof readContext>) => ({ ...value, offset: value.offset + 1 }),
              (value: ReturnType<typeof readContext>) => ({ ...value, data: "AAAA" }),
              (value: ReturnType<typeof readContext>) => {
                const bytes = Buffer.alloc(Buffer.from(value.data, "base64").length, 120);
                return { ...value, data: bytes.toString("base64"), sha256: hash(bytes) };
              },
            ]) {
              coordinator.inputs.readContext = (...args) => alter(readContext(...args));
              await assert.rejects(
                daemon.readInputs(command, async () => grant.token, new AbortController().signal),
              );
            }
          } finally {
            coordinator.inputs.readContext = readContext;
          }
          const interrupted = new AbortController();
          await assert.rejects(
            daemon.readInputs(
              command,
              async () => {
                interrupted.abort();
                return grant.token;
              },
              interrupted.signal,
            ),
          );
          const stopped = new AbortController();
          stopped.abort();
          await assert.rejects(daemon.readInputs(command, async () => grant.token, stopped.signal));
        }
        const inputRequest = { commandId: command.id, generation: 1, offset: 0 };
        assert.equal(
          Buffer.from(
            coordinator.inputs.read(access, { ...inputRequest, fileId: 0 }).data,
            "base64",
          ).toString("utf8"),
          "Private task attachment",
        );
        assert.equal(
          Buffer.from(coordinator.inputs.readContext(access, inputRequest).data, "base64").toString(
            "utf8",
          ),
          Buffer.from(preparedTaskPrompt).subarray(0, 524_288).toString("utf8"),
        );
        const minted = mints.length;
        if (withRepository)
          assert.equal(
            (await daemon.repositoryCredential(run.id, 1, "read", grant.token)).branch,
            null,
          );
        else await assert.rejects(daemon.repositoryCredential(run.id, 1, "read", grant.token));
        await assert.rejects(daemon.repositoryCredential(run.id, 1, "write", grant.token));
        assert.equal(mints.length, minted + Number(withRepository));
        await assert.rejects(
          daemon.sendEvent(
            {
              runId: run.id,
              generation: 1,
              sequence: 1,
              event: { type: "candidate", sha: repository.baseSha },
            },
            grant.token,
          ),
          status(403),
        );
        await daemon.sendEvent(
          {
            runId: run.id,
            generation: 1,
            sequence: 1,
            event: { type: "question", text: "Which format?", options: ["Text"] },
          },
          grant.token,
        );
        coordinator.results.answer({ runId: run.id, generation: 1, sequence: 1, answer: "Text" });
        assert.deepEqual(await daemon.answers(run.id, 1, 0, grant.token), {
          answers: [{ sequence: 1, answer: "Text" }],
        });
        const bytes = Buffer.from("Complete answer\n");
        const executionId = workspaceId();
        const chunk = {
          generation: 1,
          executionId,
          offset: 0,
          sha256: hash(bytes),
          data: bytes.toString("base64"),
        };
        await daemon.uploadTranscript(run.id, chunk, grant.token);
        await daemon.finishTranscript(
          run.id,
          {
            generation: 1,
            executionId,
            offset: bytes.length,
            sha256: hash(bytes),
            sizeBytes: bytes.length,
          },
          grant.token,
        );
        assert.deepEqual(await coordinator.transcripts!.download(run.id, 1, executionId), bytes);
        const artifact = {
          id: randomUUID(),
          path: "deliverables/report.txt",
          displayName: "Report",
          mimeType: "text/plain",
          sizeBytes: bytes.length,
          sha256: hash(bytes),
          attachToIssue: true,
        };
        if (purpose === "artifact") {
          await daemon.uploadArtifact(
            run.id,
            { generation: 1, artifact, index: 0, data: bytes.toString("base64") },
            grant.token,
          );
          await daemon.sendEvent(
            { runId: run.id, generation: 1, sequence: 2, event: { type: "artifact", artifact } },
            grant.token,
          );
          assert.deepEqual(
            Buffer.from(
              await coordinator.artifacts.snapshot(run.id, 1, artifact).bytes.arrayBuffer(),
            ),
            bytes,
          );
        } else
          await assert.rejects(
            daemon.sendEvent(
              { runId: run.id, generation: 1, sequence: 2, event: { type: "artifact", artifact } },
              grant.token,
            ),
            status(403),
          );
        const result: RunnerResult = {
          executionId,
          commandId: command.id,
          role: "implementer",
          stopReason: "end_turn",
          timedOut: false,
          cancelled: false,
          authRequired: false,
          agentExited: true,
        };
        await assert.rejects(
          daemon.postResult(
            run.id,
            1,
            { ...result, candidateSha: repository.baseSha },
            grant.token,
          ),
          status(403),
        );
        await assert.rejects(
          daemon.postResult(run.id, 1, { ...result, reviewText: "[]" }, grant.token),
          status(403),
        );
        await assert.rejects(
          daemon.postResult(run.id, 1, { ...result, role: "reviewer" }, grant.token),
          status(403),
        );
        assert.deepEqual(await daemon.postResult(run.id, 1, result, grant.token), {
          duplicate: false,
        });
        assert.deepEqual(await daemon.postResult(run.id, 1, result, grant.token), {
          duplicate: true,
        });
        if (withRepository) {
          onMint = () =>
            db.run("UPDATE work_item_task SET generation=generation+1 WHERE item_id=?", [item.id]);
          await assert.rejects(
            daemon.repositoryCredential(run.id, 1, "read", grant.token),
            status(409),
          );
          onMint = undefined;
          db.run("UPDATE work_item_task SET generation=generation-1 WHERE item_id=?", [item.id]);
        }
        for (const [change, restore] of [
          [
            "UPDATE linear_session SET generation=generation+1 WHERE session_id=?",
            "UPDATE linear_session SET generation=generation-1 WHERE session_id=?",
          ],
          [
            "UPDATE linear_session SET stopped_at=1 WHERE session_id=?",
            "UPDATE linear_session SET stopped_at=NULL WHERE session_id=?",
          ],
          [
            "UPDATE linear_session SET organization_id='other' WHERE session_id=?",
            "UPDATE linear_session SET organization_id='task-org' WHERE session_id=?",
          ],
        ]) {
          db.run(change!, [sessionId]);
          await assert.rejects(
            daemon.issueRunGrant(run.id, { commandId: command.id, generation: 1 }),
            status(409),
          );
          db.run(restore!, [sessionId]);
        }
        for (const [change, restore] of [
          [
            "UPDATE work_item_task SET generation=generation+1 WHERE item_id=?",
            "UPDATE work_item_task SET generation=generation-1 WHERE item_id=?",
          ],
          [
            "UPDATE work_item_task SET repository_context=1-repository_context WHERE item_id=?",
            "UPDATE work_item_task SET repository_context=1-repository_context WHERE item_id=?",
          ],
          [
            "UPDATE work_item_task SET mode=CASE mode WHEN 'answer' THEN 'artifact' ELSE 'answer' END WHERE item_id=?",
            "UPDATE work_item_task SET mode=CASE mode WHEN 'answer' THEN 'artifact' ELSE 'answer' END WHERE item_id=?",
          ],
          [
            "UPDATE work_item SET cancel_requested=1 WHERE id=?",
            "UPDATE work_item SET cancel_requested=0 WHERE id=?",
          ],
        ]) {
          db.run(change!, [item.id]);
          await assert.rejects(
            daemon.issueRunGrant(run.id, { commandId: command.id, generation: 1 }),
          );
          db.run(restore!, [item.id]);
        }
        coordinator.work.finish(run.id, 1);
        await daemon.acknowledgeCommand(command.id);
        observe(
          `signed ${purpose} task ${withRepository ? "with" : "without"} repository retains questions, sealed response and exact result authority`,
          true,
          {
            purpose,
            withRepository,
            noCandidate: true,
            noWriteCredential: true,
            authorityFences: 7,
            resultDuplicate: true,
          },
        );
        now = Date.now();
      }
    }
    assert(mints.every((value) => value === "read"));
    assert.equal(mints.length, 4);
    db.run("UPDATE workspace_member SET active=0 WHERE workspace_id=? AND user_id=?", [
      workspace.id,
      userId,
    ]);
    await assert.rejects(daemon.heartbeat());
    db.run("UPDATE workspace_member SET active=1 WHERE workspace_id=? AND user_id=?", [
      workspace.id,
      userId,
    ]);
    await assert.rejects(daemon.heartbeat());
    assert(
      db
        .query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM runner WHERE id=?")
        .get(runnerId)?.revoked_at !== null,
    );
    observe("membership removal permanently fences the enrolled task runner", true, {
      restoredMembershipDoesNotReviveIdentity: true,
    });
    assert.deepEqual(db.query("PRAGMA foreign_key_check").all(), []);
    if (downloadInputs)
      observe(
        "daemon downloads complete signed input and prompt bytes over current mTLS grants",
        true,
        {
          largestPromptBytes: Buffer.byteLength("Full prepared task prompt 日本語") + 20_972_002,
          repositoryVariants: 4,
          forgedCommandDenied: true,
          chunkAndFullDigestDenied: true,
          cancellationDenied: true,
        },
      );
  } finally {
    daemon.close();
    await enrollment.stop(true);
    await coordinator.stop();
    db.close();
  }
}
