import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  putWorkspaceUser,
  recordLinearInstallation,
  saveTaskMode,
  type Q,
} from "../../src/db";
import { initializeRunnerCoordinator, openRunnerCoordinator } from "../../src/runner-coordinator";
import { openRunnerDaemon, RunnerRequestError } from "../../src/runner-daemon";
import {
  RunnerCommandSchema,
  type RunnerCommand,
  type RunnerResult,
} from "../../src/runner-protocol";
import { createFakeRunnerTranscriptObjects } from "../../src/runner-transcripts";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";
import { tempStore } from "../pglite";

export async function probeRunnerTaskAuthority(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
  downloadInputs = false,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const { db, close } = await tempStore();
  const write = (query: (q: Q) => PromiseLike<unknown>) => db.run((q) => q.exec(query(q)));
  let now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "task-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "task-org",
    name: "Tasks",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "task-org", now)),
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
  let onMint: (() => Promise<unknown>) | undefined;
  const coordinator = await openRunnerCoordinator({
    eventKey: Buffer.alloc(32, 7),
    root: identity,
    db,
    tls,
    hostname: "127.0.0.1",
    port: 0,
    now: () => now,
    transcripts: { objects, key: randomBytes(32) },
    repositoryAccess: {
      github: {
        async mintInstallationToken(input) {
          assert(input.access);
          mints.push(input.access);
          await onMint?.();
          return {
            token: "fixture-read-token",
            repository: input.repository,
            expiresAt: now + 3_600_000,
          };
        },
      },
      installationForRepository: async () => "fixture-installation",
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
    fetch: (request) => coordinator.hostEnrollment(request),
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
    const enrollmentGrant = await coordinator.control.createEnrollment(
      { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: now, teamIds: [] },
      { name: "Response task proof" },
    );
    const enrolled = await daemon.enroll("Response task proof", enrollmentGrant.token);
    if (enrolled.phase !== "paired") throw new Error("Runner enrollment failed");
    const { runnerId } = enrolled;
    await write((q) =>
      q.orm.update(q.t.runner).set({ status: "active" }).where(eq(q.t.runner.id, runnerId)),
    );
    const repository = {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
      baseSha: "a".repeat(40),
    };
    await write((q) =>
      q.orm.insert(q.t.workspaceRepository).values({
        workspaceId: workspace.id,
        repository: "fixture/repository",
        teamId: "team",
      }),
    );
    let taskCount = 0;
    for (const purpose of ["answer", "artifact"] as const) {
      for (const withRepository of [false, true]) {
        const sessionId = `task-session-${++taskCount}`;
        const item = await insertQueuedItem(db, {
          id: `task-item-${taskCount}`,
          now,
          sessionKey: sessionId,
        });
        const { run } = await beginImplementRun(db, item.id, now);
        await recordLinearInstallation(db, {
          organizationId: "task-org",
          oauthClientId: "fixture",
          appUserId: "app",
          sessionId,
          teamId: "team",
          observedAtMs: now,
        });
        await bindLinearSessionTask(db, sessionId, item.delegationId, {
          actorId: "task-owner",
        });
        await saveTaskMode(db, item.id, purpose, 0, withRepository);
        if (withRepository) await bindWorkItemRepository(db, item.id, repository);
        const scope = await coordinator.work.scopeTask(run.id, workspace.id);
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
        command.inputFiles = await coordinator.inputs.stage(command.id, [
          {
            path: ".paws-linear-inputs/task/data.txt",
            mimeType: "text/plain",
            bytes: Buffer.from("Private task attachment"),
          },
        ]);
        const preparedTaskPrompt =
          "Full prepared task prompt 日本語" +
          (downloadInputs && purpose === "answer" && !withRepository ? "x".repeat(20_972_002) : "");
        command.promptContext = await coordinator.inputs.stagePrompt(
          command.id,
          preparedTaskPrompt,
        );
        assert.equal(scope.purpose, purpose);
        assert.equal(scope.repository !== undefined, withRepository);
        await assert.rejects(
          coordinator.work.assign({
            ...command,
            taskModeGeneration: command.taskModeGeneration + 1,
          }),
        );
        await assert.rejects(
          coordinator.work.assign({ ...command, sessionGeneration: command.sessionGeneration + 1 }),
        );
        await assert.rejects(coordinator.work.assign({ ...command, sessionId: "other-session" }));
        await assert.rejects(
          coordinator.work.assign({
            ...command,
            purpose: purpose === "answer" ? "artifact" : "answer",
          }),
        );
        await assert.rejects(
          coordinator.work.assign({
            ...command,
            repository: withRepository ? undefined : repository,
          }),
        );
        assert.equal(
          RunnerCommandSchema.safeParse({ ...command, candidateSha: repository.baseSha }).success,
          false,
        );
        await coordinator.work.assign(command);
        const poll = await daemon.pollCommands();
        assert(poll.commands.some((value) => value.type === "task" && value.id === command.id));
        assert.equal(poll.rejected.length, 0);
        const grant = await daemon.issueRunGrant(run.id, { commandId: command.id, generation: 1 });
        const access = { runnerId, runId: run.id, generation: 1, token: grant.token };
        assert.equal((await coordinator.work.authorizeAsync(access)).branch, null);
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
              (value: Awaited<ReturnType<typeof readContext>>) => ({
                ...value,
                commandId: "other-command",
              }),
              (value: Awaited<ReturnType<typeof readContext>>) => ({
                ...value,
                offset: value.offset + 1,
              }),
              (value: Awaited<ReturnType<typeof readContext>>) => ({ ...value, data: "AAAA" }),
              (value: Awaited<ReturnType<typeof readContext>>) => {
                const bytes = Buffer.alloc(Buffer.from(value.data, "base64").length, 120);
                return { ...value, data: bytes.toString("base64"), sha256: hash(bytes) };
              },
            ]) {
              coordinator.inputs.readContext = async (...args) => alter(await readContext(...args));
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
            (await coordinator.inputs.read(access, { ...inputRequest, fileId: 0 })).data,
            "base64",
          ).toString("utf8"),
          "Private task attachment",
        );
        assert.equal(
          Buffer.from(
            (await coordinator.inputs.readContext(access, inputRequest)).data,
            "base64",
          ).toString("utf8"),
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
        await coordinator.results.answer({
          runId: run.id,
          generation: 1,
          sequence: 1,
          answer: "Text",
        });
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
              await (await coordinator.artifacts.snapshot(run.id, 1, artifact)).bytes.arrayBuffer(),
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
        const task = (q: Q) => eq(q.t.workItemTask.itemId, item.id);
        const taskSet = (set: (q: Q) => Record<string, unknown>) => () =>
          write((q) => q.orm.update(q.t.workItemTask).set(set(q)).where(task(q)));
        const taskGeneration = (step: number) =>
          taskSet((q) => ({ generation: sql`${q.t.workItemTask.generation} + ${step}` }));
        if (withRepository) {
          onMint = taskGeneration(1);
          await assert.rejects(
            daemon.repositoryCredential(run.id, 1, "read", grant.token),
            status(409),
          );
          onMint = undefined;
          await taskGeneration(-1)();
        }
        const session = (set: (q: Q) => Record<string, unknown>) => () =>
          write((q) =>
            q.orm
              .update(q.t.linearSession)
              .set(set(q))
              .where(eq(q.t.linearSession.sessionId, sessionId)),
          );
        const flipContext = taskSet((q) => ({
          repositoryContext: sql`1 - ${q.t.workItemTask.repositoryContext}`,
        }));
        const flipMode = taskSet((q) => ({
          mode: sql`CASE ${q.t.workItemTask.mode} WHEN 'answer' THEN 'artifact' ELSE 'answer' END`,
        }));
        const cancel = (cancelRequested: number) => () =>
          write((q) =>
            q.orm.update(q.t.workItem).set({ cancelRequested }).where(eq(q.t.workItem.id, item.id)),
          );
        const fences: [() => Promise<unknown>, () => Promise<unknown>, boolean][] = [
          [
            session((q) => ({ generation: sql`${q.t.linearSession.generation} + 1` })),
            session((q) => ({ generation: sql`${q.t.linearSession.generation} - 1` })),
            true,
          ],
          [session(() => ({ stoppedAt: 1 })), session(() => ({ stoppedAt: null })), true],
          [
            session(() => ({ organizationId: "other" })),
            session(() => ({ organizationId: "task-org" })),
            true,
          ],
          [taskGeneration(1), taskGeneration(-1), false],
          [flipContext, flipContext, false],
          [flipMode, flipMode, false],
          [cancel(1), cancel(0), false],
        ];
        for (const [change, restore, conflict] of fences) {
          await change();
          const issued = daemon.issueRunGrant(run.id, { commandId: command.id, generation: 1 });
          await (conflict ? assert.rejects(issued, status(409)) : assert.rejects(issued));
          await restore();
        }
        await coordinator.work.finish(run.id, 1);
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
    await write((q) =>
      q.orm
        .update(q.t.workspaceMember)
        .set({ active: 0 })
        .where(
          and(
            eq(q.t.workspaceMember.workspaceId, workspace.id),
            eq(q.t.workspaceMember.userId, userId),
          ),
        ),
    );
    await assert.rejects(daemon.heartbeat());
    observe("membership removal fences the enrolled task runner", true, {
      heartbeatDenied: true,
    });
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
    await close();
  }
}
