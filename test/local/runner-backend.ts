import assert from "node:assert/strict";
import { createAcpActivityReporter } from "../../src/loop";
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
  saveCheckpoint,
  saveTaskMode,
  recordAgentCloseout,
  resumeUsagePauseNow,
  usagePause,
} from "../../src/db";
import { createLiveStatusProvider } from "../../src/web/src/live/provider";
import { workspaceId, issueWorkspaceBootstrap, workspaceTokenHash } from "../../src/workspace";
import { createRunnerControl } from "../../src/runner-control";
import { initializeRunnerAuthority, createRunnerKey } from "../../src/runner-identity";
import { createRunnerWork, createRunnerWorkHttp } from "../../src/runner-work";
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
  ArtifactRejectedError,
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
import { PawsShutdown } from "../../src/core";
import { createRunnerPlacement } from "../../src/runner-placement";
import { createFakeLinearIssueLifecycle } from "../../src/linear";

export async function probeRunnerBackend(
  root: string,
  observe: (name: string, passed: boolean, value: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(root, "config.toml"),
    '[checkout.projects."fixture/repository"]\nexclude = ["large"]\n',
  );
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
  const bot = { appId: "99", login: "paws-test[bot]", id: 88 };
  const backendOptions: Parameters<typeof createRemoteAgentRunner>[0] = {
    async checkpointBot(repository) {
      assert.equal(repository, "fixture/repository");
      return bot;
    },
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
  async function next(selectedRunnerId = runnerId, acknowledge = true) {
    for (let i = 0; i < 500; i++) {
      for (const envelope of work.commands(selectedRunnerId)) {
        const v = verifyRunnerCommand(envelope, {
          trustedKeys: new Map([["fixture", signing.publicKey]]),
          runnerId: selectedRunnerId,
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
          if (acknowledge) work.acknowledge(selectedRunnerId, v.command.id);
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
    bindLinearSessionTask(db, sessionId, record.delegationId, { actorId: "owner" });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, id]);
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
  const failoverAbort = new AbortController();
  let pendingFailover: Promise<unknown> | undefined;
  try {
    const denied = item();
    await assert.rejects(
      backend.forItem(denied.id)(input(denied)),
      /No available paired runner .*outside the runner workspace repository access/,
    );
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
    const updates: string[] = [];
    const running = backend.forItem(first.id)(
      input(first, {
        onEvent: (e) => {
          events.push(e);
        },
        postUpdate: {
          async post(text) {
            updates.push(text);
            return { posted: true };
          },
        },
        closeoutProgress: {
          record(progress) {
            recordAgentCloseout(db, first.run.id, first.id, progress, Date.now());
          },
        },
        publishArtifact: {
          async publish(snapshot, context) {
            if (context.evidence) {
              assert.deepEqual(context.evidence, {
                checkId: "browser-proof",
                attempt: 2,
                headCommit: "c".repeat(40),
              });
              assert.equal(context.request?.checkId, "browser-proof");
              assert.equal(snapshot.mimeType, "video/webm");
              throw new ArtifactRejectedError("The file is larger than 200 MB.");
            }
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
    assert.deepEqual(assigned.checkpointBot, bot);
    assert.equal(assigned.itemId, first.id);
    assert.equal(assigned.runId, first.run.id);
    assert.equal(assigned.repository.baseSha, base);
    assert.deepEqual(assigned.repository.checkoutExclusions, ["large"]);
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
    const videoBytes = Buffer.from("Remote video");
    const video = {
      id: randomUUID(),
      path: "reports/proof.webm",
      displayName: "proof.webm",
      mimeType: "video/webm",
      sizeBytes: videoBytes.length,
      sha256: createHash("sha256").update(videoBytes).digest("hex"),
      attachToIssue: false,
      evidence: { checkId: "browser-proof", attempt: 2, headCommit: "c".repeat(40) },
    };
    artifacts.upload({
      runnerId,
      runId: assigned.runId,
      token: grant.token,
      chunk: {
        generation: assigned.generation,
        artifact: video,
        index: 0,
        data: videoBytes.toString("base64"),
      },
    });
    work.event({
      runnerId,
      runId: assigned.runId,
      generation: assigned.generation,
      token: grant.token,
      sequence: 3,
      event: { type: "artifact", artifact: video },
    });
    work.event({
      runnerId,
      runId: assigned.runId,
      generation: assigned.generation,
      token: grant.token,
      sequence: 4,
      event: {
        type: "closeout",
        progress: {
          type: "finished",
          head,
          id: "test",
          kind: "command",
          command: "bun test",
          attempt: 1,
          maxAttempts: 3,
          state: "failed",
          exitCode: 1,
          timedOut: false,
          durationMs: 1_200,
          stdout: "1 fail on the runner",
          stderr: "expected 2, received 3",
          truncated: false,
        },
      },
    });
    results.submit({
      runnerId,
      runId: assigned.runId,
      generation: assigned.generation,
      token: grant.token,
      result: { ...result(assigned), candidateSha: head, sessionId: "first-session" },
    });
    const completed = await running;
    assert.equal(completed.stopReason, "end_turn");
    assert.equal(published, true);
    const refusal = db
      .query<{ answer: string }, [string]>(
        "SELECT answer FROM runner_question_answer WHERE run_id=? AND sequence=3",
      )
      .get(assigned.runId);
    assert.deepEqual(JSON.parse(refusal!.answer), { error: "The file is larger than 200 MB." });
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
    assert.deepEqual(updates, ["Implementation progress"]);
    const remoteCloseout = createLiveStatusProvider(db)
      .snapshot()
      .agentCloseout?.find((entry) => entry.runId === first.run.id);
    assert.deepEqual(
      remoteCloseout?.attempts.at(-1)?.checks.map((check) => [check.id, check.state, check.stdout]),
      [["test", "failed", "1 fail on the runner"]],
    );
    observe(
      "signed remote implementation imports the exact candidate while canonical verification remains pending",
      true,
      { candidate: head, fetched, canonicalState: "running", assignmentEnded: true },
    );
    await git(["-C", source, "reset", "--hard", base]);
    const fetchedBefore = fetched;
    const stopped = item();
    const early = backend.forItem(stopped.id)(input(stopped));
    const earlyCommand = await next();
    if (earlyCommand.type !== "run") throw new Error("Expected an implementation run");
    const earlyToken = work.issueGrant({
      runnerId,
      runId: earlyCommand.runId,
      commandId: earlyCommand.id,
      generation: earlyCommand.generation,
    });
    results.submit({
      runnerId,
      runId: earlyCommand.runId,
      generation: earlyCommand.generation,
      token: earlyToken.token,
      result: {
        ...result(earlyCommand),
        stopReason: "error",
        errorMessage: "The agent stopped early",
        candidateSha: head,
      },
    });
    assert.equal((await early).stopReason, "error");
    assert.equal(getWorkItem(db, stopped.id)?.checkpoint?.wipCommit, head);
    assert.equal(await git(["-C", source, "rev-parse", "HEAD"]), head);
    assert.equal(fetched, fetchedBefore + 1);
    fetched = fetchedBefore;
    observe("an early-stopped remote run keeps its work for the next run of the item", true, {
      wipCommit: head,
    });
    db.run(
      "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?) ON CONFLICT(runner_id) DO UPDATE SET runner_version=excluded.runner_version",
      [runnerId, "0.1.24", Date.now()],
    );
    const continued: Record<string, string | null> = {};
    for (const [name, record] of [
      ["ended", first],
      ["errored", stopped],
    ] as const) {
      const stop = new AbortController();
      const again = backend.forItem(record.id)(input(record, { signal: stop.signal }));
      void again.catch(() => undefined);
      let command = await next();
      while (command.type !== "run" || command.itemId !== record.id) command = await next();
      stop.abort();
      await again.catch(() => undefined);
      continued[name] = command.resumeSessionId ?? null;
    }
    while (work.commands(runnerId).length) await next();
    db.run("DELETE FROM runner_host_status WHERE runner_id=?", [runnerId]);
    observe(
      "a later run resumes the agent session of the item's last run unless that run errored",
      continued.ended === "first-session" && continued.errored === null,
      continued,
    );
    await git(["-C", source, "reset", "--hard", base]);
    const detached = item();
    const shutdown = new AbortController();
    const beforeEvents: string[] = [];
    const beforeRestart = backend.forItem(detached.id)(
      input(detached, {
        signal: shutdown.signal,
        onEvent: (event) => {
          if (event.type === "progress") beforeEvents.push(event.text);
        },
      }),
    );
    void beforeRestart.catch(() => undefined);
    const detachedCommand = await next();
    if (detachedCommand.type !== "run") throw new Error("Expected an implementation run");
    const detachedGrant = work.issueGrant({
      runnerId,
      runId: detachedCommand.runId,
      commandId: detachedCommand.id,
      generation: detachedCommand.generation,
    });
    work.event({
      runnerId,
      runId: detachedCommand.runId,
      generation: detachedCommand.generation,
      token: detachedGrant.token,
      sequence: 1,
      event: { type: "progress", text: "Before restart" },
    });
    for (let attempt = 0; attempt < 500 && beforeEvents.length === 0; attempt++) await delay(2);
    shutdown.abort(new PawsShutdown());
    await beforeRestart.catch(() => undefined);
    const leftLive =
      db
        .query<{ ended: number | null }, [string]>(
          "SELECT ended_at AS ended FROM runner_work WHERE run_id=?",
        )
        .get(detachedCommand.runId)?.ended === null;
    const cancelSent = work.commands(runnerId).length > 0;
    const afterEvents: string[] = [];
    const afterRestart = backend.forItem(detached.id)(
      input(detached, {
        onEvent: (event) => {
          if (event.type === "progress") afterEvents.push(event.text);
        },
      }),
    );
    work.event({
      runnerId,
      runId: detachedCommand.runId,
      generation: detachedCommand.generation,
      token: detachedGrant.token,
      sequence: 2,
      event: { type: "progress", text: "After restart" },
    });
    for (let attempt = 0; attempt < 500 && afterEvents.length === 0; attempt++) await delay(2);
    results.submit({
      runnerId,
      runId: detachedCommand.runId,
      generation: detachedCommand.generation,
      token: detachedGrant.token,
      result: { ...result(detachedCommand), candidateSha: head },
    });
    const fetchedBeforeRestart = fetched;
    const reattached = await afterRestart;
    fetched = fetchedBeforeRestart;
    const redispatched = work.commands(runnerId).length > 0;
    observe(
      "a Paws restart leaves a runner's work running and the next call picks up its later events and result",
      leftLive &&
        !cancelSent &&
        !redispatched &&
        reattached.stopReason === "end_turn" &&
        JSON.stringify(beforeEvents) === JSON.stringify(["Before restart"]) &&
        JSON.stringify(afterEvents) === JSON.stringify(["After restart"]),
      {
        leftLive,
        cancelSent,
        redispatched,
        stopReason: reattached.stopReason,
        beforeEvents,
        afterEvents,
      },
    );
    const reviewer = item();
    let text = "";
    const reviewed = backend.forItem(reviewer.id)(
      input(reviewer, {
        role: "reviewer",
        checkoutExclusions: ["captured"],
        readOnly: true,
        resume: { sessionId: "earlier-review", replayPrompt: "Replayed review" },
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
    writeFileSync(
      join(root, "config.toml"),
      '[checkout.projects."fixture/repository"]\nexclude = ["changed"]\n',
    );
    const review = await next();
    assert.equal(review.type, "review");
    if (review.type !== "review") throw new Error("Unexpected command");
    assert.deepEqual(review.repository.checkoutExclusions, ["captured"]);
    assert.equal(review.prompt, "Replayed review");
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
      "independent remote review replays a resumed prompt, forwards final findings once and cannot publish a candidate",
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
            checkoutExclusions: Array.from(
              { length: 10 },
              (_, index) => `omitted-${index}-${"x".repeat(500)}`,
            ),
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
        const taskUpdates: string[] = [];
        const publicActivities: { body: string; action?: unknown }[] = [];
        const reporter = createAcpActivityReporter((activity) => publicActivities.push(activity));
        const beforeFetch: number = fetched;
        const response = sealedBackend.forItem(task.id)(
          input(task, {
            worktreePath: directory,
            readOnly: purpose === "answer",
            networkGit: undefined,
            onEvent(event) {
              taskEvents.push(event);
              reporter.onEvent(event);
            },
            postUpdate: {
              async post(update) {
                taskUpdates.push(update);
                return { posted: true };
              },
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
        assert.deepEqual(taskUpdates, ["Bounded progress"]);
        let activitySequence = purpose === "artifact" ? 3 : 2;
        for (const update of [
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: 'Setting up the frontend. token="split' },
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: '-credential".' },
          },
          {
            sessionUpdate: "tool_call",
            toolCallId: "browser",
            title: "Run browser",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "chromium", token: "private-typed-input" },
            _meta: { terminal_output_delta: { data: 'token="split' } },
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "browser",
            status: "completed",
            _meta: {
              terminal_output_delta: {
                data:
                  '-credential". Screenshot saved {"access_token":"private-typed-output"} ' +
                  "x".repeat(100_000),
              },
            },
          },
        ] as const)
          assert.equal(
            (await createRunnerWorkHttp(work)(
              new Request("https://runner.example/v1/events", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: `Bearer ${taskGrant.token}`,
                },
                body: JSON.stringify({
                  runId: command.runId,
                  generation: command.generation,
                  sequence: ++activitySequence,
                  event: { type: "activity", update },
                }),
              }),
              runnerId,
            ))!.status,
            200,
          );
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
        reporter.flush();
        assert.deepEqual(
          taskEvents
            .filter((event) => event.type === "progress" && event.messageChunk)
            .map((event) => (event.type === "progress" ? event.text : "")),
          ['Setting up the frontend. token="split', '-credential".'],
        );
        assert.equal(
          publicActivities.filter(
            (activity) => activity.body === 'Setting up the frontend. token="[redacted]".',
          ).length,
          1,
        );
        assert(!JSON.stringify(publicActivities).includes("Screenshot saved"));
        assert(!JSON.stringify(publicActivities).includes("private-typed-input"));
        assert(!JSON.stringify(publicActivities).includes("private-typed-output"));
        assert(!JSON.stringify(publicActivities).includes("-credential"));

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
          postUpdate: {
            async post(update) {
              receivedProgress.push(update);
              return { posted: true };
            },
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
    for (const envelope of work.commands(runnerId)) {
      const command = JSON.parse(
        Buffer.from(envelope.payload, "base64url").toString(),
      ) as RunnerCommand;
      if (command.type === "cancel") work.acknowledge(runnerId, command.id);
    }
    const hostIds = [runnerId];
    for (const name of ["second", "third"]) {
      const hostKey = await createRunnerKey(join(root, `client-${name}`));
      const pairing = await control.beginPairing({ name, csr: hostKey.csr });
      hostIds.push((await control.approvePairing(principal, pairing.code)).runnerId);
    }
    for (const hostId of hostIds) work.heartbeat(hostId);
    const placements: string[] = [];
    const observedFailures: string[] = [];
    const failoverItem = item();
    for (const [index, id] of hostIds.entries()) {
      db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [id]);
      db.run(
        "INSERT INTO runner_agent_policy(runner_id,agent,ready,virtual_finish) VALUES(?,'codex',1,?)",
        [id, index * 10],
      );
    }
    const placementLifecycle = createFakeLinearIssueLifecycle({
      id: getWorkItem(db, failoverItem.id)!.linearIssueId,
      teamId: "fixture-team",
      assigneeId: "owner",
      delegateId: "app-user",
      stateType: "started",
      projectId: "fixture-project",
    });
    const placement = createRunnerPlacement({
      db,
      now: () => now,
      lifecycle: placementLifecycle,

      tracker: {
        async listProjectMembers() {
          return ["owner"];
        },
      },
    });
    let selectionReads = 0;
    const placedBackend = createRemoteAgentRunner({
      ...backendOptions,
      placement: {
        candidates(request) {
          selectionReads++;
          return placement.candidates(request);
        },
        started(request) {
          assert(db.inTransaction);
          assert(
            db
              .query(
                request.purpose === "work"
                  ? "SELECT 1 FROM runner_work WHERE command_id=? AND runner_id=?"
                  : "SELECT 1 FROM runner_command WHERE id=? AND runner_id=?",
              )
              .get(request.commandId, request.runnerId),
          );
          placement.started(request);
          placements.push(request.runnerId);
        },
        finished(observation) {
          assert(db.inTransaction);
          const disposition = placement.finished(observation);
          if (disposition.retryable)
            observedFailures.push(
              observation.failure ??
                (observation.result?.authRequired ? "auth_expired" : "quota_exhausted"),
            );
          return disposition;
        },
      },
    });
    const beforeFailoverImports = fetched;
    await git(["-C", source, "reset", "--hard", base]);
    const selectionsBeforeWork = selectionReads;
    let delayedPreparation = false;
    const failover = placedBackend.forItem(failoverItem.id)(
      input(failoverItem, {
        signal: failoverAbort.signal,
        prepareInputFiles: async ({ prompt }) => {
          if (!delayedPreparation) {
            delayedPreparation = true;
            now += 16_000;
            for (const hostId of hostIds) work.heartbeat(hostId);
            db.run("UPDATE workspace_member SET checked_at=? WHERE user_id=?", [
              now,
              principal.userId,
            ]);
          }
          return { prompt, inputFiles: [] };
        },
      }),
    );
    pendingFailover = failover;
    void failover.catch(() => undefined);
    const firstAttempt = await Promise.race([
      next(hostIds[0]!),
      failover.then(() => {
        throw new Error("Work completed before its assignment");
      }),
    ]);
    if (firstAttempt.type !== "run") throw new Error("Expected first failover work");
    assert.equal(selectionReads - selectionsBeforeWork, 2);
    observe(
      "slow preparation and a benign membership refresh receive fresh runner admission immediately before assignment",
      true,
      { preparationMs: 16000, selections: 2 },
    );
    const firstToken = work.issueGrant({
      runnerId: hostIds[0]!,
      runId: firstAttempt.runId,
      commandId: firstAttempt.id,
      generation: firstAttempt.generation,
    });
    work.event({
      runnerId: hostIds[0]!,
      runId: firstAttempt.runId,
      generation: firstAttempt.generation,
      token: firstToken.token,
      sequence: 1,
      event: {
        type: "activity",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retained work before heartbeat loss" },
        },
      },
    });
    for (
      let index = 0;
      index < 100 && !existsSync(`${runDir(root, failoverItem.run.id)}/acp.jsonl`);
      index++
    )
      await delay(1);
    db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now - 60_000, hostIds[0]!]);
    const firstStop = await next(hostIds[0]!, false);
    assert.equal(firstStop.type, "cancel");
    await delay(10);
    assert.equal(work.commands(hostIds[1]!).length, 0);
    assert.equal(fetched, beforeFailoverImports);
    for (const envelope of work.commands(hostIds[0]!)) {
      const command = JSON.parse(
        Buffer.from(envelope.payload, "base64url").toString(),
      ) as RunnerCommand;
      if (command.type === "cancel") work.acknowledge(hostIds[0]!, command.id);
    }
    const secondAttempt = await next(hostIds[1]!);
    if (secondAttempt.type !== "run") throw new Error("Expected second failover work");
    assert.equal(secondAttempt.generation, firstAttempt.generation + 1);
    assert.match(secondAttempt.prompt, /fresh agent session/);
    assert.match(secondAttempt.prompt, /Retained work before heartbeat loss/);
    assert.throws(
      () =>
        results.submit({
          runnerId: hostIds[0]!,
          runId: firstAttempt.runId,
          generation: firstAttempt.generation,
          token: firstToken.token,
          result: { ...result(firstAttempt), candidateSha: head },
        }),
      /fenced|expired|unavailable/i,
    );
    const secondToken = work.issueGrant({
      runnerId: hostIds[1]!,
      runId: secondAttempt.runId,
      commandId: secondAttempt.id,
      generation: secondAttempt.generation,
    });
    results.submit({
      runnerId: hostIds[1]!,
      runId: secondAttempt.runId,
      generation: secondAttempt.generation,
      token: secondToken.token,
      result: {
        ...result(secondAttempt),
        stopReason: "error",
        errorMessage: "You've hit your session limit. Retry-After: 120",
      },
    });
    const secondStop = await next(hostIds[1]!, false);
    assert.equal(secondStop.type, "cancel");
    await delay(10);
    assert.equal(work.commands(hostIds[2]!).length, 0);
    for (const envelope of work.commands(hostIds[1]!)) {
      const command = JSON.parse(
        Buffer.from(envelope.payload, "base64url").toString(),
      ) as RunnerCommand;
      if (command.type === "cancel") work.acknowledge(hostIds[1]!, command.id);
    }
    const thirdAttempt = await next(hostIds[2]!);
    if (thirdAttempt.type !== "run") throw new Error("Expected third failover work");
    assert.equal(thirdAttempt.generation, secondAttempt.generation + 1);
    const thirdToken = work.issueGrant({
      runnerId: hostIds[2]!,
      runId: thirdAttempt.runId,
      commandId: thirdAttempt.id,
      generation: thirdAttempt.generation,
    });
    assert.match(thirdAttempt.prompt, /Retained work before heartbeat loss/);
    for (let eventSequence = 1; eventSequence <= 130; eventSequence++)
      work.event({
        runnerId: hostIds[2]!,
        runId: thirdAttempt.runId,
        generation: thirdAttempt.generation,
        token: thirdToken.token,
        sequence: eventSequence,
        event: {
          type: "activity",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Final event ${eventSequence}` },
          },
        },
      });
    results.submit({
      runnerId: hostIds[2]!,
      runId: thirdAttempt.runId,
      generation: thirdAttempt.generation,
      token: thirdToken.token,
      result: { ...result(thirdAttempt), candidateSha: head },
    });
    db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now - 60_001, hostIds[2]!]);
    assert.equal((await failover).stopReason, "end_turn");
    assert.match(
      readFileSync(`${runDir(root, failoverItem.run.id)}/acp.jsonl`, "utf8"),
      /Final event 130/,
    );
    assert.deepEqual(placements, hostIds);
    assert.deepEqual(observedFailures, ["heartbeat_lost", "quota_exhausted"]);
    assert.equal(fetched, beforeFailoverImports + 1);
    assert.equal(getWorkItem(db, failoverItem.id)?.currentRunId, failoverItem.run.id);
    observe(
      "Three paired hosts join cancellation before fresh heartbeat and quota failover with one candidate import",
      true,
      {
        hostIds,
        generations: [firstAttempt.generation, secondAttempt.generation, thirdAttempt.generation],
        observedFailures,
        imports: fetched - beforeFailoverImports,
        retainedHandoff: true,
        completedCandidateHonoredAfterHeartbeatLoss: true,
      },
    );
    work.heartbeat(hostIds[0]!);
    work.heartbeat(hostIds[2]!);
    const preparing = placedBackend.forItem(failoverItem.id)(
      input(failoverItem, { prepareOnly: true, signal: failoverAbort.signal }),
    );
    pendingFailover = preparing;
    const failoverProbe = await next(hostIds[0]!);
    assert.equal(failoverProbe.type, "probe");
    health.submit(hostIds[0]!, {
      ...result(failoverProbe),
      models: [{ id: "model", name: "Model" }],
    });
    await preparing;
    const artifactItem = item();
    placementLifecycle.issues.set(getWorkItem(db, artifactItem.id)!.linearIssueId, {
      ...placementLifecycle.issue,
      id: getWorkItem(db, artifactItem.id)!.linearIssueId,
    });
    await git(["-C", source, "reset", "--hard", base]);
    const continuationState: { answer: string | null; questionId?: string } = { answer: null };
    let publications = 0;
    const artifactFailover = placedBackend.forItem(artifactItem.id)(
      input(artifactItem, {
        signal: failoverAbort.signal,
        publishArtifact: {
          async publish() {
            publications++;
            return { url: "https://linear.app/artifact/retained" };
          },
        },
        askTeam: {
          async ask(request, context) {
            applyWorkItemEvent(db, artifactItem.id, "blocking_question");
            const question = openQuestion(db, {
              itemId: artifactItem.id,
              runId: artifactItem.run.id,
              sessionId: getWorkItem(db, artifactItem.id)!.sessionKey!,
              body: request.question,
              now,
            });
            continuationState.questionId = question.id;
            while (continuationState.answer === null)
              await delay(1, undefined, { signal: context.signal });
            answerQuestion(db, question.id, {
              answer: continuationState.answer,
              answeredBy: "owner",
              now,
            });
            applyWorkItemEvent(db, artifactItem.id, "answer_received");
            return { answer: continuationState.answer };
          },
        },
      }),
    );
    pendingFailover = artifactFailover;
    void artifactFailover.catch(() => undefined);
    const artifactCommand = await next(hostIds[0]!);
    if (artifactCommand.type !== "run") throw new Error("Expected artifact failover work");
    const artifactToken = work.issueGrant({
      runnerId: hostIds[0]!,
      runId: artifactCommand.runId,
      commandId: artifactCommand.id,
      generation: artifactCommand.generation,
    });
    const retainedBytes = Buffer.from("Retained artifact");
    const retainedArtifact = {
      id: randomUUID(),
      path: "reports/retained.txt",
      displayName: "Retained",
      mimeType: "text/plain",
      sizeBytes: retainedBytes.length,
      sha256: createHash("sha256").update(retainedBytes).digest("hex"),
      attachToIssue: true,
    };
    artifacts.upload({
      runnerId: hostIds[0]!,
      runId: artifactCommand.runId,
      token: artifactToken.token,
      chunk: {
        generation: artifactCommand.generation,
        artifact: retainedArtifact,
        index: 0,
        data: retainedBytes.toString("base64"),
      },
    });
    work.event({
      runnerId: hostIds[0]!,
      runId: artifactCommand.runId,
      generation: artifactCommand.generation,
      token: artifactToken.token,
      sequence: 1,
      event: { type: "artifact", artifact: retainedArtifact },
    });
    results.submit({
      runnerId: hostIds[0]!,
      runId: artifactCommand.runId,
      generation: artifactCommand.generation,
      token: artifactToken.token,
      result: {
        ...result(artifactCommand),
        stopReason: "error",
        errorMessage: "You've hit your session limit. Retry-After: 120",
      },
    });
    db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now - 60_001, hostIds[0]!]);
    const artifactStop = await next(hostIds[0]!, false);
    assert.equal(artifactStop.type, "cancel");
    for (const envelope of work.commands(hostIds[0]!)) {
      const command = JSON.parse(
        Buffer.from(envelope.payload, "base64url").toString(),
      ) as RunnerCommand;
      if (command.type === "cancel") work.acknowledge(hostIds[0]!, command.id);
    }
    for (let index = 0; index < 1000 && !continuationState.questionId; index++) await delay(1);
    assert(continuationState.questionId);
    assert.equal(getWorkItem(db, artifactItem.id)?.state, "awaiting_input");
    assert.equal(work.commands(hostIds[2]!).length, 0);
    assert.equal(publications, 1);
    continuationState.answer = "Keep the existing artifact and continue without republishing it.";
    const approvedCommand = await next(hostIds[2]!);
    if (approvedCommand.type !== "run") throw new Error("Expected approved continuation");
    assert.match(approvedCommand.prompt, /Keep the existing artifact/);
    const approvedToken = work.issueGrant({
      runnerId: hostIds[2]!,
      runId: approvedCommand.runId,
      commandId: approvedCommand.id,
      generation: approvedCommand.generation,
    });
    results.submit({
      runnerId: hostIds[2]!,
      runId: approvedCommand.runId,
      generation: approvedCommand.generation,
      token: approvedToken.token,
      result: { ...result(approvedCommand), candidateSha: head },
    });
    await artifactFailover;
    assert.equal(publications, 1);
    observe(
      "Published artifact failover pauses through a real persisted question before human continuation",
      true,
      {
        questionId: continuationState.questionId,
        publications,
        continuation: continuationState.answer,
        generation: approvedCommand.generation,
      },
    );
    {
      now += 120_001;
      for (const id of hostIds) work.heartbeat(id);
      const reviewEvents: string[] = [];
      const independentReview = placedBackend.forItem(artifactItem.id)(
        input(artifactItem, {
          role: "reviewer",
          readOnly: true,
          profile: { agent: "codex", model: "review-model" },
          signal: failoverAbort.signal,
          onEvent(event) {
            if (
              event.type === "session_update" &&
              (event.update.sessionUpdate === "agent_message_chunk" ||
                event.update.sessionUpdate === "agent_thought_chunk") &&
              event.update.content.type === "text"
            )
              reviewEvents.push(event.update.content.text);
          },
        }),
      );
      pendingFailover = independentReview;
      void independentReview.catch(() => undefined);
      const conflicting = await next(hostIds[0]!);
      if (conflicting.type !== "review") throw new Error("Expected independent review command");
      const conflictGrant = work.issueGrant({
        runnerId: hostIds[0]!,
        runId: conflicting.runId,
        commandId: conflicting.id,
        generation: conflicting.generation,
      });
      work.event({
        runnerId: hostIds[0]!,
        runId: conflicting.runId,
        generation: conflicting.generation,
        token: conflictGrant.token,
        sequence: 1,
        event: { type: "progress", text: "Conflicting review must remain unpublished" },
      });
      results.submit({
        runnerId: hostIds[0]!,
        runId: conflicting.runId,
        generation: conflicting.generation,
        token: conflictGrant.token,
        result: {
          ...result(conflicting, "reviewer"),
          reviewText: "Conflicting review must remain unpublished",
        },
      });
      assert.equal((await next(hostIds[0]!, false)).type, "cancel");
      for (const envelope of work.commands(hostIds[0]!)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        if (command.type === "cancel") work.acknowledge(hostIds[0]!, command.id);
      }
      const independent = await next(hostIds[1]!);
      if (independent.type !== "review") throw new Error("Expected fresh independent review");
      const independentGrant = work.issueGrant({
        runnerId: hostIds[1]!,
        runId: independent.runId,
        commandId: independent.id,
        generation: independent.generation,
      });
      results.submit({
        runnerId: hostIds[1]!,
        runId: independent.runId,
        generation: independent.generation,
        token: independentGrant.token,
        result: {
          ...result(independent, "reviewer"),
          identity: { ...result(independent, "reviewer").identity, model: "independent-model" },
          reviewText: "Independent approval",
        },
      });
      await independentReview;
      assert(!reviewEvents.some((message) => message.includes("Conflicting review")));
      assert(reviewEvents.includes("Independent approval"));
      assert.equal(
        db
          .query<{ outcome: string }, [string]>(
            "SELECT outcome FROM runner_execution_usage WHERE command_id=?",
          )
          .get(conflicting.id)!.outcome,
        "model_conflict",
      );
      observe(
        "Unexpected reviewer model reuse joins before fresh independent review without publishing conflicting output",
        true,
        { conflicting: conflicting.id, independent: independent.id, reviewEvents },
      );
    }
    {
      const coolDown = (until: number) =>
        db.run("UPDATE runner_agent_policy SET cooldown_until=? WHERE agent='codex'", [until]);
      const dispatched = async () => {
        for (let attempt = 0; attempt < 500; attempt++) {
          for (const hostId of hostIds) if (work.commands(hostId).length) return hostId;
          await delay(2);
        }
        return null;
      };
      for (const hostId of hostIds) work.heartbeat(hostId);
      const tracked = () => {
        const record = item();
        const issueId = getWorkItem(db, record.id)!.linearIssueId;
        placementLifecycle.issues.set(issueId, { ...placementLifecycle.issue, id: issueId });
        return record;
      };
      const paused = async (runId: string) => {
        for (let attempt = 0; attempt < 500 && !usagePause(db, runId); attempt++) await delay(2);
        return usagePause(db, runId);
      };
      const limited = tracked();
      const limitAbort = new AbortController();
      const lines: string[] = [];
      coolDown(now + 120_000);
      const limitedRun = placedBackend.forItem(limited.id)(
        input(limited, {
          signal: limitAbort.signal,
          onEvent: (event) => {
            if (event.type === "progress") lines.push(event.text);
          },
        }),
      );
      let settled = false;
      void limitedRun.then(
        () => (settled = true),
        () => (settled = true),
      );
      const limitedPause = await paused(getWorkItem(db, limited.id)!.currentRunId!);
      assert.equal(limitedPause?.resumeAt, now + 180_000);
      await delay(20);
      assert.equal(settled, false);
      assert.deepEqual(lines, [
        `Paused: Codex reached its usage limit. Paws continues at ${new Date(now + 180_000).toISOString().slice(11, 16)} UTC.`,
      ]);
      now += 180_000;
      for (const hostId of hostIds) work.heartbeat(hostId);
      db.run("UPDATE workspace_member SET checked_at=? WHERE user_id=?", [now, principal.userId]);
      const placedOn = await dispatched();
      assert(placedOn);
      assert.equal(usagePause(db, limitedPause!.runId), null);
      assert.equal(lines.length, 2);
      limitAbort.abort();
      await limitedRun.catch(() => undefined);
      observe(
        "work that cannot start for a usage limit waits for its reset instead of failing",
        true,
        {
          placedOn,
        },
      );

      const exhausted = tracked();
      const exhaustedAbort = new AbortController();
      coolDown(now + 3_600_000);
      const exhaustedRun = placedBackend.forItem(exhausted.id)(
        input(exhausted, { signal: exhaustedAbort.signal }),
      );
      void exhaustedRun.catch(() => undefined);
      const exhaustedRunId = getWorkItem(db, exhausted.id)!.currentRunId!;
      assert(await paused(exhaustedRunId));
      for (const hostId of hostIds) while (work.commands(hostId).length) await next(hostId);
      await delay(20);
      assert(hostIds.every((hostId) => work.commands(hostId).length === 0));
      assert.equal(resumeUsagePauseNow(db, exhaustedRunId, now), true);
      assert(await dispatched());
      exhaustedAbort.abort();
      await exhaustedRun.catch(() => undefined);
      coolDown(0);
      observe("Resume now ends a usage-limit wait and lifts the agent cooldown", true, {});
      const occupied = hostIds.map((hostId) => {
        const busy = tracked();
        db.run(
          "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,1,0,?,?)",
          [
            getWorkItem(db, busy.id)!.currentRunId!,
            hostId,
            workspace.id,
            `busy-${hostId}`,
            Date.now() + 3_600_000,
          ],
        );
        return `busy-${hostId}`;
      });
      const queued = tracked();
      const waitAbort = new AbortController();
      const waitingRun = placedBackend.forItem(queued.id)(
        input(queued, { signal: waitAbort.signal }),
      );
      let waitSettled = false;
      void waitingRun.then(
        () => (waitSettled = true),
        () => (waitSettled = true),
      );
      await delay(60);
      assert.equal(waitSettled, false);
      db.run("UPDATE runner_work SET ended_at=? WHERE command_id=?", [Date.now(), occupied[0]!]);
      const placedWhenFree = await dispatched();
      assert.equal(placedWhenFree, hostIds[0]);
      waitAbort.abort();
      await waitingRun.catch(() => undefined);
      db.run(
        `UPDATE runner_work SET ended_at=? WHERE command_id IN (${occupied.map(() => "?").join(",")})`,
        [Date.now(), ...occupied],
      );
      observe("a full runner makes placement wait for a free slot instead of failing", true, {
        placedWhenFree,
      });
      const reportVersion = (version: string) => {
        for (const hostId of hostIds)
          db.run(
            "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?) ON CONFLICT(runner_id) DO UPDATE SET runner_version=excluded.runner_version",
            [hostId, version, now],
          );
      };
      const firstDispatch = async () => {
        for (let attempt = 0; attempt < 500; attempt++) {
          for (const hostId of hostIds) if (work.commands(hostId).length) return next(hostId);
          await delay(2);
        }
        throw new Error("No dispatched runner command");
      };
      const drain = async () => {
        for (const hostId of hostIds) while (work.commands(hostId).length) await next(hostId);
      };
      const sent = async (version: string) => {
        await drain();
        reportVersion(version);
        for (const hostId of hostIds) work.heartbeat(hostId);
        const record = tracked();
        saveCheckpoint(db, record.id, { phase: "running", baseSha: base, wipCommit: head });
        const stopVersioned = new AbortController();
        const versionedRun = placedBackend.forItem(record.id)(
          input(record, { signal: stopVersioned.signal, checkpoint: false }),
        );
        void versionedRun.catch(() => undefined);
        const command = await firstDispatch();
        stopVersioned.abort();
        await versionedRun.catch(() => undefined);
        await drain();
        return command;
      };
      await git(["-C", source, "reset", "--hard", head]);
      const legacy = await sent("0.1.18");
      const current = await sent("0.1.19");
      const moved = (
        await git(["-C", source, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "moved main"])
      ).trim();
      await git(["-C", source, "update-ref", "refs/paws/upstream-main", moved]);
      const beforeRebase = await sent("0.1.22");
      const rebasing = await sent("0.1.23");
      await git(["-C", source, "update-ref", "-d", "refs/paws/upstream-main"]);
      await git(["-C", source, "reset", "--hard", base]);
      if (beforeRebase.type !== "run" || rebasing.type !== "run")
        throw new Error("Expected run commands");
      observe(
        "runners on 0.1.23 or later receive the main Paws last fetched, even past the run's base",
        beforeRebase.repository.mainSha === base && rebasing.repository.mainSha === moved,
        { before: beforeRebase.repository.mainSha, rebasing: rebasing.repository.mainSha, moved },
      );
      if (legacy.type !== "run" || current.type !== "run") throw new Error("Expected run commands");
      assert.equal(legacy.repository.mainSha, undefined);
      assert.equal(legacy.checkpoint, undefined);
      assert.equal(current.repository.mainSha, base);
      assert.equal(current.checkpoint, false);
      observe(
        "only runners on 0.1.19 or later receive the task's main commit and checkpoint opt-out",
        true,
        { legacy: legacy.repository.baseSha, current: current.repository.mainSha },
      );
      const nextRun = async () => {
        for (let attempt = 0; attempt < 500; attempt++) {
          for (const hostId of hostIds)
            while (work.commands(hostId).length) {
              const command = await next(hostId);
              if (command.type === "run") return command;
            }
          await delay(2);
        }
        throw new Error("No dispatched run command");
      };
      await drain();
      for (const hostId of hostIds) work.heartbeat(hostId);
      const restarted = tracked();
      const restartAbort = new AbortController();
      let restartFailure: unknown = null;
      const restartedRun = placedBackend.forItem(restarted.id)(
        input(restarted, { signal: restartAbort.signal }),
      );
      void restartedRun.catch((error: unknown) => (restartFailure = error));
      const firstPlacement = await nextRun();
      db.run("UPDATE runner_work SET lease_until=? WHERE run_id=?", [now - 1, firstPlacement.runId]);
      for (const hostId of hostIds) work.heartbeat(hostId);
      await delay(50);
      assert.equal(restartFailure, null);
      const secondPlacement = await nextRun();
      assert.equal(secondPlacement.runId, firstPlacement.runId);
      assert.equal(secondPlacement.generation, firstPlacement.generation + 1);
      restartAbort.abort();
      await restartedRun.catch(() => undefined);
      await drain();
      observe(
        "a runner restart that expires the work's lease places the run again instead of failing",
        true,
        { generations: [firstPlacement.generation, secondPlacement.generation] },
      );
      const offlineAt = now - 120_000;
      for (const hostId of hostIds)
        db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [offlineAt, hostId]);
      const offline = tracked();
      const offlineAbort = new AbortController();
      let offlineSettled = false;
      const offlineRun = placedBackend.forItem(offline.id)(
        input(offline, { signal: offlineAbort.signal }),
      );
      void offlineRun.then(
        () => (offlineSettled = true),
        () => (offlineSettled = true),
      );
      await delay(60);
      assert.equal(offlineSettled, false);
      for (const hostId of hostIds) work.heartbeat(hostId);
      const placedWhenOnline = await dispatched();
      assert.notEqual(placedWhenOnline, null);
      offlineAbort.abort();
      await offlineRun.catch(() => undefined);
      await drain();
      observe("placement waits for a paired runner to come online instead of failing", true, {
        placedWhenOnline,
      });
    }
  } finally {
    failoverAbort.abort();
    await pendingFailover?.catch(() => undefined);
    db.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("A disposable proof directory is required");
  const files = [
    "src/runner-backend/index.ts",
    "src/runner-backend/helpers.ts",
    "src/runner-backend/failover.ts",
    "src/runner-backend/cancel.ts",
    "src/runner-placement/index.ts",
    "src/runner-placement/placement.ts",
    "src/runner-placement/quota.ts",
    "src/runner-work/control.ts",
    "src/runner-helpers/index.ts",
    "src/db/migrations.ts",
    "test/local/runner-backend.ts",
  ];
  const hashes = Object.fromEntries(
    files.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]),
  );
  const observations: unknown[] = [];
  await probeRunnerBackend(root, (name, passed, value) =>
    observations.push({ name, passed, value }),
  );
  for (const file of files)
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), hashes[file], file);
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  writeFileSync(join(root, "source-hashes.json"), JSON.stringify(hashes, null, 2));
  console.log(JSON.stringify({ root, passed: observations.length }));
}
