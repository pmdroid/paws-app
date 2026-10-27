import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentSessions, createFakeAgentSessionObjects } from "../src/agent-sessions";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getWorkItem,
  insertQueuedItem,
  listRunnerOverview,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import { createRunnerControl, createRunnerSessionMoves } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import { verifyRunnerCommand, type RunnerCommand, type RunnerEvent } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";

type RunCommand = Extract<RunnerCommand, { type: "run" }>;
type Setup = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "paws-handover-resume-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = Date.now();
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
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "fixture-team",
  ]);
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now: () => now,
  });
  const runners: Record<"a" | "b", string> = { a: "", b: "" };
  for (const name of ["a", "b"] as const) {
    const key = await createRunnerKey(join(root, `client-${name}`));
    const pending = { name: name.toUpperCase(), csr: key.csr };
    runners[name] = (
      await control.enroll({
        ...pending,
        token: control.createEnrollment(principal, pending).token,
      })
    ).runnerId;
  }
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: signing.privateKey,
    now: () => now,
  });
  const results = createRunnerResults({ db, work, now: () => now });
  const health = createRunnerHealth({ db, work, now: () => now });
  const sessions = createAgentSessions({
    db,
    work,
    objects: createFakeAgentSessionObjects(),
    key: randomBytes(32),
    now: () => now,
  });
  const git = (args: string[]) => {
    const child = Bun.spawnSync(["/usr/bin/git", ...args], {
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
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  // Paws' worktree of the item, and runner A's checkout of the same repository.
  const paws = join(root, "paws-worktree");
  git(["init", "-q", "-b", "main", paws]);
  writeFileSync(join(paws, "result.txt"), "base");
  git(["-C", paws, "add", "."]);
  git(["-C", paws, "commit", "-q", "-m", "Base"]);
  const base = git(["-C", paws, "rev-parse", "HEAD"]);
  const checkout = join(root, "runner-a");
  git(["clone", "-q", paws, checkout]);
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    now: () => now,
    pollIntervalMs: 1,
    placement: createRunnerPlacement({ db, now: () => now }),
    async fetchCandidate(candidate) {
      git(["-C", candidate.worktree, "fetch", "-q", checkout, candidate.candidateSha]);
      git(["-C", candidate.worktree, "reset", "-q", "--hard", candidate.candidateSha]);
    },
  });
  const seen = new Set<string>();
  /** The next command for `runnerId`, or null once `attempts` polls found none. */
  async function next(runnerId: string, attempts = 5000) {
    for (let index = 0; index < attempts; index++) {
      for (const envelope of work.commands(runnerId)) {
        const verified = verifyRunnerCommand(envelope, {
          trustedKeys: new Map([["fixture", signing.publicKey]]),
          runnerId,
          workspaceId: workspace.id,
          now,
          allowedRepositories: ["fixture/repository"],
          claimCommand: (id) => !seen.has(id) && Boolean(seen.add(id)),
        });
        if (verified.ok) {
          work.acknowledge(runnerId, verified.command.id);
          return verified.command;
        }
      }
      await delay(1);
    }
    return null;
  }
  const grant = (command: RunCommand, runnerId: string) =>
    work.issueGrant({
      runnerId,
      runId: command.runId,
      commandId: command.id,
      generation: command.generation,
    }).token;
  function events(command: RunCommand, runnerId: string, list: RunnerEvent[]) {
    const token = grant(command, runnerId);
    const after =
      db
        .query<{ sequence: number }, [string, number]>(
          "SELECT last_sequence AS sequence FROM runner_work WHERE run_id=? AND generation=?",
        )
        .get(command.runId, command.generation)?.sequence ?? 0;
    list.forEach((event, index) =>
      work.event({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        sequence: after + index + 1,
        token,
        event,
      }),
    );
  }
  function submit(
    command: RunCommand,
    runnerId: string,
    extra: { handedOver?: true; candidateSha?: string },
  ) {
    results.submit({
      runnerId,
      runId: command.runId,
      generation: command.generation,
      token: grant(command, runnerId),
      result: {
        executionId: workspaceId(),
        commandId: command.id,
        role: "implementer",
        stopReason: extra.handedOver ? "cancelled" : "end_turn",
        timedOut: false,
        cancelled: false,
        authRequired: false,
        agentExited: true,
        sessionId: "claude-session",
        identity: { session: "claude-session", model: "model", provider: "anthropic" },
        ...extra,
      },
    });
  }
  /**
   * Runner A commits its worktree, seals the session at that commit and ends handed over. With
   * `handover`, A already took the handover command.
   */
  async function handOver(command: RunCommand, handover?: RunnerCommand | null) {
    handover ??= await next(runners.a);
    expect(handover).toMatchObject({ type: "handover", runId: command.runId });
    writeFileSync(join(checkout, "result.txt"), `half done in ${command.runId}`);
    git(["-C", checkout, "commit", "-q", "-am", "Save work in progress"]);
    const wip = git(["-C", checkout, "rev-parse", "HEAD"]);
    const access = { runnerId: runners.a, runId: command.runId, token: grant(command, runners.a) };
    const bundle = randomBytes(10_000);
    await sessions.upload(access, {
      generation: command.generation,
      offset: 0,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      data: bundle.toString("base64"),
    });
    await sessions.finish(access, {
      generation: command.generation,
      sizeBytes: bundle.length,
      sha256: createHash("sha256").update(bundle).digest("hex"),
      agent: "claude",
      agentVersion: "2.1.7",
      sessionId: "claude-session",
      workspacePath: `/var/lib/paws-agent/work/${command.runId}`,
      commitSha: wip,
      turn: command.generation,
    });
    events(command, runners.a, [{ type: "handover", handedOver: true }]);
    submit(command, runners.a, { handedOver: true, candidateSha: wip });
    return wip;
  }
  // A handed-over run waits for a runner until it stops, so every test stops its runs.
  const stops = new Set<AbortController>();
  let sequence = 0;
  /**
   * Both runners active, online and signed in to Claude; only A is free until `start` places.
   * With `alongside`, the runs already active keep running.
   */
  function item(alongside = false) {
    if (!alongside) {
      git(["-C", paws, "reset", "-q", "--hard", base]);
      git(["-C", checkout, "reset", "-q", "--hard", base]);
      db.run("UPDATE run SET status='ended' WHERE status='active'");
      db.run("DELETE FROM runner_capacity");
    }
    for (const runnerId of Object.values(runners)) {
      db.run("UPDATE runner SET status='active',owner_user_id=? WHERE id=?", [userId, runnerId]);
      work.heartbeat(runnerId);
      db.run(
        `INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,'0.1.44',?)
         ON CONFLICT(runner_id) DO UPDATE SET runner_version=excluded.runner_version`,
        [runnerId, now],
      );
      db.run("DELETE FROM runner_agent_policy WHERE runner_id=?", [runnerId]);
      db.run(
        "INSERT INTO runner_agent_policy(runner_id,agent,ready,auth_expired) VALUES(?,'claude',1,0)",
        [runnerId],
      );
      db.run("DELETE FROM runner_agent WHERE runner_id=?", [runnerId]);
      db.run(
        "INSERT INTO runner_agent(runner_id,agent,version,status,reported_at) VALUES(?,'claude','2.1.7','current',?)",
        [runnerId, now],
      );
    }
    const id = `item-${++sequence}`;
    const sessionKey = `session-${sequence}`;
    const record = insertQueuedItem(db, { id, now, sessionKey });
    const { run } = beginImplementRun(db, id, now);
    recordLinearInstallation(db, {
      organizationId: "fixture-work",
      oauthClientId: "fixture-app",
      appUserId: "app-user",
      sessionId: sessionKey,
      teamId: "fixture-team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, sessionKey, record.delegationId, { actorId: "owner" });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, id]);
    bindWorkItemRepository(db, id, {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
    });
    return { id, runId: run.id };
  }
  /** One turn of `record`, which runs until a runner finishes it or `stop` aborts it. */
  function turn(
    record: { id: string; runId: string },
    notices: string[],
    question?: "answered" | "open",
  ) {
    const stop = new AbortController();
    stops.add(stop);
    const running = backend
      .forItem(record.id)({
        profile: { agent: "claude", model: "model" },
        role: "implementer",
        itemId: `display-${record.id}`,
        runId: record.runId,
        prompt: "Implement fixture",
        worktreePath: paws,
        pawsRoot: root,
        networkGit: async () => "",
        signal: stop.signal,
        ...(question
          ? {
              askTeam: {
                // The question store records the question, answered or still open.
                async ask(request: { question: string }) {
                  db.run(
                    `INSERT INTO question(id,item_id,run_id,session_id,kind,body,status,created_at)
                     VALUES(?,?,?,?,'agent',?,?,?)`,
                    [
                      workspaceId(),
                      record.id,
                      record.runId,
                      `session-${record.id}`,
                      request.question,
                      question,
                      now,
                    ],
                  );
                  return { answer: "Use the default." };
                },
              },
            }
          : {}),
        onEvent(event) {
          if (event.type === "progress") notices.push(event.text);
        },
      })
      .catch((error: unknown) => error);
    return { running, stop };
  }
  /**
   * Starts a turn on A, which says something and is then handed over. `B` is paused until the
   * turn lands on A, then `whileMoving` sets it up before Paws looks for another runner. With
   * `question`, A asks first and the question is answered or still open at the handover.
   */
  async function handOverTurn(whileMoving: () => void = () => {}, question?: "answered" | "open") {
    const record = item();
    const notices: string[] = [];
    const prompts: string[] = [];
    db.run("UPDATE runner SET status='paused' WHERE id=?", [runners.b]);
    const { running, stop } = turn(record, notices, question);
    const onA = (await next(runners.a)) as RunCommand;
    prompts.push(onA.prompt);
    db.run("UPDATE runner SET status='active' WHERE id=?", [runners.b]);
    whileMoving();
    events(onA, runners.a, [
      ...(question ? [{ type: "question" as const, text: "Which delimiter?", options: [] }] : []),
      {
        type: "activity",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The parser handles headers; rows are next." },
        },
      },
    ]);
    if (question)
      for (
        let index = 0;
        index < 5000 && !db.query("SELECT 1 FROM question WHERE run_id=?").get(record.runId);
        index++
      )
        await delay(1);
    const handing = backend.handOverItem(record.id);
    const wip = await handOver(onA);
    expect(await handing).toEqual({ status: "handed_over", wipCommit: wip });
    return { record, onA, wip, notices, prompts, running, stop };
  }
  return {
    db,
    now,
    paws,
    git,
    runners,
    backend,
    principal,
    workspaceId: workspace.id,
    item,
    handOver,
    next,
    events,
    submit,
    handOverTurn,
    turn,
    stopAll() {
      for (const stop of stops) stop.abort();
      stops.clear();
    },
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let context: Setup;
beforeAll(async () => {
  context = await setup();
});
afterEach(() => context.stopAll());
afterAll(() => {
  context.stopAll();
  context.cleanup();
});

test("a handed-over session continues on the second runner from its WIP commit, with its conversation", async () => {
  const { runners } = context;
  const { record, onA, wip, notices, running } = await context.handOverTurn();
  const onB = (await context.next(runners.b)) as RunCommand;
  // Same run, next generation, from the WIP commit, restoring the session A sealed there.
  expect(onB.runId).toBe(onA.runId);
  expect(onB.generation).toBe(onA.generation + 1);
  expect(onB.repository.baseSha).toBe(wip);
  expect(onB.restoreSession).toMatchObject({
    generation: onA.generation,
    sessionId: "claude-session",
  });
  expect(onB.resumeSessionId).toBe("claude-session");
  expect(onB.prompt).toContain("Implement fixture");
  expect(onB.prompt).toContain("The parser handles headers; rows are next.");
  expect(onB.prompt).toContain("Paws moved this session to another runner");
  context.events(onB, runners.b, [{ type: "session_restore", restored: true }]);
  context.submit(onB, runners.b, { candidateSha: wip });
  const result = await running;
  expect(result).toMatchObject({ stopReason: "end_turn", candidateSha: wip });
  expect(getWorkItem(context.db, record.id)?.checkpoint?.wipCommit).toBe(wip);
  expect(notices.filter((notice) => notice.startsWith("Moved"))).toEqual([
    `Moved from A to B. Continuing the agent's session from turn ${onA.generation}.\n`,
  ]);
  expect(notices.some((notice) => notice.startsWith("Waiting"))).toBe(false);
});

test("with no eligible runner the session waits, says why once, and moves when one fits", async () => {
  const { db, runners } = context;
  const { onA, wip, notices, running } = await context.handOverTurn(() =>
    db.run("UPDATE runner_agent_policy SET ready=0 WHERE runner_id=?", [runners.b]),
  );
  // Neither runner gets the work while B is signed out, and the run does not fail.
  expect(await context.next(runners.b, 300)).toBeNull();
  expect(await context.next(runners.a, 10)).toBeNull();
  expect(notices.filter((notice) => notice.startsWith("Waiting"))).toEqual([
    "Waiting to move this session from A: Sign in to Claude on another runner. Paws moves it as soon as a runner fits.\n",
  ]);
  expect(await Promise.race([running, delay(1, "waiting")])).toBe("waiting");
  db.run("UPDATE runner_agent_policy SET ready=1 WHERE runner_id=?", [runners.b]);
  const onB = (await context.next(runners.b)) as RunCommand;
  expect(onB.runId).toBe(onA.runId);
  expect(onB.repository.baseSha).toBe(wip);
  context.submit(onB, runners.b, { candidateSha: wip });
  expect(await running).toMatchObject({ stopReason: "end_turn", candidateSha: wip });
  expect(notices.filter((notice) => notice.startsWith("Waiting"))).toHaveLength(1);
});

test("a run that stops while it waits for a runner ends with the stop, not a failure", async () => {
  const { db, runners } = context;
  const { running, stop, notices } = await context.handOverTurn(() =>
    db.run("UPDATE runner SET status='paused' WHERE id=?", [runners.b]),
  );
  for (
    let index = 0;
    index < 5000 && !notices.some((notice) => notice.startsWith("Waiting"));
    index++
  )
    await delay(1);
  expect(notices.filter((notice) => notice.startsWith("Waiting"))).toEqual([
    "Waiting to move this session from A: No other runner is online. Paws moves it as soon as a runner fits.\n",
  ]);
  stop.abort();
  const error = await running;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("AbortError");
});

test("a session whose question was answered still moves to another runner", async () => {
  const { runners } = context;
  const { onA, wip, running } = await context.handOverTurn(undefined, "answered");
  const onB = (await context.next(runners.b)) as RunCommand;
  expect(onB.runId).toBe(onA.runId);
  expect(onB.repository.baseSha).toBe(wip);
  context.submit(onB, runners.b, { candidateSha: wip });
  expect(await running).toMatchObject({ stopReason: "end_turn", candidateSha: wip });
});

test("a session still waiting on its question keeps it and does not move", async () => {
  const { runners } = context;
  const { running } = await context.handOverTurn(undefined, "open");
  expect(await running).toMatchObject({ handedOver: true });
  expect(await context.next(runners.b, 50)).toBeNull();
});

test("after a restart the handed-over run still avoids the runner it left and waits", async () => {
  const { db, runners } = context;
  const { record, onA, wip, notices, stop, running } = await context.handOverTurn(() =>
    db.run("UPDATE runner SET status='paused' WHERE id=?", [runners.b]),
  );
  for (
    let index = 0;
    index < 5000 && !notices.some((notice) => notice.startsWith("Waiting"));
    index++
  )
    await delay(1);
  // Paws stops while the run waits; a new call knows nothing of the first one.
  stop.abort();
  await running;
  const again: string[] = [];
  const resumed = context.turn(record, again);
  // A is active and online, yet the run neither returns to it nor fails.
  expect(await context.next(runners.a, 300)).toBeNull();
  for (let index = 0; index < 5000 && !again.length; index++) await delay(1);
  expect(again.filter((notice) => notice.startsWith("Waiting"))).toEqual([
    "Waiting to move this session from A: No other runner is online. Paws moves it as soon as a runner fits.\n",
  ]);
  db.run("UPDATE runner SET status='active' WHERE id=?", [runners.b]);
  const onB = (await context.next(runners.b)) as RunCommand;
  expect(onB.runId).toBe(onA.runId);
  expect(onB.repository.baseSha).toBe(wip);
  context.submit(onB, runners.b, { candidateSha: wip });
  expect(await resumed.running).toMatchObject({ stopReason: "end_turn", candidateSha: wip });
});

/** Move to another runner on `runnerId`'s card, as the dashboard posts it. */
function moveRequest(runnerId: string, runId: string) {
  return new Request(`https://paws.test/api/runners/${runnerId}/sessions/${runId}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/** The sessions `runnerId`'s card lists. */
function card(runnerId: string) {
  return (
    listRunnerOverview(context.db, context.workspaceId, context.now).find(
      (runner) => runner.id === runnerId,
    )?.running ?? []
  );
}

/** A turn running on A, with B paused until it lands there. */
async function runningOnA(notices: string[] = []) {
  const { db, runners } = context;
  const record = context.item();
  db.run("UPDATE runner SET status='paused' WHERE id=?", [runners.b]);
  const { running } = context.turn(record, notices);
  const onA = (await context.next(runners.a)) as RunCommand;
  db.run("UPDATE runner SET status='active' WHERE id=?", [runners.b]);
  return { record, running, onA };
}

/** A ends the turn at the base commit, so the next test starts with A free. */
async function finish(onA: RunCommand, running: Promise<unknown>) {
  const base = context.git(["-C", context.paws, "rev-parse", "HEAD"]);
  context.submit(onA, context.runners.a, { candidateSha: base });
  expect(await running).toMatchObject({ stopReason: "end_turn", candidateSha: base });
}

/** The move route over the fixture's backend; every request here is its route. */
function sessionMoves() {
  const moves = createRunnerSessionMoves({
    db: context.db,
    handOver: (itemId, signal) => context.backend.handOverItem(itemId, signal),
    now: () => context.now,
  });
  return {
    settled: moves.settled,
    async fetch(...args: Parameters<typeof moves.fetch>) {
      const response = await moves.fetch(...args);
      if (!response) throw new Error("The move route did not answer.");
      return response;
    },
  };
}

test("an owner moves a session from its runner card, and it continues on the second runner", async () => {
  const { runners } = context;
  const moves = sessionMoves();
  const { record, running, onA } = await runningOnA();
  expect(card(runners.a)).toMatchObject([{ runId: record.runId, movable: true, move: null }]);

  const response = await moves.fetch(moveRequest(runners.a, record.runId), context.principal);
  expect(response.status).toBe(202);
  expect(card(runners.a)[0]?.move).toEqual({ status: "moving", reason: null });
  // Asking twice while it moves does not ask the runner again.
  expect((await moves.fetch(moveRequest(runners.a, record.runId), context.principal)).status).toBe(
    202,
  );

  const wip = await context.handOver(onA);
  const onB = (await context.next(runners.b)) as RunCommand;
  await moves.settled();
  expect(onB.runId).toBe(onA.runId);
  expect(onB.repository.baseSha).toBe(wip);
  expect(onB.prompt).toContain("Paws moved this session to another runner");
  // It left A's card and shows on B's, with no move pending.
  expect(card(runners.a)).toEqual([]);
  expect(card(runners.b)).toMatchObject([{ runId: record.runId, movable: true, move: null }]);
  expect(await context.next(runners.a, 10)).toBeNull();

  context.submit(onB, runners.b, { candidateSha: wip });
  expect(await running).toMatchObject({ stopReason: "end_turn", candidateSha: wip });
});

test("with no eligible runner the card row says why, as Linear hears it", async () => {
  const { db, runners } = context;
  const moves = sessionMoves();
  const notices: string[] = [];
  const { record, onA } = await runningOnA(notices);
  db.run("UPDATE runner_agent_policy SET ready=0 WHERE runner_id=?", [runners.b]);
  expect((await moves.fetch(moveRequest(runners.a, record.runId), context.principal)).status).toBe(
    202,
  );
  await context.handOver(onA);
  await moves.settled();
  for (let index = 0; index < 5000 && !notices.some((n) => n.startsWith("Waiting")); index++)
    await delay(1);
  expect(notices).toContain(
    "Waiting to move this session from A: Sign in to Claude on another runner. Paws moves it as soon as a runner fits.\n",
  );
  expect(card(runners.a)).toMatchObject([
    {
      runId: record.runId,
      movable: false,
      move: { status: "waiting", reason: "Sign in to Claude on another runner." },
    },
  ]);
});

test("a member's or observer's move request is refused and the runner is not asked", async () => {
  const { db, runners } = context;
  const moves = sessionMoves();
  const { record, running, onA } = await runningOnA();
  for (const role of ["member", "observer"] as const) {
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: `${role}-${record.id}`,
      name: role,
      email: `${role}-${record.id}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: context.workspaceId,
      userId,
      role,
      active: true,
      teamIds: [],
      now: context.now,
    });
    const response = await moves.fetch(moveRequest(runners.a, record.runId), {
      ...context.principal,
      userId,
      role,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Only workspace owners and admins can move running work.",
    });
  }
  await moves.settled();
  expect(card(runners.a)).toMatchObject([{ runId: record.runId, movable: true, move: null }]);
  expect(await context.next(runners.a, 50)).toBeNull();
  await finish(onA, running);
});

