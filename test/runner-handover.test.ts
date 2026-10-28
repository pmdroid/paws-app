import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AskTeamContext } from "../src/acp";
import { createAgentSessions, createFakeAgentSessionObjects } from "../src/agent-sessions";
import {
  accrueAwake,
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getWorkItem,
  insertQueuedItem,
  saveCheckpoint,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import {
  verifyRunnerCommand,
  type RunnerCommand,
  type RunnerEvent,
  type RunnerResult,
} from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";

type RunCommand = Extract<RunnerCommand, { type: "run" }>;
type Setup = Awaited<ReturnType<typeof setup>>;

const gitEnv = (home: string) => ({
  PATH: "/usr/bin:/bin",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "paws-handover-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = () => Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "fixture-work", now());
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-work",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now: now(),
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
    workspace.id,
    "fixture/repository",
    "fixture-team",
  ]);
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
    now,
  });
  const key = await createRunnerKey(join(root, "client"));
  const pending = { name: "A", csr: key.csr };
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now(),
    teamIds: [],
  };
  const runnerId = (
    await control.enroll({ ...pending, token: control.createEnrollment(principal, pending).token })
  ).runnerId;
  db.run("UPDATE runner SET status='active',owner_user_id=? WHERE id=?", [userId, runnerId]);
  const release = (version: string) =>
    db.run(
      `INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?)
       ON CONFLICT(runner_id) DO UPDATE SET runner_version=excluded.runner_version`,
      [runnerId, version, now()],
    );
  release("0.1.44");
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({ db, keyId: "fixture", privateKey: signing.privateKey, now });
  const results = createRunnerResults({ db, work, now });
  const health = createRunnerHealth({ db, work, now });
  const sessions = createAgentSessions({
    db,
    work,
    objects: createFakeAgentSessionObjects(),
    key: randomBytes(32),
    now,
  });
  const git = (args: string[]) => {
    const child = Bun.spawnSync(["/usr/bin/git", ...args], { env: gitEnv(root) });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  // Paws' worktree of the item, and the runner's checkout of the same repository.
  const paws = join(root, "paws-worktree");
  git(["init", "-q", "-b", "main", paws]);
  writeFileSync(join(paws, "result.txt"), "base");
  git(["-C", paws, "add", "."]);
  git(["-C", paws, "commit", "-q", "-m", "Base"]);
  const base = git(["-C", paws, "rev-parse", "HEAD"]);
  const runner = join(root, "runner-worktree");
  git(["clone", "-q", paws, runner]);
  const github: { tip: string | null } = { tip: null };
  const fetched: string[] = [];
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    now,
    pollIntervalMs: 1,
    // Through networkGit in production; here Paws fetches the WIP commit from the runner's checkout.
    async fetchCandidate(candidate) {
      fetched.push(candidate.branch);
      git(["-C", candidate.worktree, "fetch", "-q", runner, candidate.candidateSha]);
      git(["-C", candidate.worktree, "reset", "-q", "--hard", candidate.candidateSha]);
    },
    // The item's branch on GitHub: its tip is a commit of the runner's checkout.
    async fetchBranchTip(input) {
      if (!github.tip) return null;
      git(["-C", input.worktree, "fetch", "-q", runner, github.tip]);
      return github.tip;
    },
  });
  const seen = new Set<string>();
  async function next() {
    for (let index = 0; index < 5000; index++) {
      for (const envelope of work.commands(runnerId)) {
        const verified = verifyRunnerCommand(envelope, {
          trustedKeys: new Map([["fixture", signing.publicKey]]),
          runnerId,
          workspaceId: workspace.id,
          now: now(),
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
    throw new Error("No dispatched runner command");
  }
  let sequence = 0;
  function item() {
    git(["-C", paws, "reset", "-q", "--hard", base]);
    git(["-C", runner, "reset", "-q", "--hard", base]);
    git(["-C", runner, "clean", "-qfd"]);
    db.run("UPDATE run SET status='ended' WHERE status='active'");
    github.tip = null;
    fetched.length = 0;
    work.heartbeat(runnerId);
    const id = `item-${++sequence}`;
    const sessionKey = `session-${sequence}`;
    const record = insertQueuedItem(db, { id, now: now(), sessionKey });
    const { run } = beginImplementRun(db, id, now());
    recordLinearInstallation(db, {
      organizationId: "fixture-work",
      oauthClientId: "fixture-app",
      appUserId: "app-user",
      sessionId: sessionKey,
      teamId: "fixture-team",
      observedAtMs: now(),
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
  /** One turn of `item` on the fake runner; `runner` drives the runner's side. */
  async function turn(
    record: { id: string; runId: string },
    drive: (command: RunCommand) => Promise<void>,
    askTeam?: (question: string, context: AskTeamContext) => Promise<{ answer: string }>,
    signal?: AbortSignal,
    /** A turn Paws stops ends as cancelled or with the abort, like the orchestrator sees it. */
    stopped = false,
  ) {
    const notices: string[] = [];
    const running = backend.forItem(record.id)({
      profile: { agent: "claude", model: "model" },
      role: "implementer",
      itemId: `display-${record.id}`,
      runId: record.runId,
      prompt: "Implement fixture",
      worktreePath: paws,
      pawsRoot: root,
      networkGit: async () => "",
      ...(signal ? { signal } : {}),
      ...(askTeam
        ? { askTeam: { ask: (request, context) => askTeam(request.question, context) } }
        : {}),
      onEvent(event) {
        if (event.type === "progress") notices.push(event.text);
      },
    });
    const settled =
      signal && stopped
        ? running.catch((error: unknown) => {
            if (!signal.aborted) throw error;
            return null;
          })
        : running;
    const command = (await next()) as RunCommand;
    await drive(command);
    return { result: (await settled)!, notices, command };
  }
  function grant(command: RunCommand) {
    return work.issueGrant({
      runnerId,
      runId: command.runId,
      commandId: command.id,
      generation: command.generation,
    }).token;
  }
  function events(command: RunCommand, list: RunnerEvent[]) {
    const token = grant(command);
    const after = db
      .query<{ sequence: number }, [string]>(
        "SELECT last_sequence AS sequence FROM runner_work WHERE run_id=?",
      )
      .get(command.runId)!.sequence;
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
    extra: Partial<
      Pick<
        RunnerResult,
        | "handedOver"
        | "candidateSha"
        | "handoverFailure"
        | "stopReason"
        | "errorMessage"
        | "pushFailure"
      >
    >,
  ) {
    results.submit({
      runnerId,
      runId: command.runId,
      generation: command.generation,
      token: grant(command),
      result: {
        executionId: workspaceId(),
        commandId: command.id,
        role: "implementer",
        stopReason: extra.handedOver || extra.handoverFailure ? "cancelled" : "end_turn",
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
  /** What the runner does on a handover: commit the worktree, seal the session, end handedOver. */
  async function handOver(command: RunCommand) {
    const handover = await next();
    expect(handover).toMatchObject({
      type: "handover",
      runId: command.runId,
      generation: command.generation,
    });
    writeFileSync(join(runner, "result.txt"), "half done");
    writeFileSync(join(runner, "notes.txt"), "next: finish the parser");
    git(["-C", runner, "add", "-A"]);
    git(["-C", runner, "commit", "-q", "-m", "Save work in progress"]);
    const wip = git(["-C", runner, "rev-parse", "HEAD"]);
    const access = { runnerId, runId: command.runId, token: grant(command) };
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
    // The runner commits to the handover before it publishes the result.
    events(command, [{ type: "handover", handedOver: true }]);
    submit(command, { handedOver: true, candidateSha: wip });
    return wip;
  }
  return {
    root,
    db,
    git,
    paws,
    runner,
    base,
    sessions,
    backend,
    item,
    turn,
    events,
    submit,
    handOver,
    next,
    release,
    work,
    github,
    fetched,
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
afterAll(() => context.cleanup());

test("a fake runner handover leaves its WIP commit on the Paws side as the checkpoint, with its session", async () => {
  const { git, paws, runner } = context;
  const record = context.item();
  let wip = "";
  let outcome: unknown;
  const stop = new AbortController();
  const turn = context.turn(
    record,
    async (command) => {
      try {
        const handing = context.backend.handOverItem(record.id);
        wip = await context.handOver(command);
        outcome = await handing;
      } finally {
        // A is the only runner, so the session waits for another one until the run stops.
        stop.abort();
      }
    },
    undefined,
    stop.signal,
  );
  await expect(turn).rejects.toThrow();
  expect(outcome).toEqual({ status: "handed_over", wipCommit: wip });
  // Paws' worktree holds the runner's worktree exactly.
  expect(git(["-C", paws, "rev-parse", "HEAD"])).toBe(wip);
  expect(git(["-C", paws, "rev-parse", "HEAD^{tree}"])).toBe(
    git(["-C", runner, "rev-parse", "HEAD^{tree}"]),
  );
  expect(git(["-C", paws, "status", "--porcelain"])).toBe("");
  expect(getWorkItem(context.db, record.id)?.checkpoint).toMatchObject({
    phase: "running",
    baseSha: context.base,
    wipCommit: wip,
  });
  // The session another runner restores is the one sealed with the WIP commit and the turn.
  const generation = context.db
    .query<{ generation: number }, [string]>("SELECT generation FROM runner_work WHERE run_id=?")
    .get(record.runId)!.generation;
  expect(context.sessions.snapshot(record.runId, generation)).toMatchObject({
    status: "sealed",
    sessionId: "claude-session",
    commitSha: wip,
    turn: generation,
  });
});

test("a session waiting on ask_team hands over without losing its question", async () => {
  const record = context.item();
  const asked: { question: string; abortedWhilePosting?: boolean }[] = [];
  let posted!: () => void;
  const posting = new Promise<void>((resolve) => (posted = resolve));
  const { result } = await context.turn(
    record,
    async (command) => {
      context.events(command, [
        { type: "question", text: "Which color should the button be?", options: ["Red", "Blue"] },
      ]);
      while (!asked.length) await delay(1);
      const handing = context.backend.handOverItem(record.id);
      // The runner hands over while Paws is still posting the question.
      await context.handOver(command);
      await delay(20);
      posted();
      expect(await handing).toMatchObject({ status: "handed_over" });
    },
    async (question, ask) => {
      const entry: (typeof asked)[number] = { question };
      asked.push(entry);
      await posting;
      entry.abortedWhilePosting = ask.signal.aborted;
      return { answer: "Question posted to the team." };
    },
  );
  expect(result.handedOver).toBe(true);
  // Paws finished posting the question; the handover never cancelled it.
  expect(asked).toEqual([
    { question: "Which color should the button be?", abortedWhilePosting: false },
  ]);
});

test("a handover that fails after the interrupt while Paws posts a question keeps the question", async () => {
  const record = context.item();
  const asked: { question: string; abortedWhilePosting?: boolean }[] = [];
  let posted!: () => void;
  const posting = new Promise<void>((resolve) => (posted = resolve));
  const { result } = await context.turn(
    record,
    async (command) => {
      context.events(command, [
        { type: "question", text: "Which color should the button be?", options: ["Red", "Blue"] },
      ]);
      while (!asked.length) await delay(1);
      const handing = context.backend.handOverItem(record.id);
      await context.next();
      // The snapshot fails after the interrupt while Paws is still posting the question.
      context.events(command, [
        { type: "handover_interrupted" },
        { type: "handover", handedOver: false, reason: "snapshot" },
      ]);
      context.submit(command, { handoverFailure: "snapshot" });
      await delay(20);
      posted();
      expect(await handing).toEqual({ status: "failed", reason: "snapshot" });
    },
    async (question, ask) => {
      const entry: (typeof asked)[number] = { question };
      asked.push(entry);
      await posting;
      entry.abortedWhilePosting = ask.signal.aborted;
      return { answer: "Question posted to the team." };
    },
  );
  // The run ends as a failed handover, not as an error, and the question was posted in full.
  expect(result.handoverFailure).toBe("snapshot");
  expect(asked).toEqual([
    { question: "Which color should the button be?", abortedWhilePosting: false },
  ]);
});

test("a handover the runner cannot finish within 2 minutes is reported and the session stays on the runner", async () => {
  const record = context.item();
  let outcome: unknown;
  const { result, notices } = await context.turn(record, async (command) => {
    const handing = context.backend.handOverItem(record.id);
    await context.next();
    context.events(command, [{ type: "handover", handedOver: false, reason: "timeout" }]);
    outcome = await handing;
    // The session went on and finished its turn on the same runner.
    writeFileSync(join(context.runner, "result.txt"), "finished");
    context.git(["-C", context.runner, "commit", "-q", "-am", "Finish"]);
    context.submit(command, {
      candidateSha: context.git(["-C", context.runner, "rev-parse", "HEAD"]),
    });
  });
  expect(outcome).toEqual({ status: "timed_out" });
  expect(result.handedOver).toBeUndefined();
  expect(result.stopReason).toBe("end_turn");
  expect(notices).toContain(
    "A found no safe point to hand this session over within 2 minutes, so it keeps running there.\n",
  );
});

test("a handover that fails after the interrupt is reported with its reason, and the run keeps its session here", async () => {
  const record = context.item();
  let outcome: unknown;
  const { result, notices } = await context.turn(record, async (command) => {
    const handing = context.backend.handOverItem(record.id);
    await context.next();
    context.events(command, [
      { type: "handover_interrupted" },
      { type: "handover", handedOver: false, reason: "snapshot" },
    ]);
    outcome = await handing;
    context.submit(command, { handoverFailure: "snapshot" });
  });
  expect(outcome).toEqual({ status: "failed", reason: "snapshot" });
  expect(result.handedOver).toBeUndefined();
  expect(result.handoverFailure).toBe("snapshot");
  // The session id stays with this runner, so the next turn loads it here.
  expect(result.sessionId).toBe("claude-session");
  expect(notices).toContain(
    "A stopped this session for a move but couldn't save its Claude session, so it stays there and goes on with its next turn.\n",
  );
});

test("an item with no running session has nothing to hand over", async () => {
  expect(await context.backend.handOverItem("missing-item")).toEqual({ status: "not_running" });
});

test("a runner release that cannot hand over is never sent the command", async () => {
  const record = context.item();
  context.release("0.1.43");
  try {
    const { result } = await context.turn(record, async (command) => {
      expect(await context.backend.handOverItem(record.id)).toEqual({ status: "old_runner" });
      expect(
        context.db
          .query("SELECT 1 FROM runner_command WHERE run_id=? AND kind='handover'")
          .get(command.runId),
      ).toBeNull();
      context.submit(command, { candidateSha: context.base });
    });
    expect(result.stopReason).toBe("end_turn");
  } finally {
    context.release("0.1.44");
  }
});

test("a run stopped for the time cap saves its runner's work first, and the restarted turn starts from it", async () => {
  const { db, git, paws, runner } = context;
  const record = context.item();
  context.release("0.1.46");
  try {
    const stop = new AbortController();
    let interval = "";
    let snapshot = "";
    const { result } = await context.turn(
      record,
      async (command) => {
        // The agent commits twice in one long turn and never ends it.
        writeFileSync(join(runner, "contract.ts"), "export type Finding = {};\n");
        git(["-C", runner, "add", "-A"]);
        git(["-C", runner, "commit", "-q", "-m", "Add the findings contract"]);
        interval = git(["-C", runner, "rev-parse", "HEAD"]);
        // An interval checkpoint becomes the item's checkpoint while the turn runs.
        context.events(command, [{ type: "checkpoint", reason: "interval", sha: interval }]);
        while (getWorkItem(db, record.id)?.checkpoint?.wipCommit !== interval) await delay(1);
        writeFileSync(join(runner, "findings.tsx"), "<Findings />\n");
        git(["-C", runner, "add", "-A"]);
        git(["-C", runner, "commit", "-q", "-m", "Show the findings"]);
        writeFileSync(join(runner, "notes.txt"), "next: tests");
        // What the runner publishes: a WIP commit on top of both, with the uncommitted file.
        git(["-C", runner, "add", "-A"]);
        snapshot = git([
          "-C",
          runner,
          "commit-tree",
          git(["-C", runner, "write-tree"]),
          "-p",
          "HEAD",
          "-m",
          "Save work in progress so far",
        ]);
        // The time cap fails the item, and Paws stops the agent.
        db.run("UPDATE work_item SET awake_ms=max_awake_ms WHERE id=?", [record.id]);
        expect(accrueAwake(db, record.id, 0, Date.now()).capped).toBe(true);
        stop.abort();
        expect(await context.next()).toMatchObject({
          type: "checkpoint",
          runId: command.runId,
          generation: command.generation,
        });
        context.events(command, [{ type: "checkpoint", reason: "stop", sha: snapshot }]);
        // Only then does Paws cancel the run.
        expect(await context.next()).toMatchObject({ type: "cancel", runId: command.runId });
      },
      undefined,
      stop.signal,
      true,
    );
    expect(result?.stopReason ?? "cancelled").toBe("cancelled");
    expect(getWorkItem(db, record.id)?.checkpoint?.wipCommit).toBe(snapshot);
    const thoughts = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM outbox WHERE target='linear' AND idempotency_key LIKE ?",
      )
      .all(`checkpoint-saved:${record.runId}:%`)
      .map((row) => JSON.parse(row.payload) as { kind: string; body: string });
    expect(thoughts).toEqual([
      expect.objectContaining({
        kind: "thought",
        body: `Saved the work so far at ${snapshot.slice(0, 7)} before stopping.`,
      }),
    ]);

    // The auto-retry restarts the item; its turn starts from the saved work.
    db.run("UPDATE work_item SET state='running',cancel_requested=0 WHERE id=?", [record.id]);
    db.run("UPDATE run SET status='active' WHERE id=?", [record.runId]);
    const restarted = await context.turn(record, async (command) => {
      expect(command.repository.baseSha).toBe(snapshot);
      context.submit(command, { candidateSha: snapshot });
    });
    expect(restarted.result.stopReason).toBe("end_turn");
    expect(git(["-C", paws, "rev-parse", "HEAD"])).toBe(snapshot);
    expect(git(["-C", paws, "log", "--format=%s", "-3"]).split("\n")).toEqual([
      "Save work in progress so far",
      "Show the findings",
      "Add the findings contract",
    ]);
    expect(git(["-C", paws, "ls-files"]).split("\n").sort()).toEqual([
      "contract.ts",
      "findings.tsx",
      "notes.txt",
      "result.txt",
    ]);
  } finally {
    context.release("0.1.44");
  }
});

test("a runner release that cannot checkpoint is cancelled at once", async () => {
  const record = context.item();
  const stop = new AbortController();
  const { result } = await context.turn(
    record,
    async (command) => {
      stop.abort();
      expect(await context.next()).toMatchObject({ type: "cancel", runId: command.runId });
    },
    undefined,
    stop.signal,
    true,
  );
  expect(result?.stopReason ?? "cancelled").toBe("cancelled");
  expect(
    context.db
      .query("SELECT 1 FROM runner_command WHERE kind='checkpoint' AND run_id=?")
      .get(record.runId),
  ).toBeNull();
});

test("a restarted turn whose saved work cannot be fetched fails instead of starting from an older head", async () => {
  const { db } = context;
  const record = context.item();
  // A checkpoint the runner published that Paws no longer can fetch.
  const lost = "f".repeat(40);
  saveCheckpoint(db, record.id, { phase: "running", baseSha: context.base, wipCommit: lost });
  const running = context.backend.forItem(record.id)({
    profile: { agent: "claude", model: "model" },
    role: "implementer",
    itemId: `display-${record.id}`,
    runId: record.runId,
    prompt: "Implement fixture",
    worktreePath: context.paws,
    pawsRoot: context.root,
    networkGit: async () => "",
  });
  await expect(running).rejects.toThrow(`could not restore the saved work at ${lost.slice(0, 7)}`);
  expect(
    db.query("SELECT 1 FROM runner_command WHERE run_id=? AND kind='run'").get(record.runId),
  ).toBeNull();
  expect(getWorkItem(db, record.id)?.checkpoint?.wipCommit).toBe(lost);
});

test("a stop while a handover is under way is cancelled at once, leaving the checkpoint to the handover", async () => {
  const { db } = context;
  const record = context.item();
  context.release("0.1.46");
  try {
    const stop = new AbortController();
    const { result } = await context.turn(
      record,
      async (command) => {
        // The handover waits for a result that never comes; the stop ends the turn first.
        void context.backend.handOverItem(record.id).catch(() => undefined);
        expect(await context.next()).toMatchObject({ type: "handover", runId: command.runId });
        // The handover publishes the WIP commit; a stop checkpoint would race it.
        stop.abort();
        expect(await context.next()).toMatchObject({ type: "cancel", runId: command.runId });
      },
      undefined,
      stop.signal,
      true,
    );
    expect(result?.stopReason ?? "cancelled").toBe("cancelled");
    expect(
      db
        .query("SELECT 1 FROM runner_command WHERE run_id=? AND kind='checkpoint'")
        .get(record.runId),
    ).toBeNull();
  } finally {
    context.release("0.1.44");
  }
});

/** A commit of the runner's checkout on top of `from`, standing in for a head on GitHub. */
function commitOnRunner(from: string, file: string, body: string, message: string) {
  const { git, runner } = context;
  git(["-C", runner, "checkout", "-q", "--detach", from]);
  writeFileSync(join(runner, file), body);
  git(["-C", runner, "add", "-A"]);
  git(["-C", runner, "commit", "-q", "-m", message]);
  return git(["-C", runner, "rev-parse", "HEAD"]);
}

test("a resumed run whose branch tip on GitHub is ahead of its checkpoint starts from the tip", async () => {
  const { db, git, paws, base } = context;
  const record = context.item();
  saveCheckpoint(db, record.id, { phase: "running", baseSha: base, wipCommit: base });
  // An earlier turn of the item pushed this head before the run was restarted.
  const earlier = commitOnRunner(base, "earlier.txt", "earlier", "Earlier head");
  context.github.tip = earlier;
  context.release("0.1.48");
  try {
    const { result, command } = await context.turn(record, async (dispatched) => {
      context.submit(dispatched, { candidateSha: earlier });
    });
    expect(command.repository.baseSha).toBe(earlier);
    expect(command.repository.branchSha).toBeUndefined();
    expect(result.stopReason).toBe("end_turn");
    expect(git(["-C", paws, "rev-parse", "HEAD"])).toBe(earlier);
    expect(getWorkItem(db, record.id)?.checkpoint).toMatchObject({
      baseSha: base,
      wipCommit: earlier,
    });
  } finally {
    context.release("0.1.44");
  }
});

test("a branch tip that does not descend from the checkpoint leaves the turn at the checkpoint and reaches the runner", async () => {
  const { db, git, paws, base } = context;
  const record = context.item();
  const saved = commitOnRunner(base, "saved.txt", "saved", "Saved work");
  git(["-C", paws, "fetch", "-q", context.runner, saved]);
  git(["-C", paws, "reset", "-q", "--hard", saved]);
  saveCheckpoint(db, record.id, { phase: "running", baseSha: base, wipCommit: saved });
  const diverged = commitOnRunner(base, "other.txt", "other", "Someone else's head");
  context.github.tip = diverged;
  context.release("0.1.48");
  try {
    const { command } = await context.turn(record, async (dispatched) => {
      context.submit(dispatched, { candidateSha: saved });
    });
    expect(command.repository.baseSha).toBe(saved);
    expect(command.repository.branchSha).toBe(diverged);
    expect(command.repository.branchName).toMatch(/^paws\//);
    expect(getWorkItem(db, record.id)?.checkpoint?.wipCommit).toBe(saved);
  } finally {
    context.release("0.1.44");
  }
  // A runner release that cannot check the tip out is not sent it.
  const older = context.item();
  git(["-C", paws, "fetch", "-q", context.runner, saved]);
  git(["-C", paws, "reset", "-q", "--hard", saved]);
  saveCheckpoint(db, older.id, { phase: "running", baseSha: base, wipCommit: saved });
  context.github.tip = diverged;
  const { command } = await context.turn(older, async (dispatched) => {
    context.submit(dispatched, { candidateSha: saved });
  });
  expect(command.repository.baseSha).toBe(saved);
  expect(command.repository.branchSha).toBeUndefined();
});

test("a candidate whose rebase onto the branch conflicts comes back for a conflict round, with no question", async () => {
  const { db, git, paws, base } = context;
  const record = context.item();
  const tip = commitOnRunner(base, "result.txt", "remote", "Earlier head");
  const parked = commitOnRunner(base, "result.txt", "agent", "Agent's work");
  const questions: string[] = [];
  const { result, command } = await context.turn(
    record,
    async (dispatched) => {
      context.submit(dispatched, {
        stopReason: "error",
        errorMessage: "The runner stopped this run: the candidate conflicts.",
        pushFailure: {
          branch: "paws/fixture",
          error: "Rebasing conflicts in result.txt.",
          conflict: { branch: "paws/fixture-conflict", sha: parked, tip, files: ["result.txt"] },
        },
      });
    },
    async (question) => {
      questions.push(question);
      return { answer: "retry" };
    },
  );
  expect(questions).toEqual([]);
  expect(result.candidateConflict).toEqual({
    branch: "paws/fixture",
    tip,
    files: ["result.txt"],
  });
  expect(context.fetched).toEqual(["paws/fixture-conflict"]);
  expect(git(["-C", paws, "rev-parse", "HEAD"])).toBe(parked);
  expect(getWorkItem(db, record.id)?.checkpoint?.wipCommit).toBe(parked);
  expect(command.repository.baseSha).toBe(base);
});

test("a candidate that conflicts again right after a conflict round asks a person", async () => {
  const { db, base } = context;
  const record = context.item();
  db.run(
    `INSERT INTO work_item_event(item_id,version,at,from_state,to_state,event,kind,reason)
     VALUES(?,1000,?,'running','queued','restart','restart','conflict')`,
    [record.id, Date.now()],
  );
  const tip = commitOnRunner(base, "result.txt", "remote", "Earlier head");
  const parked = commitOnRunner(base, "result.txt", "agent", "Agent's work");
  const questions: string[] = [];
  const { result } = await context.turn(
    record,
    async (dispatched) => {
      context.submit(dispatched, {
        stopReason: "error",
        pushFailure: {
          branch: "paws/fixture",
          error: "Rebasing conflicts in result.txt.",
          conflict: { branch: "paws/fixture-conflict", sha: parked, tip, files: ["result.txt"] },
        },
      });
    },
    async (question) => {
      questions.push(question);
      return { answer: "retry" };
    },
  );
  expect(result.candidateConflict).toBeUndefined();
  expect(questions).toHaveLength(1);
  expect(questions[0]).toContain("Paws could not push the candidate to `paws/fixture`");
});
