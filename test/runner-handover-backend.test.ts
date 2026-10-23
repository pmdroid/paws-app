import { afterAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runDir, type RunAgentOptions } from "../src/acp";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { findOpenQuestion, openQuestion } from "../src/questions";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { verifyRunnerCommand, type RunnerCommand } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import {
  createFakeRunnerTranscriptObjects,
  createRunnerTranscripts,
} from "../src/runner-transcripts";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";

const root = mkdtempSync(join(tmpdir(), "paws-handover-backend-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
  if (code !== 0) throw new Error(err);
  return out.trim();
}

async function fixture() {
  const dir = mkdtempSync(join(root, "fixture-"));
  const db = openDatabase(join(dir, "paws.sqlite"));
  migrate(db);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-work",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "fixture-work", now)),
    now,
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "fixture-team",
  ]);
  const issuer = join(dir, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
  });
  const pending = await control.beginPairing({
    name: "VM",
    csr: (await createRunnerKey(join(dir, "client"))).csr,
  });
  const { runnerId } = await control.approvePairing(
    { workspaceId: workspace.id, userId, role: "owner", authenticatedAt: now, teamIds: [] },
    pending.code,
  );
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({ db, keyId: "fixture", privateKey: signing.privateKey });
  const results = createRunnerResults({ db, work });
  const health = createRunnerHealth({ db, work });
  const transcripts = createRunnerTranscripts({
    db,
    work,
    objects: createFakeRunnerTranscriptObjects(),
  });
  work.heartbeat(runnerId);

  const source = join(dir, "source");
  await git(["init", "-b", "main", source]);
  writeFileSync(join(source, "result.txt"), "base\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Base"]);
  const paws = join(dir, "paws-worktree");
  const runner = join(dir, "runner-worktree");
  await git(["clone", "-q", source, paws]);
  await git(["clone", "-q", source, runner]);

  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    transcripts,
    pollIntervalMs: 2,
    handoverMs: 400,
    async fetchCandidate(candidate) {
      await git(["-C", candidate.worktree, "fetch", "-q", runner, candidate.candidateSha]);
      await git(["-C", candidate.worktree, "reset", "-q", "--hard", candidate.candidateSha]);
    },
  });
  const seen = new Set<string>();
  async function next(): Promise<RunnerCommand> {
    for (let i = 0; i < 2000; i++) {
      for (const envelope of work.commands(runnerId)) {
        const verified = verifyRunnerCommand(envelope, {
          trustedKeys: new Map([["fixture", signing.publicKey]]),
          runnerId,
          workspaceId: workspace.id,
          now: Date.now(),
          allowedRepositories: ["fixture/repository"],
          claimCommand: (id) => !seen.has(id) && Boolean(seen.add(id)),
        });
        if (verified.ok) {
          work.acknowledge(runnerId, verified.command.id);
          return verified.command;
        }
      }
      await delay(2);
    }
    throw new Error("No runner command was dispatched");
  }
  let sequence = 0;
  function item() {
    const id = `item-${++sequence}`;
    const sessionId = `session-${sequence}`;
    db.run(
      "UPDATE run SET status='ended' WHERE status='active' AND id IN (SELECT run_id FROM runner_work WHERE ended_at IS NOT NULL)",
    );
    const record = insertQueuedItem(db, { id, now: Date.now(), sessionKey: sessionId });
    const { run } = beginImplementRun(db, id, Date.now());
    recordLinearInstallation(db, {
      organizationId: "fixture-work",
      oauthClientId: "fixture-app",
      appUserId: "app-user",
      sessionId,
      teamId: "fixture-team",
      observedAtMs: Date.now(),
    });
    bindLinearSessionTask(db, sessionId, record.delegationId, { actorId: "owner" });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, id]);
    bindWorkItemRepository(db, id, {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
    });
    return { id, sessionId, runId: run.id };
  }
  function input(record: ReturnType<typeof item>, extra: Partial<RunAgentOptions> = {}) {
    return {
      profile: { agent: "codex" as const, model: "model" },
      role: "implementer" as const,
      itemId: `display-${record.id}`,
      runId: record.runId,
      prompt: "Implement fixture",
      worktreePath: paws,
      pawsRoot: dir,
      networkGit: git,
      ...extra,
    } satisfies RunAgentOptions;
  }
  return {
    dir,
    db,
    work,
    results,
    transcripts,
    backend,
    runnerId,
    runner,
    paws,
    next,
    item,
    input,
  };
}