test("a session that is not running on that runner is not moved", async () => {
  const { runners } = context;
  const moves = sessionMoves();
  const { record, running, onA } = await runningOnA();
  const response = await moves.fetch(moveRequest(runners.b, record.runId), context.principal);
  expect(response.status).toBe(409);
  expect(card(runners.a)[0]?.move).toBeNull();
  expect(await context.next(runners.a, 50)).toBeNull();
  await finish(onA, running);
});

/** Move running work on `runnerId`'s card, as the dashboard posts it. */
function moveAllRequest(runnerId: string) {
  return new Request(`https://paws.test/api/runners/${runnerId}/sessions/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/** Two turns running on A, with B paused until both landed there. */
async function twoRunningOnA(notices: string[] = []) {
  const { db, runners } = context;
  const turns = [];
  for (const alongside of [false, true]) {
    const record = context.item(alongside);
    // Each runner has two slots, so both sessions fit on A and then on B.
    for (const runnerId of Object.values(runners))
      db.run("INSERT OR REPLACE INTO runner_capacity(runner_id,capacity) VALUES(?,2)", [runnerId]);
    db.run("UPDATE runner SET status='paused' WHERE id=?", [runners.b]);
    const { running } = context.turn(record, notices);
    turns.push({ record, running, onA: (await context.next(runners.a)) as RunCommand });
  }
  return turns;
}

/** A takes both handover commands, in whichever order Paws sent them, and hands both over. */
async function handOverBoth(turns: { onA: RunCommand }[]) {
  const handovers = [await context.next(context.runners.a), await context.next(context.runners.a)];
  const wips: string[] = [];
  for (const { onA } of turns)
    wips.push(
      await context.handOver(
        onA,
        handovers.find((command) => command && "runId" in command && command.runId === onA.runId),
      ),
    );
  return wips;
}

test("Move running work on a draining runner moves both sessions to the second runner, and A is drained", async () => {
  const { db, runners } = context;
  const moves = sessionMoves();
  const turns = await twoRunningOnA();
  db.run("UPDATE runner SET status='draining' WHERE id=?", [runners.a]);
  db.run("UPDATE runner SET status='active' WHERE id=?", [runners.b]);
  expect(card(runners.a)).toHaveLength(2);

  const response = await moves.fetch(moveAllRequest(runners.a), context.principal);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true, moving: 2 });
  // One move per session, each through the same path as Move to another runner.
  expect(card(runners.a).map((session) => session.move)).toEqual([
    { status: "moving", reason: null },
    { status: "moving", reason: null },
  ]);
  // Asking again while they move asks the runner for nothing more.
  expect(await (await moves.fetch(moveAllRequest(runners.a), context.principal)).json()).toEqual({
    ok: true,
    moving: 0,
  });

  const wips = await handOverBoth(turns);
  const landed = [
    (await context.next(runners.b)) as RunCommand,
    (await context.next(runners.b)) as RunCommand,
  ];
  await moves.settled();
  const runIds = turns.map(({ onA }) => onA.runId).sort();
  expect(landed.map((command) => command.runId).sort()).toEqual(runIds);
  // Both left A's card, so it is drained, and B lists both with no move pending.
  expect(card(runners.a)).toEqual([]);
  expect(
    card(runners.b)
      .map(({ runId, movable, move }) => ({ runId, movable, move }))
      .sort((left, right) => left.runId.localeCompare(right.runId)),
  ).toEqual(runIds.map((runId) => ({ runId, movable: true, move: null })));
  const overview = listRunnerOverview(db, context.workspaceId, context.now);
  expect(overview.find((runner) => runner.id === runners.a)).toMatchObject({
    status: "draining",
    slots: { used: 0 },
    running: [],
  });
  expect(await context.next(runners.a, 10)).toBeNull();

  // B finishes both turns from their WIP commits.
  for (const [index, { onA, running }] of turns.entries()) {
    const onB = landed.find((command) => command.runId === onA.runId)!;
    context.submit(onB, runners.b, { candidateSha: wips[index]! });
    expect(await running).toMatchObject({ stopReason: "end_turn" });
  }
});

test("with no eligible runner both sessions stay on the draining card with the reason", async () => {
  const { db, runners } = context;
  const moves = sessionMoves();
  const notices: string[] = [];
  const turns = await twoRunningOnA(notices);
  db.run("UPDATE runner SET status='draining' WHERE id=?", [runners.a]);
  db.run("UPDATE runner SET status='active' WHERE id=?", [runners.b]);
  db.run("UPDATE runner_agent_policy SET ready=0 WHERE runner_id=?", [runners.b]);
  expect((await moves.fetch(moveAllRequest(runners.a), context.principal)).status).toBe(202);
  await handOverBoth(turns);
  await moves.settled();
  for (
    let index = 0;
    index < 5000 && notices.filter((n) => n.startsWith("Waiting")).length < 2;
    index++
  )
    await delay(1);
  // Both stay listed with the reason, so the card counts two waiting instead of Drained.
  expect(
    card(runners.a)
      .map(({ runId, movable, move }) => ({ runId, movable, move }))
      .sort((left, right) => left.runId.localeCompare(right.runId)),
  ).toEqual(
    turns
      .map(({ record }) => record.runId)
      .sort()
      .map((runId) => ({
        runId,
        movable: false,
        move: { status: "waiting", reason: "Sign in to Claude on another runner." },
      })),
  );
  expect(await context.next(runners.b, 10)).toBeNull();
});

test("Move running work needs a draining runner and an owner or admin", async () => {
  const { db, runners } = context;
  const moves = sessionMoves();
  const { record, running, onA } = await runningOnA();
  const refused = await moves.fetch(moveAllRequest(runners.a), context.principal);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: "Drain this runner before moving all of its running work.",
  });
  db.run("UPDATE runner SET status='draining' WHERE id=?", [runners.a]);
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: `observer-all-${record.id}`,
    name: "observer",
    email: `observer-all-${record.id}@example.invalid`,
  });
  syncWorkspaceMember(db, {
    workspaceId: context.workspaceId,
    userId,
    role: "observer",
    active: true,
    teamIds: [],
    now: context.now,
  });
  const observer = await moves.fetch(moveAllRequest(runners.a), {
    ...context.principal,
    userId,
    role: "observer",
  });
  expect(observer.status).toBe(403);
  await moves.settled();
  expect(card(runners.a)).toMatchObject([{ runId: record.runId, move: null }]);
  expect(await context.next(runners.a, 50)).toBeNull();
  db.run("UPDATE runner SET status='active' WHERE id=?", [runners.a]);
  await finish(onA, running);
});
