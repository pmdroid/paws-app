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
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
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
  /** Runner A commits its worktree, seals the session at that commit and ends handed over. */
  async function handOver(command: RunCommand) {
    const handover = await next(runners.a);
    expect(handover).toMatchObject({ type: "handover", runId: command.runId });
    writeFileSync(join(checkout, "result.txt"), "half done");
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
  /** Both runners active, online and signed in to Claude; only A is free until `start` places. */
  function item() {
    git(["-C", paws, "reset", "-q", "--hard", base]);
    git(["-C", checkout, "reset", "-q", "--hard", base]);
    db.run("UPDATE run SET status='ended' WHERE status='active'");
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
  /**
   * Starts a turn on A, which says something and is then handed over. `B` is paused until the
   * turn lands on A, then `whileMoving` sets it up before Paws looks for another runner.
   */
  async function handOverTurn(whileMoving: () => void = () => {}) {
    const record = item();
    const notices: string[] = [];
    const prompts: string[] = [];
    db.run("UPDATE runner SET status='paused' WHERE id=?", [runners.b]);
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
        onEvent(event) {
          if (event.type === "progress") notices.push(event.text);
        },
      })
      .catch((error: unknown) => error);
    const onA = (await next(runners.a)) as RunCommand;
    prompts.push(onA.prompt);
    db.run("UPDATE runner SET status='active' WHERE id=?", [runners.b]);
    whileMoving();
    events(onA, runners.a, [
      {
        type: "activity",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The parser handles headers; rows are next." },
        },
      },
    ]);
    const handing = backend.handOverItem(record.id);
    const wip = await handOver(onA);
    expect(await handing).toEqual({ status: "handed_over", wipCommit: wip });
    return { record, onA, wip, notices, prompts, running, stop };
  }
  return {
    db,
    paws,
    git,
    runners,
    next,
    events,
    submit,
    handOverTurn,
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
