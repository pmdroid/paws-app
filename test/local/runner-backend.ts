import assert from "node:assert/strict";
import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  openDatabase,
  migrate,
  putWorkspaceUser,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  beginImplementRun,
  recordLinearInstallation,
  bindLinearSessionTask,
  bindWorkItemRepository,
  getWorkItem,
  saveTaskMode,
} from "../../src/db";
import { workspaceId, issueWorkspaceBootstrap, workspaceTokenHash } from "../../src/workspace";
import { createRunnerControl } from "../../src/runner-control";
import { initializeRunnerAuthority, createRunnerKey } from "../../src/runner-identity";
import { createRunnerWork } from "../../src/runner-work";
import { createRunnerHealth } from "../../src/runner-health";
import { createRunnerResults } from "../../src/runner-results";
import { createRunnerArtifactStore } from "../../src/runner-artifacts";
import { createRemoteAgentRunner } from "../../src/runner-backend";
import { createRunnerInputStore } from "../../src/runner-inputs";
import {
  verifyRunnerCommand,
  type RunnerCommand,
  type RunnerInputFile,
} from "../../src/runner-protocol";
import {
  prepareRepositorySnapshot,
  recoverAcpConversation,
  runDir,
  type RunAgentOptions,
  type AcpEvent,
} from "../../src/acp";
import {
  createRunnerTranscripts,
  createFakeRunnerTranscriptObjects,
  RUNNER_TRANSCRIPT_CHUNK_BYTES,
} from "../../src/runner-transcripts";
import { openQuestion, answerQuestion } from "../../src/questions";
import { applyWorkItemEvent } from "../../src/db";

