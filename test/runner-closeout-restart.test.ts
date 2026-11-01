import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { git, type AcpEvent, type RunAgentOptions } from "../src/acp";
import { PawsShutdown, RunnerCapacityWait } from "../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  openDatabase,
  prepareShutdown,
  putWorkspaceUser,
  recordLinearInstallation,
  recoverOnStartup,
  saveCheckpoint,
} from "../src/db";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import {
  RUNNER_LEASE_GRACE_MS,
  type RunnerCommand,
  type RunnerResult,
} from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

const REMOTE = "https://github.com/acme/fixture.git";
const REVIEW_TEXT = "[]";
const REPORT = "Closeout report for the checks";

type CloseoutCommand = Extract<RunnerCommand, { type: "run" | "review" }>;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-closeout-restart-"));
  const worktree = join(root, "worktree");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  await git(["init", "-b", "main", worktree]);
  writeFileSync(join(worktree, "app.txt"), "one\n");
  await git(["-C", worktree, "add", "."]);
  await git(["-C", worktree, "commit", "-m", "base"], { env });
  const base = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
  writeFileSync(join(worktree, "app.txt"), "two\n");
  await git(["-C", worktree, "commit", "-am", "head"], { env });
  const head = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();

  const path = join(root, "paws.db");
  let db: Database = migratedDatabase(path);
  const now = Date.now();
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [workspace.id, "acme/fixture", "team"]);
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
  });
  const enrollment = { name: "fixture", csr: (await createRunnerKey(join(root, "client"))).csr };
  const { runnerId } = await control.enroll({
    ...enrollment,
    token: control.createEnrollment(
      { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: now, teamIds: [] },
      enrollment,
    ).token,
  });
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [runnerId]);
  db.run(
    "INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,'9.0.0',?)",
    [runnerId, now],
  );
  const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  const { run } = beginImplementRun(db, item.id, now);
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  bindWorkItemRepository(db, item.id, { owner: "acme", repo: "fixture", remoteUrl: REMOTE });
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, item.id]);
  // The agent's turn ended and Closeout is checking its candidate.
  applyWorkItemEvent(db, item.id, "turn_ended");
  saveCheckpoint(db, item.id, { phase: "verifying", baseSha: base, wipCommit: head });

  const keys = generateKeyPairSync("ed25519");
  function open() {
    const work = createRunnerWork({ db, keyId: "fixture", privateKey: keys.privateKey });
    const results = createRunnerResults({ db, work });
    const backend = createRemoteAgentRunner({
      db,
      work,
      results,
      health: createRunnerHealth({ db, work }),
      placement: createRunnerPlacement({ db }),
      pollIntervalMs: 5,
      // The check run reports the head the worktree already holds.
      async fetchCandidate() {},
    });
    return { work, results, backend };
  }
  let services = open();

  // The runner keeps heartbeating and acknowledging while Paws restarts.
  const placed: CloseoutCommand[] = [];
  const sim = { stopped: false, paused: false };
  const handled = new Set<string>();
  const runner = (async () => {
    while (!sim.stopped) {
      if (!sim.paused) {
        const { work } = services;
        work.heartbeat(runnerId);
        for (const envelope of work.commands(runnerId)) {
          const command = JSON.parse(
            Buffer.from(envelope.payload, "base64url").toString(),
          ) as RunnerCommand;
          if (handled.has(command.id)) continue;
          handled.add(command.id);
          work.acknowledge(runnerId, command.id);
          if (command.type === "cancel")
            work.heartbeat(
              runnerId,
              1,
              {},
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              [{ runId: command.runId, generation: command.generation, commandId: command.id }],
            );
          if (command.type === "run" || command.type === "review") placed.push(command);
        }
      }
      await Bun.sleep(5);
    }
  })();

  const events: AcpEvent[] = [];
  const common = (signal: AbortSignal) => ({
    itemId: item.id,
    worktreePath: worktree,
    pawsRoot: root,
    checkpoint: false as const,
    signal,
    onEvent(event: AcpEvent) {
      events.push(event);
    },
  });
  const review = (signal: AbortSignal): RunAgentOptions => ({
    ...common(signal),
    role: "reviewer",
    runId: "rev-item-1",
    profile: { agent: "claude", model: "review-model" },
    prompt: `Review ${base}..${head} with the agent's review command.`,
    readOnly: true,
    mainSha: base,
    reviewCommand: { base },
  });
  const checks = (signal: AbortSignal, commit = head): RunAgentOptions => ({
    ...common(signal),
    role: "implementer",
    runId: `checks-item-${commit.slice(0, 7)}-1`,
    profile: { agent: "claude", model: null },
    prompt: `Run the Closeout checks at ${commit}.`,
    mainSha: base,
    // The orchestrator authorizes the candidate import; the fake fetch needs no network.
    networkGit: async () => "",
  });
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 2_000 && !ready(); i++) await Bun.sleep(5);
    if (!ready()) throw new Error("Timed out");
  };
  const commandCount = (kind?: string) =>
    db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM runner_command WHERE ?1='' OR kind=?1",
      )
      .get(kind ?? "")!.count;
  const consumed = () =>
    db
      .query<{ sequence: number }, [string]>(
        "SELECT consumed_sequence AS sequence FROM runner_work WHERE run_id=?",
      )
      .get(run.id)?.sequence ?? 0;
  const grant = (command: CloseoutCommand) =>
    services.work.issueGrant({
      runnerId,
      runId: command.runId,
      commandId: command.id,
      generation: command.generation,
    }).token;

  return {
    head,
    item,
    run,
    placed,
    events,
    review,
    checks,
    until,
    commandCount,
    consumed,
    cancelAcknowledged: () =>
      db
        .query("SELECT 1 FROM runner_command WHERE kind='cancel' AND acknowledged_at IS NOT NULL")
        .get() !== null,
    get db() {
      return db;
    },
    get services() {
      return services;
    },
    say(command: CloseoutCommand, sequence: number, text: string) {
      services.work.event({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        token: grant(command),
        sequence,
        event: {
          type: "activity",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    },
    finish(command: CloseoutCommand, result: Partial<RunnerResult>) {
      return services.results.submit({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        token: grant(command),
        result: {
          executionId: workspaceId(),
          commandId: command.id,
          role: command.type === "review" ? "reviewer" : "implementer",
          stopReason: "end_turn",
          timedOut: false,
          cancelled: false,
          authRequired: false,
          agentExited: true,
          identity: { session: `session-${command.id}`, model: "fixture", provider: "fixture" },
          ...result,
        },
      });
    },
    restart() {
      sim.paused = true;
      db.close();
      db = openDatabase(path);
      services = open();
      sim.paused = false;
    },
    async close() {
      sim.stopped = true;
      await runner;
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Starts the Closeout command, lets one event through, and shuts Paws down mid-command. */
async function shutDownMidCommand(f: Fixture, options: (signal: AbortSignal) => RunAgentOptions) {
  const shutdown = new AbortController();
  const first = f.services.backend
    .forItem(f.item.id)(options(shutdown.signal))
    .then(
      () => null,
      (error: unknown) => error,
    );
  await f.until(() => f.placed.length === 1);
  const command = f.placed[0]!;
  f.say(command, 1, "Before the restart.");
  await f.until(() => f.consumed() === 1);
  shutdown.abort(new PawsShutdown());
  expect(await first).not.toBeNull();
  return command;
}

function restartWithRunnerHolding(f: Fixture) {
  expect(f.commandCount("cancel")).toBe(0);
  prepareShutdown(f.db);
  expect(getWorkItem(f.db, f.item.id)).toMatchObject({ state: "verifying", recoveryAttempts: 0 });
  expect(getRun(f.db, f.run.id)?.status).toBe("active");
  f.restart();
  expect(recoverOnStartup(f.db)).toEqual([{ type: "reverify" }]);
  // A second start before the re-verify ran does not queue another one.
  expect(recoverOnStartup(f.db)).toEqual([{ type: "reverify" }]);
  expect(getWorkItem(f.db, f.item.id)).toMatchObject({ state: "verifying", recoveryAttempts: 0 });
  expect(
    listJobs(f.db).filter((job) => job.queue === "run.reverify" && job.status === "pending"),
  ).toHaveLength(1);
}

const messages = (events: AcpEvent[], text: string) =>
  events.filter(
    (event) =>
      event.type === "session_update" &&
      event.update.sessionUpdate === "agent_message_chunk" &&
      event.update.content.type === "text" &&
      event.update.content.text === text,
  );

const results = (f: Fixture) =>
  f.db.query("SELECT 1 FROM runner_result WHERE run_id=?").all(f.run.id).length;

const ended = (f: Fixture) =>
  f.db
    .query<{ endedAt: number | null }, [string]>(
      "SELECT ended_at AS endedAt FROM runner_work WHERE run_id=?",
    )
    .get(f.run.id)?.endedAt ?? null;

test("a Closeout review keeps running through a Paws restart and its result is used once", async () => {
  const f = await fixture();
  try {
    const command = await shutDownMidCommand(f, f.review);
    expect(command.type).toBe("review");
    restartWithRunnerHolding(f);

    // The runner delivers the review it finished while Paws was down.
    expect(f.finish(command, { reviewText: REVIEW_TEXT })).toEqual({ duplicate: false });
    const commands = f.commandCount();
    f.events.length = 0;
    const result = await f.services.backend.forItem(f.item.id)(
      f.review(new AbortController().signal),
    );

    expect(result).toMatchObject({ stopReason: "end_turn", agentExited: true, cancelled: false });
    expect(f.placed).toHaveLength(1);
    expect(f.commandCount()).toBe(commands);
    expect(messages(f.events, REVIEW_TEXT)).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "prompt_complete")).toHaveLength(1);
    expect(results(f)).toBe(1);
    expect(ended(f)).not.toBeNull();
  } finally {
    await f.close();
  }
}, 60_000);

test("a Closeout check run keeps running through a Paws restart and its report is used once", async () => {
  const f = await fixture();
  try {
    const command = await shutDownMidCommand(f, f.checks);
    expect(command.type).toBe("run");
    restartWithRunnerHolding(f);

    const commands = f.commandCount();
    f.events.length = 0;
    const resumed = f.services.backend.forItem(f.item.id)(f.checks(new AbortController().signal));
    expect(f.finish(command, { candidateSha: f.head, closeoutReport: REPORT })).toEqual({
      duplicate: false,
    });
    const result = await resumed;

    expect(result).toMatchObject({ stopReason: "end_turn", closeoutReport: REPORT });
    expect(f.placed).toHaveLength(1);
    expect(f.commandCount()).toBe(commands);
    expect(f.events.filter((event) => event.type === "prompt_complete")).toHaveLength(1);
    expect(results(f)).toBe(1);
    expect(ended(f)).not.toBeNull();
  } finally {
    await f.close();
  }
}, 60_000);

test("a delivered Closeout result has only one backend importer", async () => {
  const f = await fixture();
  try {
    const command = await shutDownMidCommand(f, f.review);
    restartWithRunnerHolding(f);
    f.finish(command, { reviewText: REVIEW_TEXT });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const input = f.review(new AbortController().signal);
    input.onEvent = async () => {
      entered = true;
      await held;
    };
    const reader = f.services.backend.forItem(f.item.id)(input);
    try {
      await f.until(() => entered);
      expect(f.services.backend.runInProgress(f.run.id)).toBe(true);
      await expect(
        f.services.backend.forItem(f.item.id)(f.review(new AbortController().signal)),
      ).rejects.toBeInstanceOf(RunnerCapacityWait);
    } finally {
      release();
      await reader;
    }
    expect(f.services.backend.runInProgress(f.run.id)).toBe(false);
    expect(ended(f)).not.toBeNull();
    expect(f.placed).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60_000);

test("a kept Closeout command for another head is cancelled and the checks are placed again", async () => {
  const f = await fixture();
  try {
    const stale = await shutDownMidCommand(f, (signal) => f.checks(signal, "b".repeat(40)));
    restartWithRunnerHolding(f);

    // The runner takes no command until it acknowledges the cancel, so the re-verify waits.
    const attempt = () =>
      f.services.backend.forItem(f.item.id)(f.checks(new AbortController().signal));
    const resumed = attempt().catch(async (error: unknown) => {
      if (!(error instanceof RunnerCapacityWait)) throw error;
      await f.until(() => f.cancelAcknowledged());
      return attempt();
    });
    await f.until(() => f.placed.length === 2);
    expect(f.commandCount("cancel")).toBe(1);
    const placed = f.placed[1]!;
    expect(placed.prompt).toBe(`Run the Closeout checks at ${f.head}.`);
    expect(placed.generation).toBe(stale.generation + 1);
    f.finish(placed, { candidateSha: f.head, closeoutReport: REPORT });
    expect(await resumed).toMatchObject({ closeoutReport: REPORT });
  } finally {
    await f.close();
  }
}, 60_000);

test("a verifying item whose runner lease ran past its grace re-verifies as before", async () => {
  const f = await fixture();
  try {
    await shutDownMidCommand(f, f.review);
    expect(f.commandCount("cancel")).toBe(0);
    const later = Date.now() + 60_001 + RUNNER_LEASE_GRACE_MS;
    prepareShutdown(f.db, later);
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({
      state: "verifying",
      checkpoint: { phase: "verifying", wipCommit: f.head },
    });
    expect(getRun(f.db, f.run.id)?.status).toBe("lost");
    f.restart();
    expect(recoverOnStartup(f.db, later)).toEqual([{ type: "reverify", resumed: true }]);
    expect(getWorkItem(f.db, f.item.id)).toMatchObject({ state: "verifying", recoveryAttempts: 1 });
    const open = listJobs(f.db).filter((job) => job.status === "pending");
    expect(open.map((job) => job.queue)).toEqual(["run.reverify"]);
    expect(open[0]!.payload).toMatchObject({ itemId: f.item.id, recheckHead: true });
    f.restart();
    expect(recoverOnStartup(f.db, later + 1_000)).toEqual([{ type: "ask_restart" }]);
    expect(listJobs(f.db).some((job) => job.queue === "run.resume")).toBe(false);
  } finally {
    await f.close();
  }
}, 60_000);