test("a fake runner handover leaves its WIP commit and full transcript with Paws and keeps the open question", async () => {
  const f = await fixture();
  const record = f.item();
  const running = f.backend.forItem(record.id)(
    f.input(record, {
      askTeam: {
        async ask(request) {
          applyWorkItemEvent(f.db, record.id, "blocking_question");
          openQuestion(f.db, {
            itemId: record.id,
            runId: record.runId,
            sessionId: record.sessionId,
            body: request.question,
          });
          return { answer: "Question posted to the team. End your turn now." };
        },
      },
    }),
  );
  const assigned = await f.next();
  if (assigned.type !== "run") throw new Error("Expected a run command");
  const grant = f.work.issueGrant({
    runnerId: f.runnerId,
    runId: assigned.runId,
    commandId: assigned.id,
    generation: assigned.generation,
  });
  // The agent asks the team, and the runner hands over while the question waits.
  f.work.event({
    runnerId: f.runnerId,
    runId: assigned.runId,
    generation: assigned.generation,
    token: grant.token,
    sequence: 1,
    event: { type: "question", text: "Include archived rows?", options: [] },
  });
  for (let i = 0; i < 2000 && !findOpenQuestion(f.db, record.sessionId); i++) await delay(2);
  expect(getWorkItem(f.db, record.id)?.state).toBe("awaiting_input");

  const handing = f.backend.handoverItem(record.id);
  const handover = await f.next();
  expect(handover).toMatchObject({
    type: "handover",
    runId: assigned.runId,
    generation: assigned.generation,
  });
  if (handover.type !== "handover") throw new Error("Expected a handover command");
  expect(handover.expiresAt - handover.issuedAt).toBeLessThanOrEqual(120_000);

  writeFileSync(join(f.runner, "partial.txt"), "half done\n");
  await git(["-C", f.runner, "add", "-A"]);
  await git(["-C", f.runner, "commit", "-q", "-m", "wip: handover checkpoint"]);
  const wip = await git(["-C", f.runner, "rev-parse", "HEAD"]);

  const executionId = workspaceId();
  const transcript = Buffer.from(
    [
      { type: "session_update", update: { sessionUpdate: "agent_message_chunk" } },
      { type: "ask_team", question: "Include archived rows?", phase: "asked" },
      { type: "cancelled", reason: "cancel" },
    ]
      .map((event) => `${JSON.stringify({ t: new Date().toISOString(), event })}\n`)
      .join(""),
  );
  const access = { runnerId: f.runnerId, runId: assigned.runId, token: grant.token };
  const sha256 = createHash("sha256").update(transcript).digest("hex");
  await f.transcripts.upload(access, {
    generation: assigned.generation,
    executionId,
    offset: 0,
    sha256,
    data: transcript.toString("base64"),
  });
  await f.transcripts.finish(access, {
    generation: assigned.generation,
    executionId,
    offset: transcript.length,
    sizeBytes: transcript.length,
    sha256,
  });
  f.results.submit({
    runnerId: f.runnerId,
    runId: assigned.runId,
    generation: assigned.generation,
    token: grant.token,
    result: {
      executionId,
      commandId: assigned.id,
      role: "implementer",
      stopReason: "cancelled",
      timedOut: false,
      cancelled: true,
      handedOver: true,
      authRequired: false,
      agentExited: true,
      sessionId: "runner-session",
      candidateSha: wip,
    },
  });

  const finished = await running;
  expect(finished.handedOver).toBe(true);
  expect(finished.cancelled).toBe(true);
  expect(await handing).toEqual({ handedOver: true, runnerId: f.runnerId, wipCommit: wip });

  // The Paws worktree holds the runner's WIP commit, file for file.
  expect(await git(["-C", f.paws, "rev-parse", "HEAD"])).toBe(wip);
  expect(await git(["-C", f.paws, "rev-parse", "HEAD^{tree}"])).toBe(
    await git(["-C", f.runner, "rev-parse", "HEAD^{tree}"]),
  );
  expect(readFileSync(join(f.paws, "partial.txt"), "utf8")).toBe("half done\n");
  expect(getWorkItem(f.db, record.id)?.checkpoint).toMatchObject({
    phase: "awaiting_input",
    wipCommit: wip,
  });
  const local = readFileSync(join(runDir(f.dir, record.runId), "acp.jsonl"));
  expect(local.includes(transcript)).toBe(true);
  // The question stays open for whoever continues the session.
  expect(findOpenQuestion(f.db, record.sessionId)?.body).toBe("Include archived rows?");
  expect(getWorkItem(f.db, record.id)?.state).toBe("awaiting_input");
  expect(
    f.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM runner_command WHERE run_id=? AND kind='cancel'",
      )
      .get(record.runId)?.n,
  ).toBe(0);
}, 20_000);

test("a handover that does not finish in time is reported and the session stays on the runner", async () => {
  const f = await fixture();
  const record = f.item();
  const running = f.backend.forItem(record.id)(f.input(record));
  void running.catch(() => undefined);
  const assigned = await f.next();
  if (assigned.type !== "run") throw new Error("Expected a run command");
  const outcome = await f.backend.handoverItem(record.id);
  expect(outcome).toMatchObject({ handedOver: false, runnerId: f.runnerId });
  expect(outcome.handedOver ? "" : outcome.reason).toContain("stays on the runner");
  expect(
    f.db
      .query<{ endedAt: number | null }, [string]>(
        "SELECT ended_at AS endedAt FROM runner_work WHERE run_id=?",
      )
      .get(record.runId)?.endedAt,
  ).toBeNull();
  // The run still finishes normally on the same runner afterwards.
  const grant = f.work.issueGrant({
    runnerId: f.runnerId,
    runId: assigned.runId,
    commandId: assigned.id,
    generation: assigned.generation,
  });
  f.results.submit({
    runnerId: f.runnerId,
    runId: assigned.runId,
    generation: assigned.generation,
    token: grant.token,
    result: {
      executionId: workspaceId(),
      commandId: assigned.id,
      role: "implementer",
      stopReason: "error",
      errorMessage: "fixture ended",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
    },
  });
  await running.catch(() => undefined);
}, 20_000);