export async function probeRunnerBackend(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  let now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "fixture-work", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-work",
    name: "Fixture",
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
  const issuer = join(root, "issuer");
  const authority = await initializeRunnerAuthority(issuer);
  const control = createRunnerControl({
    db,
    authority,
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
  });
  const key = await createRunnerKey(join(root, "client"));
  const pending = await control.beginPairing({ name: "VM", csr: key.csr });
  const runnerId = (await control.approvePairing(principal, pending.code)).runnerId;
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: signing.privateKey,
    now: () => now,
  });
  const results = createRunnerResults({ db, work, now: () => now });
  const health = createRunnerHealth({ db, work, now: () => now });
  work.heartbeat(runnerId);
  const source = join(root, "source");
  async function git(args: string[]) {
    const child = Bun.spawn(["/usr/bin/git", ...args], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, err);
    return out.trim();
  }
  await git(["init", "-b", "main", source]);
  writeFileSync(join(source, "result.txt"), "base");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Base"]);
  const base = await git(["-C", source, "rev-parse", "HEAD"]);
  writeFileSync(join(source, "result.txt"), "candidate");
  await git(["-C", source, "commit", "-am", "Candidate"]);
  const head = await git(["-C", source, "rev-parse", "HEAD"]);
  await git(["-C", source, "reset", "--hard", base]);
  let fetched = 0;
  let importWrongHead = false;
  const artifacts = createRunnerArtifactStore({ root: join(root, "artifact-store"), work });
  let published = false;
  const backendOptions: Parameters<typeof createRemoteAgentRunner>[0] = {
    artifacts,
    db,
    work,
    results,
    health,
    now: () => now,
    pollIntervalMs: 1,
    async fetchCandidate(candidate) {
      assert.equal(candidate.remoteUrl, "https://github.com/fixture/repository.git");
      assert.equal(candidate.networkGit, git);
      assert.equal(candidate.branch, getWorkItem(db, candidate.itemId)?.branchName);
      assert.equal(candidate.baseSha, base);
      assert.equal(candidate.candidateSha, head);
      fetched++;
      await git(["-C", candidate.worktree, "reset", "--hard", importWrongHead ? base : head]);
    },
  };
  const backend = createRemoteAgentRunner(backendOptions);
  const seen = new Set<string>();
  async function next() {
    for (let i = 0; i < 500; i++) {
      for (const envelope of work.commands(runnerId)) {
        const v = verifyRunnerCommand(envelope, {
          trustedKeys: new Map([["fixture", signing.publicKey]]),
          runnerId,
          workspaceId: workspace.id,
          now,
          allowedRepositories: ["fixture/repository"],
          claimCommand: (id) => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          },
        });
        if (v.ok) {
          work.acknowledge(runnerId, v.command.id);
          return v.command;
        }
      }
      await delay(1);
    }
    throw new Error("No dispatched runner command");
  }
  let sequence = 0;
  function item() {
    const id = `item-${++sequence}`,
      sessionId = `session-${sequence}`;
    const record = insertQueuedItem(db, { id, now, sessionKey: sessionId });
    const { run } = beginImplementRun(db, id, now);
    recordLinearInstallation(db, {
      organizationId: "fixture-work",
      oauthClientId: "fixture-app",
      appUserId: "app-user",
      sessionId,
      teamId: "fixture-team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, sessionId, record.epicId, { actorId: "owner" });
    bindWorkItemRepository(db, id, {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
    });
    return { id, run };
  }
  function input(
    record: ReturnType<typeof item>,
    overrides: Partial<RunAgentOptions> = {},
  ): RunAgentOptions {
    return {
      profile: { agent: "codex", model: "model" },
      role: "implementer",
      itemId: `display-${record.id}`,
      runId: record.run.id,
      prompt: "Implement fixture",
      worktreePath: source,
      pawsRoot: root,
      networkGit: git,
      ...overrides,
    };
  }
  const result = (command: RunnerCommand, role: "implementer" | "reviewer" = "implementer") => ({
    executionId: workspaceId(),
    commandId: command.id,
    role,
    stopReason: "end_turn" as const,
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    identity: { session: `session-${command.id}`, model: "model", provider: "fixture" },
  });
  try {
    const denied = item();
    await assert.rejects(backend.forItem(denied.id)(input(denied)), /No available paired runner/);
    assert.equal(work.commands(runnerId).length, 0);
    db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      workspace.id,
      "fixture/repository",
      "fixture-team",
    ]);
    observe("remote selection denies unmapped Linear repositories before dispatch", true, {
      commands: 0,
    });
    const unsupported = item();
    await assert.rejects(
      backend.forItem(unsupported.id)(
        input(unsupported, {
          async prepareInputFiles({ workspace: directory, prompt }) {
            return {
              prompt,
              inputFiles: [
                {
                  path: join(directory, "design.txt"),
                  mimeType: "text/plain",
                  bytes: Buffer.from("design"),
                },
              ],
            };
          },
        }),
      ),
      /input transfer is unavailable/,
    );
    assert.equal(work.commands(runnerId).length, 0);
    await assert.rejects(
      backend.forItem(unsupported.id)(input(unsupported, { readOnly: true })),
      /reviewer role/,
    );
    observe(
      "unsupported input transfer and conflicting read-only roles fail before work dispatch",
      true,
      { commands: 0 },
    );
    const first = item();
    const events: AcpEvent[] = [];
    const running = backend.forItem(first.id)(
      input(first, {
        onEvent: (e) => {
          events.push(e);
        },
        publishArtifact: {
          async publish(snapshot, context) {
            assert.equal(await snapshot.bytes.text(), "Remote evidence");
            assert.equal(context.request?.attachToIssue, true);
            assert.equal(context.itemId, `display-${first.id}`);
            published = true;
            return { url: "https://linear.app/artifact/backend" };
          },
        },
      }),
    );
    const assigned = await next();
    assert.equal(assigned.type, "run");
    if (assigned.type !== "run") throw new Error("Unexpected command");
    assert.equal(assigned.itemId, first.id);
    assert.equal(assigned.runId, first.run.id);
    assert.equal(assigned.repository.baseSha, base);
    assert.equal(assigned.prompt, "Implement fixture");
    const grant = work.issueGrant({
      runnerId,
      runId: assigned.runId,
      commandId: assigned.id,
      generation: assigned.generation,
    });
    work.event({
      runnerId,
      runId: assigned.runId,
      generation: assigned.generation,
      token: grant.token,
      sequence: 1,
      event: { type: "progress", text: "Implementation progress" },
    });
    const artifactBytes = Buffer.from("Remote evidence");
    const artifact = {
      id: randomUUID(),
      path: "reports/evidence.txt",
      displayName: "Evidence",
      mimeType: "text/plain",
      sizeBytes: artifactBytes.length,
      sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      attachToIssue: true,
    };
    artifacts.upload({
      runnerId,
      runId: assigned.runId,
      token: grant.token,
      chunk: {
        generation: assigned.generation,
        artifact,
        index: 0,
        data: artifactBytes.toString("base64"),
      },
    });
    work.event({
      runnerId,
      runId: assigned.runId,
      generation: assigned.generation,
      token: grant.token,
      sequence: 2,
      event: { type: "artifact", artifact },
    });
    results.submit({
      runnerId,
      runId: assigned.runId,
      generation: assigned.generation,
      token: grant.token,
      result: { ...result(assigned), candidateSha: head },
    });
    const completed = await running;
    assert.equal(completed.stopReason, "end_turn");
    assert.equal(published, true);
    const publicationAnswer = db
      .query<{ answer: string }, [string]>(
        "SELECT answer FROM runner_question_answer WHERE run_id=? AND sequence=2",
      )
      .get(assigned.runId);
    assert.equal(JSON.parse(publicationAnswer!.answer).url, "https://linear.app/artifact/backend");
    assert.equal(fetched, 1);
    assert.equal(await git(["-C", source, "rev-parse", "HEAD"]), head);
    assert.equal(getWorkItem(db, first.id)?.state, "running");
    assert.throws(() => work.current(first.run.id, 1), /fenced/);
    assert(events.some((e) => e.type === "session_update"));
    observe(
      "signed remote implementation imports the exact candidate while canonical verification remains pending",
      true,
      { candidate: head, fetched, canonicalState: "running", assignmentEnded: true },
    );
    const reviewer = item();
    let text = "";
    const reviewed = backend.forItem(reviewer.id)(
      input(reviewer, {
        role: "reviewer",
        readOnly: true,
        onEvent: (e) => {
          if (
            e.type === "session_update" &&
            e.update.sessionUpdate === "agent_message_chunk" &&
            e.update.content.type === "text"
          )
            text += e.update.content.text;
        },
      }),
    );
    const review = await next();
    assert.equal(review.type, "review");
    if (review.type !== "review") throw new Error("Unexpected command");
    const reviewGrant = work.issueGrant({
      runnerId,
      runId: review.runId,
      commandId: review.id,
      generation: review.generation,
    });
    assert.throws(() =>
      results.submit({
        runnerId,
        runId: review.runId,
        generation: review.generation,
        token: reviewGrant.token,
        result: { ...result(review, "reviewer"), candidateSha: head },
      }),
    );
    work.event({
      runnerId,
      runId: review.runId,
      generation: review.generation,
      token: reviewGrant.token,
      sequence: 1,
      event: { type: "progress", text: "[]" },
    });
    results.submit({
      runnerId,
      runId: review.runId,
      generation: review.generation,
      token: reviewGrant.token,
      result: { ...result(review, "reviewer"), reviewText: "[]" },
    });
    await reviewed;
    assert.equal(text, "[]");
    assert.equal(fetched, 1);
    observe(
      "independent remote review forwards final findings once and cannot publish a candidate",
      true,
      { reviewText: text, implementationFetches: fetched },
    );
    const transcriptObjects = createFakeRunnerTranscriptObjects();
    const transcripts = createRunnerTranscripts({ db, work, objects: transcriptObjects });
    let cancelDuringDownload = false;
    const sealedBackend = createRemoteAgentRunner({
      ...backendOptions,
      transcripts: {
        async download(runId, generation, executionId) {
          const bytes = await transcripts.download(runId, generation, executionId);
          if (cancelDuringDownload) {
            const current = db
              .query<{ itemId: string }, [string]>("SELECT item_id AS itemId FROM run WHERE id=?")
              .get(runId)!;
            db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [current.itemId]);
          }
          return bytes;
        },
      },
    });
    async function seal(
      command: Extract<RunnerCommand, { type: "run" | "review" | "task" }>,
      token: string,
      executionId: string,
      bytes: Buffer,
    ) {
      const access = { runnerId, runId: command.runId, token };
      for (let offset = 0; offset < bytes.length; offset += RUNNER_TRANSCRIPT_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + RUNNER_TRANSCRIPT_CHUNK_BYTES);
        await transcripts.upload(access, {
          generation: command.generation,
          executionId,
          offset,
          sha256: createHash("sha256").update(chunk).digest("hex"),
          data: chunk.toString("base64"),
        });
      }
      await transcripts.finish(access, {
        generation: command.generation,
        executionId,
        offset: bytes.length,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    for (const purpose of ["answer", "artifact"] as const) {
      for (const withRepository of [false, true]) {
        const task = item();
        saveTaskMode(db, task.id, purpose, 0, withRepository);
        const directory = join(root, `response-${task.id}`);
        mkdirSync(directory, { mode: 0o700 });
        if (withRepository)
          await prepareRepositorySnapshot({
            owner: "fixture",
            repo: "repository",
            remoteUrl: source,
            workspace: directory,
            signal: new AbortController().signal,
          });
        assert(!existsSync(join(directory, ".git")));
        const fullResponse = `Complete ${purpose} ` + "x".repeat(1024 * 1024);
        const raw = Buffer.from(
          [
            {
              event: {
                type: "session_update",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: fullResponse },
                },
              },
            },
            { type: "question", text: "Which format?" },
            {
              event: {
                type: "session_update",
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "read",
                  status: "completed",
                  rawOutput: "source inspected",
                },
              },
            },
          ]
            .map((row) => JSON.stringify(row) + "\n")
            .join(""),
        );
        const taskEvents: AcpEvent[] = [];
        const beforeFetch: number = fetched;
        const response = sealedBackend.forItem(task.id)(
          input(task, {
            worktreePath: directory,
            readOnly: purpose === "answer",
            networkGit: undefined,
            onEvent(event) {
              taskEvents.push(event);
            },
            askTeam: {
              async ask(request) {
                assert.equal(request.question, "Which format?");
                return { answer: "Text" };
              },
            },
            publishArtifact: {
              async publish(snapshot) {
                assert.equal(await snapshot.bytes.text(), "Remote evidence");
                return { url: "https://linear.app/artifact/task" };
              },
            },
          }),
        );
        const command = await next();
        assert.equal(command.type, "task");
        if (command.type !== "task") throw new Error("Expected response task");
        assert.equal(command.purpose, purpose);
        assert.equal(command.repository !== undefined, withRepository);
        if (withRepository) {
          assert.equal(command.repository?.baseSha, head);
          assert(!existsSync(join(directory, "repository", ".git")));
        }
        assert.equal(command.sessionId, `session-${sequence}`);
        const taskGrant = work.issueGrant({
          runnerId,
          runId: command.runId,
          commandId: command.id,
          generation: command.generation,
        });
        work.event({
          runnerId,
          runId: command.runId,
          generation: command.generation,
          token: taskGrant.token,
          sequence: 1,
          event: { type: "progress", text: "Bounded progress" },
        });
        work.event({
          runnerId,
          runId: command.runId,
          generation: command.generation,
          token: taskGrant.token,
          sequence: 2,
          event: { type: "question", text: "Which format?", options: [] },
        });
        if (purpose === "artifact") {
          artifacts.upload({
            runnerId,
            runId: command.runId,
            token: taskGrant.token,
            chunk: {
              generation: command.generation,
              artifact,
              index: 0,
              data: artifactBytes.toString("base64"),
            },
          });
          work.event({
            runnerId,
            runId: command.runId,
            generation: command.generation,
            token: taskGrant.token,
            sequence: 3,
            event: { type: "artifact", artifact },
          });
        }
        for (let i = 0; i < 500; i++) {
          const answers = results.answers({
            runnerId,
            runId: command.runId,
            generation: command.generation,
            token: taskGrant.token,
            after: 0,
          });
          if (
            answers.some((value) => value.sequence === 2) &&
            (purpose !== "artifact" || answers.some((value) => value.sequence === 3))
          )
            break;
          if (i === 499) throw new Error("Response task callbacks did not answer");
          await delay(1);
        }
        const receipt = result(command);
        await seal(command, taskGrant.token, receipt.executionId, raw);
        results.submit({
          runnerId,
          runId: command.runId,
          generation: command.generation,
          token: taskGrant.token,
          result: receipt,
        });
        const taskCompleted = await response;
        const messages = taskEvents.filter(
          (event) =>
            event.type === "session_update" && event.update.sessionUpdate === "agent_message_chunk",
        );
        assert.equal(messages.length, 1);
        const message = messages[0]!;
        assert(
          message.type === "session_update" &&
            message.update.sessionUpdate === "agent_message_chunk" &&
            message.update.content.type === "text",
        );
        assert.equal(message.update.content.text, fullResponse);
        assert(taskCompleted.transcriptPath);
        const history = await recoverAcpConversation(taskCompleted.transcriptPath);
        assert.equal(
          history
            .filter((entry) => entry.kind === "response")
            .map((entry) => entry.body)
            .join(""),
          fullResponse,
        );
        assert.equal(
          JSON.parse(history.find((entry) => entry.kind === "tool_result")!.body).rawOutput,
          "source inspected",
        );
        assert.equal(fetched, beforeFetch);
        assert.equal(getWorkItem(db, task.id)?.checkpoint, null);
        assert.throws(() => work.current(command.runId, command.generation), /fenced/);
        observe(
          `remote ${purpose} task with repository=${withRepository} returns complete sealed text and tool history`,
          true,
          {
            responseBytes: fullResponse.length,
            candidateImports: fetched - beforeFetch,
            questionAnswered: true,
            artifactPublished: purpose === "artifact",
          },
        );
      }
    }
    const changedTask = item();
    saveTaskMode(db, changedTask.id, "answer");
    await assert.rejects(
      sealedBackend.forItem(changedTask.id)(
        input(changedTask, {
          readOnly: true,
          async prepareInputFiles({ prompt }) {
            db.run("UPDATE linear_session SET generation=generation+1 WHERE session_id=?", [
              `session-${sequence}`,
            ]);
            return { prompt, inputFiles: [] };
          },
        }),
      ),
      /binding changed/,
    );
    assert.equal(work.commands(runnerId).length, 0);
    observe(
      "remote response dispatch rejects a session generation changed during preparation",
      true,
      { commands: 0 },
    );
    const unsafeTask = item();
    saveTaskMode(db, unsafeTask.id, "artifact", 0, true);
    const unsafeDirectory = join(root, "unsafe-response");
    mkdirSync(unsafeDirectory, { mode: 0o700 });
    writeFileSync(
      `${unsafeDirectory}.repository.json`,
      JSON.stringify({ owner: "wrong", repo: "repository", commit: head }),
      { mode: 0o600 },
    );
    await assert.rejects(
      sealedBackend.forItem(unsafeTask.id)(input(unsafeTask, { worktreePath: unsafeDirectory })),
      /snapshot binding changed/,
    );
    assert.equal(work.commands(runnerId).length, 0);
    observe("remote response repository metadata must match the canonical selection", true, {
      commands: 0,
    });
    const inputs = createRunnerInputStore({ root: join(root, "private-inputs"), work });
    const inputBackend = createRemoteAgentRunner({ ...backendOptions, transcripts, inputs });
    for (const kind of ["run", "review", "answer", "artifact"] as const) {
      const record = item();
      const isTask = kind === "answer" || kind === "artifact";
      if (isTask) saveTaskMode(db, record.id, kind);
      const directory = isTask ? join(root, `inputs-${record.id}`) : source;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!isTask) await git(["-C", source, "reset", "--hard", base]);
      const supplied = Buffer.from("original caller input");
      const preparedBytes = Buffer.from("prepared Linear attachment");
      const fullPrompt =
        kind === "artifact"
          ? "Restored conversation 😺\n" + "h".repeat(20 * 1024 * 1024)
          : `Prepared ${kind} prompt`;
      const request = input(record, {
        worktreePath: directory,
        role: kind === "review" ? "reviewer" : "implementer",
        readOnly: kind === "review" || kind === "answer",
        inputFiles: [
          { path: "private/supplied.bin", mimeType: "application/octet-stream", bytes: supplied },
        ],
        async prepareInputFiles() {
          supplied.fill(0);
          await delay(1);
          return {
            prompt: fullPrompt,
            inputFiles: [
              {
                path: join(directory, "private/prepared.txt"),
                mimeType: "text/plain",
                bytes: preparedBytes,
              },
            ],
          };
        },
      });
      const pendingInput = inputBackend.forItem(record.id)(request);
      const dispatched = await next();
      if (dispatched.type !== "run" && dispatched.type !== "review" && dispatched.type !== "task")
        throw new Error("Expected input-bearing command");
      assert.equal(dispatched.type, isTask ? "task" : kind);
      assert.equal(dispatched.inputFiles?.length, 2);
      const expected = [
        Buffer.from("original caller input"),
        Buffer.from("prepared Linear attachment"),
      ];
      preparedBytes.fill(0);
      const inputGrant = work.issueGrant({
        runnerId,
        runId: dispatched.runId,
        commandId: dispatched.id,
        generation: dispatched.generation,
      });
      for (const [fileId, bytes] of expected.entries()) {
        const descriptor: RunnerInputFile = dispatched.inputFiles![fileId]!;
        assert.equal(descriptor.sha256, createHash("sha256").update(bytes).digest("hex"));
        assert.equal(
          descriptor.path,
          fileId === 0 ? "private/supplied.bin" : "private/prepared.txt",
        );
        const chunk = inputs.read(
          { runnerId, runId: dispatched.runId, token: inputGrant.token },
          { commandId: dispatched.id, generation: dispatched.generation, fileId, offset: 0 },
        );
        assert.deepEqual(Buffer.from(chunk.data, "base64"), bytes);
        assert(!existsSync(join(directory, descriptor.path)));
      }
      if (kind === "artifact") {
        assert(dispatched.promptContext);
        assert.equal(dispatched.promptContext.sizeBytes, Buffer.byteLength(fullPrompt));
        assert.equal(
          dispatched.promptContext.sha256,
          createHash("sha256").update(fullPrompt).digest("hex"),
        );
        assert(dispatched.prompt.length < 65536);
        const chunks: Buffer[] = [];
        let offset = 0;
        while (offset < dispatched.promptContext.sizeBytes) {
          const chunk = inputs.readContext(
            { runnerId, runId: dispatched.runId, token: inputGrant.token },
            { commandId: dispatched.id, generation: dispatched.generation, offset },
          );
          const bytes = Buffer.from(chunk.data, "base64");
          assert.equal(chunk.sha256, createHash("sha256").update(bytes).digest("hex"));
          assert(bytes.length > 0);
          chunks.push(bytes);
          offset += bytes.length;
        }
        assert.equal(Buffer.concat(chunks).toString("utf8"), fullPrompt);
      } else {
        assert.equal(dispatched.prompt, fullPrompt);
        assert.equal(dispatched.promptContext, undefined);
      }
      const inputReceipt = result(dispatched, kind === "review" ? "reviewer" : "implementer");
      await seal(
        dispatched,
        inputGrant.token,
        inputReceipt.executionId,
        Buffer.from(
          JSON.stringify({
            event: {
              type: "session_update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Complete input response" },
              },
            },
          }) + "\n",
        ),
      );
      results.submit({
        runnerId,
        runId: dispatched.runId,
        generation: dispatched.generation,
        token: inputGrant.token,
        result: {
          ...inputReceipt,
          ...(kind === "run" ? { candidateSha: head } : {}),
          ...(kind === "review" ? { reviewText: "[]" } : {}),
        },
      });
      await pendingInput;
      assert.throws(() =>
        inputs.read(
          { runnerId, runId: dispatched.runId, token: inputGrant.token },
          { commandId: dispatched.id, generation: dispatched.generation, fileId: 0, offset: 0 },
        ),
      );
      observe(
        `remote ${kind} snapshots supplied and prepared private files before signed dispatch`,
        true,
        {
          files: 2,
          callerMutationIgnored: true,
          preparedMutationIgnored: true,
          fullPromptBytes: Buffer.byteLength(fullPrompt),
          context: kind === "artifact",
          endedGrantDenied: true,
        },
      );
    }
    const badInputs = item();
    await assert.rejects(
      inputBackend.forItem(badInputs.id)(
        input(badInputs, {
          inputFiles: [
            { path: join(root, "outside"), mimeType: "text/plain", bytes: Buffer.from("outside") },
          ],
        }),
      ),
      /inside the workspace/,
    );
    await assert.rejects(
      inputBackend.forItem(badInputs.id)(
        input(badInputs, {
          inputFiles: Array.from({ length: 20 }, (_, i) => ({
            path: `private/${i}.txt`,
            mimeType: "text/plain",
            bytes: Buffer.from("small"),
          })),
          async prepareInputFiles() {
            return {
              prompt: "Combined inputs",
              inputFiles: [
                { path: "private/extra.txt", mimeType: "text/plain", bytes: Buffer.from("extra") },
              ],
            };
          },
        }),
      ),
      /file limit/,
    );
    await assert.rejects(
      backend.forItem(badInputs.id)(input(badInputs, { prompt: "h".repeat(65537) })),
      /conversation context transfer is unavailable/,
    );
    assert.equal(work.commands(runnerId).length, 0);
    observe(
      "private input path and aggregate bounds and missing context transport reject before assignment",
      true,
      { commands: 0 },
    );
    const sealed = item();
    const sealedPath = join(runDir(root, sealed.run.id), "acp.jsonl");
    mkdirSync(runDir(root, sealed.run.id), { recursive: true });
    const prefix = Buffer.from(
      JSON.stringify({
        event: {
          type: "session_update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Prior turn" },
          },
        },
      }) + "\n",
    );
    writeFileSync(sealedPath, prefix);
    const fullText = "Complete history " + "z".repeat(10 * 1024 * 1024);
    const raw = Buffer.from(
      [
        {
          event: {
            type: "session_update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: fullText },
            },
          },
        },
        { type: "question", text: "Continue?" },
        { type: "artifact", path: "report.txt" },
        {
          event: {
            type: "session_update",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "check",
              status: "completed",
              rawOutput: "Checked",
            },
          },
        },
      ]
        .map((row) => JSON.stringify(row) + "\n")
        .join(""),
    );
    const receivedProgress: string[] = [];
    for (let turn = 0; turn < 2; turn++) {
      const before = readFileSync(sealedPath);
      const response = sealedBackend.forItem(sealed.id)(
        input(sealed, {
          role: "reviewer",
          readOnly: true,
          onEvent(event) {
            if (
              event.type === "session_update" &&
              event.update.sessionUpdate === "agent_thought_chunk" &&
              event.update.content.type === "text"
            )
              receivedProgress.push(event.update.content.text);
          },
        }),
      );
      const command = await next();
      if (command.type !== "review") throw new Error("Unexpected sealed transcript command");
      const transcriptGrant = work.issueGrant({
        runnerId,
        runId: command.runId,
        commandId: command.id,
        generation: command.generation,
      });
      const receipt = result(command, "reviewer");
      await seal(command, transcriptGrant.token, receipt.executionId, raw);
      for (let eventSequence = 1; eventSequence <= 130; eventSequence++) {
        work.event({
          runnerId,
          runId: command.runId,
          generation: command.generation,
          token: transcriptGrant.token,
          sequence: eventSequence,
          event: { type: "progress", text: `turn-${turn}-event-${eventSequence}` },
        });
      }
      results.submit({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        token: transcriptGrant.token,
        result: receipt,
      });
      const sealedResult = await response;
      assert.equal(sealedResult.transcriptPath, sealedPath);
      assert(receivedProgress.includes(`turn-${turn}-event-130`));
      const mirrored = readFileSync(sealedPath);
      assert.deepEqual(mirrored.subarray(0, before.length), before);
      assert.deepEqual(mirrored.subarray(before.length, before.length + raw.length), raw);
      const history = await recoverAcpConversation(sealedPath, before.length);
      assert.equal(history[0]?.body, fullText);
      assert.equal(JSON.parse(history[1]!.body).rawOutput, "Checked");
    }
    observe(
      "sealed complete remote history replaces only the current turn and preserves previous turns",
      true,
      { rawBytes: raw.length, turns: 2, recoveredTool: "Checked" },
    );
    for (const failure of ["unsealed", "mismatched", "cancelled"] as const) {
      const rejected = item();
      const response = sealedBackend.forItem(rejected.id)(
        input(rejected, { role: "reviewer", readOnly: true }),
      );
      const rejection = assert.rejects(
        response,
        failure === "unsealed"
          ? /not complete/
          : failure === "mismatched"
            ? /execution changed/
            : /no longer active/,
      );
      const command = await next();
      if (command.type !== "review") throw new Error("Unexpected rejected transcript command");
      const transcriptGrant = work.issueGrant({
        runnerId,
        runId: command.runId,
        commandId: command.id,
        generation: command.generation,
      });
      const receipt = result(command, "reviewer");
      if (failure !== "unsealed")
        await seal(
          command,
          transcriptGrant.token,
          failure === "mismatched" ? workspaceId() : receipt.executionId,
          Buffer.from("{}\n"),
        );
      cancelDuringDownload = failure === "cancelled";
      results.submit({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        token: transcriptGrant.token,
        result: receipt,
      });
      await rejection;
      cancelDuringDownload = false;
      const path = join(runDir(root, rejected.run.id), "acp.jsonl");
      assert(!existsSync(path) || !readFileSync(path).includes(Buffer.from("{}\n")));
      assert.equal((await next()).type, "cancel");
      observe(
        `remote transcript ${failure} cannot publish sealed history or complete the assignment`,
        true,
        { canonicalState: getWorkItem(db, rejected.id)?.state },
      );
    }
    const prepared = item();
    const preparation = backend.forItem(prepared.id)(
      input(prepared, {
        prepareOnly: true,
        role: "reviewer",
        profile: { agent: "codex", model: null },
      }),
    );
    const probe = await next();
    assert.equal(probe.type, "probe");
    if (probe.type !== "probe") throw new Error("Unexpected preparation command");
    assert.equal(probe.profile.model, null);
    health.submit(runnerId, { ...result(probe), models: [{ id: "model", name: "Model" }] });
    const ready = await preparation;
    assert.equal(ready.role, "reviewer");
    assert.equal(ready.identity?.model, "model");
    observe("remote preflight uses signed probe delivery with its requested role", true, {
      profile: ready.identity,
      role: ready.role,
    });
    await git(["-C", source, "reset", "--hard", base]);
    const asked = item();
    let opened = false;
    const questioning = backend.forItem(asked.id)(
      input(asked, {
        askTeam: {
          async ask(request, context) {
            assert.equal(request.question, "Include archived rows?");
            assert.deepEqual(request.options, [{ label: "Include", value: "yes" }]);
            assert.equal(context.runId, asked.run.id);
            applyWorkItemEvent(db, asked.id, "blocking_question");
            const question = openQuestion(db, {
              itemId: asked.id,
              runId: asked.run.id,
              sessionId: `session-${sequence}`,
              body: request.question,
              now,
            });
            opened = true;
            await delay(10, undefined, { signal: context.signal });
            answerQuestion(db, question.id, { answer: "yes", answeredBy: "owner", now });
            applyWorkItemEvent(db, asked.id, "answer_received");
            return { answer: "yes" };
          },
        },
      }),
    );
    const questionCommand = await next();
    assert.equal(questionCommand.type, "run");
    if (questionCommand.type !== "run") throw new Error("Unexpected command");
    const questionGrant = work.issueGrant({
      runnerId,
      runId: questionCommand.runId,
      commandId: questionCommand.id,
      generation: questionCommand.generation,
    });
    work.event({
      runnerId,
      runId: questionCommand.runId,
      generation: questionCommand.generation,
      token: questionGrant.token,
      sequence: 1,
      event: {
        type: "question",
        text: "Include archived rows?",
        options: [{ label: "Include", value: "yes" }],
      },
    });
    let answered = false;
    for (let i = 0; i < 500; i++) {
      const answers = results.answers({
        runnerId,
        runId: questionCommand.runId,
        generation: questionCommand.generation,
        token: questionGrant.token,
        after: 0,
      });
      if (answers.length) {
        assert.deepEqual(answers, [{ sequence: 1, answer: "yes" }]);
        answered = true;
        break;
      }
      await delay(1);
    }
    assert(opened && answered);
    results.submit({
      runnerId,
      runId: questionCommand.runId,
      generation: questionCommand.generation,
      token: questionGrant.token,
      result: { ...result(questionCommand), candidateSha: head },
    });
    await questioning;
    observe(
      "remote questions use the existing Linear question channel and immutable answer sequence",
      true,
      { opened, answered, canonicalState: getWorkItem(db, asked.id)?.state },
    );
    await git(["-C", source, "reset", "--hard", base]);
    const mismatched = item();
    importWrongHead = true;
    const mismatchRun = backend.forItem(mismatched.id)(input(mismatched));
    const mismatchRejection = assert.rejects(mismatchRun, /HEAD does not match/);
    const mismatchCommand = await next();
    if (mismatchCommand.type !== "run") throw new Error("Unexpected candidate command");
    const mismatchGrant = work.issueGrant({
      runnerId,
      runId: mismatchCommand.runId,
      commandId: mismatchCommand.id,
      generation: mismatchCommand.generation,
    });
    results.submit({
      runnerId,
      runId: mismatchCommand.runId,
      generation: mismatchCommand.generation,
      token: mismatchGrant.token,
      result: { ...result(mismatchCommand), candidateSha: head },
    });
    await mismatchRejection;
    const mismatchCancel = await next();
    assert.equal(mismatchCancel.type, "cancel");
    assert.equal(getWorkItem(db, mismatched.id)?.state, "running");
    importWrongHead = false;
    observe("candidate import mismatch rejects completion and fences the assignment", true, {
      head: await git(["-C", source, "rev-parse", "HEAD"]),
      canonicalState: "running",
    });
    const absent = item();
    const absentRun = backend.forItem(absent.id)(input(absent));
    const absentRejection = assert.rejects(absentRun, /no candidate commit/);
    const absentCommand = await next();
    if (absentCommand.type !== "run") throw new Error("Unexpected absent candidate command");
    const absentGrant = work.issueGrant({
      runnerId,
      runId: absentCommand.runId,
      commandId: absentCommand.id,
      generation: absentCommand.generation,
    });
    results.submit({
      runnerId,
      runId: absentCommand.runId,
      generation: absentCommand.generation,
      token: absentGrant.token,
      result: result(absentCommand),
    });
    await absentRejection;
    assert.equal((await next()).type, "cancel");
    observe(
      "successful implementation without a candidate cannot finish or approve the task",
      true,
      { canonicalState: getWorkItem(db, absent.id)?.state },
    );
    const unauthorized = item();
    const beforeUnauthorized = fetched;
    const unauthorizedRun = backend.forItem(unauthorized.id)(
      input(unauthorized, { networkGit: undefined }),
    );
    const unauthorizedRejection = assert.rejects(
      unauthorizedRun,
      /authorized implementation import/,
    );
    const unauthorizedCommand = await next();
    if (unauthorizedCommand.type !== "run") throw new Error("Unexpected unauthorized candidate");
    const unauthorizedGrant = work.issueGrant({
      runnerId,
      runId: unauthorizedCommand.runId,
      commandId: unauthorizedCommand.id,
      generation: unauthorizedCommand.generation,
    });
    results.submit({
      runnerId,
      runId: unauthorizedCommand.runId,
      generation: unauthorizedCommand.generation,
      token: unauthorizedGrant.token,
      result: { ...result(unauthorizedCommand), candidateSha: head },
    });
    await unauthorizedRejection;
    assert.equal((await next()).type, "cancel");
    assert.equal(fetched, beforeUnauthorized);
    assert.equal(await git(["-C", source, "rev-parse", "HEAD"]), base);
    observe("missing scoped Git authorization cannot fall back to a local candidate import", true, {
      fetched,
      head: base,
    });
    const cancelled = item();
    const abort = new AbortController();
    const cancelledRun = backend.forItem(cancelled.id)(input(cancelled, { signal: abort.signal }));
    const rejection = assert.rejects(cancelledRun);
    const waiting = await next();
    assert.equal(waiting.type, "run");
    abort.abort();
    await rejection;
    const cancel = await next();
    assert.equal(cancel.type, "cancel");
    assert.equal(getWorkItem(db, cancelled.id)?.state, "running");
    observe("cancellation queues a fenced stop without approving the canonical run", true, {
      cancelType: cancel.type,
      canonicalState: "running",
    });
    const expired = item();
    const expiring = backend.forItem(expired.id)(input(expired));
    const expiry = assert.rejects(expiring, /lease expired/);
    await next();
    now += 60_000;
    await expiry;
    observe(
      "expired remote lease rejects the waiting result and cannot silently run locally",
      true,
      { leaseMs: 60000 },
    );
  } finally {
    db.close();
  }
}
