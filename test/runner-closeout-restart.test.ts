import { createFakeGitHub } from "../src/github";
import { createAgentReadAccess, createAgentReadTokens } from "../src/runner-repository-access";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { git, runDir, type AcpEvent, type RunAgentOptions } from "../src/acp";
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
  openPawsStore,
  prepareShutdown,
  putWorkspaceUser,
  recordLinearInstallation,
  recoverOnStartup,
  saveCheckpoint,
  type Db,
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
import { seedCandidate } from "./helpers";
import { seed } from "./dialects";
import { copyMigratedPglite } from "./pglite";

const REMOTE = "https://github.com/acme/fixture.git";
const REVIEW_TEXT = "[]";
const REPORT = "Closeout report for the checks";

type CloseoutCommand = Extract<RunnerCommand, { type: "run" | "review" }>;

type AgentRead = NonNullable<Parameters<typeof createRemoteAgentRunner>[0]["agentRead"]>;

async function fixture(agentRead?: AgentRead) {
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
  // Paws holds the candidate in the bare mirror; the checkout only made the commits.
  seedCandidate(root, "item", worktree, { owner: "acme", repo: "fixture" });

  const dir = join(root, "pglite");
  await copyMigratedPglite(dir);
  let store = await openPawsStore({ url: null, pgliteDir: dir });
  let db: Db = store.store;
  const now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspaceRepository)
      .values({ workspaceId: workspace.id, repository: "acme/fixture", teamId: "team" }),
  );
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    store: db,
    authority: await initializeRunnerAuthority(issuer),
    certificateRoot: issuer,
    disconnect() {},
  });
  const enrollment = { name: "fixture", csr: (await createRunnerKey(join(root, "client"))).csr };
  const { runnerId } = await control.enroll({
    ...enrollment,
    token: (
      await control.createEnrollment(
        { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: now, teamIds: [] },
        enrollment,
      )
    ).token,
  });
  await seed(
    db,
    (q) => q.orm.update(q.t.runner).set({ status: "active" }).where(eq(q.t.runner.id, runnerId)),
    (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId }),
    (q) => q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId, agent: "claude", ready: 1 }),
    (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId, runnerVersion: "9.0.0", reportedAt: now }),
  );
  const item = await insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  const { run } = await beginImplementRun(db, item.id, now);
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  await bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  await bindWorkItemRepository(db, item.id, {
    owner: "acme",
    repo: "fixture",
    remoteUrl: REMOTE,
  });
  await seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ ownerUserId: userId }).where(eq(q.t.workItem.id, item.id)),
  );
  // The agent's turn ended and Closeout is checking its candidate.
  await applyWorkItemEvent(db, item.id, "turn_ended");
  await saveCheckpoint(db, item.id, {
    phase: "verifying",
    baseSha: base,
    wipCommit: head,
  });

  const keys = generateKeyPairSync("ed25519");
  function open() {
    const work = createRunnerWork({
      store: db,
      keyId: "fixture",
      privateKey: keys.privateKey,
      eventKey: Buffer.alloc(32, 7),
    });
    const results = createRunnerResults({ store: db, work });
    const backend = createRemoteAgentRunner({
      store: db,
      work,
      results,
      health: createRunnerHealth({ store: db, work }),
      placement: createRunnerPlacement({ store: db }),
      pollIntervalMs: 5,
      ...(agentRead ? { agentRead } : {}),
      // The check run reports the head the worktree already holds.
      async fetchCandidate() {},
    });
    return { work, results, backend };
  }
  let services = open();

  // The runner keeps heartbeating and acknowledging while Paws restarts.
  const placed: CloseoutCommand[] = [];
  const sim = { stopped: false, paused: false, busy: false };
  const handled = new Set<string>();
  const runner = (async () => {
    while (!sim.stopped) {
      if (!sim.paused) {
        sim.busy = true;
        const { work } = services;
        await work.heartbeat(runnerId);
        for (const envelope of await work.commands(runnerId)) {
          const command = JSON.parse(
            Buffer.from(envelope.payload, "base64url").toString(),
          ) as RunnerCommand;
          if (handled.has(command.id)) continue;
          handled.add(command.id);
          await work.acknowledge(runnerId, command.id);
          if (command.type === "cancel")
            await work.heartbeat(
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
        sim.busy = false;
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
    networkGit: async (args) => {
      const target = args.at(-1)!;
      if (args.includes("fetch")) {
        const ref = target.slice(target.indexOf(":") + 1);
        return git(["--git-dir", args[1]!, "update-ref", ref, head]);
      }
      return "";
    },
  });
  const until = async (ready: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 2_000; i++) {
      if (await ready()) return;
      await Bun.sleep(5);
    }
    throw new Error("Timed out");
  };
  const commandCount = async (kind?: string) => {
    const [row] = await db.run((q) =>
      q.all(
        q.orm
          .select({ n: count() })
          .from(q.t.runnerCommand)
          .where(kind === undefined ? undefined : eq(q.t.runnerCommand.kind, kind)),
      ),
    );
    return Number(row!.n);
  };
  const consumed = async () => {
    const [row] = await db.run((q) =>
      q.all(
        q.orm
          .select({ sequence: q.t.runnerWork.consumedSequence })
          .from(q.t.runnerWork)
          .where(eq(q.t.runnerWork.runId, run.id)),
      ),
    );
    return row?.sequence ?? 0;
  };
  const grant = async (command: CloseoutCommand) =>
    (
      await services.work.issueGrant({
        runnerId,
        runId: command.runId,
        commandId: command.id,
        generation: command.generation,
      })
    ).token;

  return {
    head,
    runnerId,
    grant,
    root,
    item,
    run,
    placed,
    events,
    review,
    checks,
    until,
    commandCount,
    consumed,
    cancelAcknowledged: async () =>
      (
        await db.run((q) =>
          q.all(
            q.orm
              .select({ id: q.t.runnerCommand.id })
              .from(q.t.runnerCommand)
              .where(
                and(
                  eq(q.t.runnerCommand.kind, "cancel"),
                  isNotNull(q.t.runnerCommand.acknowledgedAt),
                ),
              ),
          ),
        )
      ).length > 0,
    get db() {
      return db;
    },
    get services() {
      return services;
    },
    async say(command: CloseoutCommand, sequence: number, text: string) {
      await services.work.event({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        token: await grant(command),
        sequence,
        event: {
          type: "activity",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    },
    async finish(command: CloseoutCommand, result: Partial<RunnerResult>) {
      return services.results.submit({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        token: await grant(command),
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
    async restart(probe?: (dir: string) => Promise<void>) {
      sim.paused = true;
      while (sim.busy) await Bun.sleep(1);
      await store.close();
      await probe?.(dir);
      store = await openPawsStore({ url: null, pgliteDir: dir });
      db = store.store;
      services = open();
      sim.paused = false;
    },
    async close() {
      sim.stopped = true;
      await runner;
      await store.close();
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
  await f.say(command, 1, "Before the restart.");
  await f.until(async () => (await f.consumed()) === 1);
  shutdown.abort(new PawsShutdown());
  expect(await first).not.toBeNull();
  return command;
}

async function restartWithRunnerHolding(f: Fixture) {
  expect(await f.commandCount("cancel")).toBe(0);
  await prepareShutdown(f.db);
  expect(await getWorkItem(f.db, f.item.id)).toMatchObject({
    state: "verifying",
    recoveryAttempts: 0,
  });
  expect((await getRun(f.db, f.run.id))?.status).toBe("active");
  await f.restart();
  expect(await recoverOnStartup(f.db)).toEqual([{ type: "reverify" }]);
  // A second start before the re-verify ran does not queue another one.
  expect(await recoverOnStartup(f.db)).toEqual([{ type: "reverify" }]);
  expect(await getWorkItem(f.db, f.item.id)).toMatchObject({
    state: "verifying",
    recoveryAttempts: 0,
  });
  expect(
    (await listJobs(f.db)).filter(
      (job) => job.queue === "run.reverify" && job.status === "pending",
    ),
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

const results = async (f: Fixture) =>
  (
    await f.db.run((q) =>
      q.all(
        q.orm
          .select({ runId: q.t.runnerResult.runId })
          .from(q.t.runnerResult)
          .where(eq(q.t.runnerResult.runId, f.run.id)),
      ),
    )
  ).length;

const ended = async (f: Fixture) => {
  const [row] = await f.db.run((q) =>
    q.all(
      q.orm
        .select({ endedAt: q.t.runnerWork.endedAt })
        .from(q.t.runnerWork)
        .where(eq(q.t.runnerWork.runId, f.run.id)),
    ),
  );
  return row?.endedAt ?? null;
};

const runnerVersion = (f: Fixture, version: string) =>
  seed(f.db, (q) => q.orm.update(q.t.runnerHostStatus).set({ runnerVersion: version }));

test("a Closeout review keeps running through a Paws restart and its result is used once", async () => {
  const f = await fixture();
  try {
    const command = await shutDownMidCommand(f, f.review);
    expect(command.type).toBe("review");
    await restartWithRunnerHolding(f);

    // The runner delivers the review it finished while Paws was down.
    expect(await f.finish(command, { reviewText: REVIEW_TEXT })).toEqual({ duplicate: false });
    const commands = await f.commandCount();
    f.events.length = 0;
    const result = await f.services.backend.forItem(f.item.id)(
      f.review(new AbortController().signal),
    );

    expect(result).toMatchObject({ stopReason: "end_turn", agentExited: true, cancelled: false });
    expect(f.placed).toHaveLength(1);
    expect(await f.commandCount()).toBe(commands);
    expect(messages(f.events, REVIEW_TEXT)).toHaveLength(1);
    expect(f.events.filter((event) => event.type === "prompt_complete")).toHaveLength(1);
    expect(await results(f)).toBe(1);
    expect(await ended(f)).not.toBeNull();
  } finally {
    await f.close();
  }
}, 60_000);

test("a Closeout check run keeps running through a Paws restart and its report is used once", async () => {
  const f = await fixture();
  try {
    const command = await shutDownMidCommand(f, f.checks);
    expect(command.type).toBe("run");
    await restartWithRunnerHolding(f);

    const commands = await f.commandCount();
    f.events.length = 0;
    const resumed = f.services.backend.forItem(f.item.id)(f.checks(new AbortController().signal));
    expect(await f.finish(command, { candidateSha: f.head, closeoutReport: REPORT })).toEqual({
      duplicate: false,
    });
    const result = await resumed;

    expect(result).toMatchObject({ stopReason: "end_turn", closeoutReport: REPORT });
    expect(f.placed).toHaveLength(1);
    expect(await f.commandCount()).toBe(commands);
    expect(f.events.filter((event) => event.type === "prompt_complete")).toHaveLength(1);
    expect(await results(f)).toBe(1);
    expect(await ended(f)).not.toBeNull();
  } finally {
    await f.close();
  }
}, 60_000);

test("a delivered Closeout result has only one backend importer", async () => {
  const f = await fixture();
  try {
    const command = await shutDownMidCommand(f, f.review);
    await restartWithRunnerHolding(f);
    await f.finish(command, { reviewText: REVIEW_TEXT });
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
    expect(await ended(f)).not.toBeNull();
    expect(f.placed).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 60_000);

test("a kept Closeout command for another head is cancelled and the checks are placed again", async () => {
  const f = await fixture();
  try {
    const stale = await shutDownMidCommand(f, (signal) => f.checks(signal, "b".repeat(40)));
    await restartWithRunnerHolding(f);

    // The runner takes no command until it acknowledges the cancel, so the re-verify waits.
    const attempt = () =>
      f.services.backend.forItem(f.item.id)(f.checks(new AbortController().signal));
    const resumed = attempt().catch(async (error: unknown) => {
      if (!(error instanceof RunnerCapacityWait)) throw error;
      await f.until(() => f.cancelAcknowledged());
      return attempt();
    });
    await f.until(() => f.placed.length === 2);
    expect(await f.commandCount("cancel")).toBe(1);
    const placed = f.placed[1]!;
    expect(placed.prompt).toBe(`Run the Closeout checks at ${f.head}.`);
    expect(placed.generation).toBe(stale.generation + 1);
    await f.finish(placed, { candidateSha: f.head, closeoutReport: REPORT });
    expect(await resumed).toMatchObject({ closeoutReport: REPORT });
  } finally {
    await f.close();
  }
}, 60_000);

test("a verifying item whose runner lease ran past its grace re-verifies as before", async () => {
  const f = await fixture();
  try {
    await shutDownMidCommand(f, f.review);
    expect(await f.commandCount("cancel")).toBe(0);
    const later = Date.now() + 60_001 + RUNNER_LEASE_GRACE_MS;
    await prepareShutdown(f.db, later);
    expect(await getWorkItem(f.db, f.item.id)).toMatchObject({
      state: "verifying",
      checkpoint: { phase: "verifying", wipCommit: f.head },
    });
    expect((await getRun(f.db, f.run.id))?.status).toBe("lost");
    await f.restart();
    expect(await recoverOnStartup(f.db, later)).toEqual([{ type: "reverify", resumed: true }]);
    expect(await getWorkItem(f.db, f.item.id)).toMatchObject({
      state: "verifying",
      recoveryAttempts: 1,
    });
    const open = (await listJobs(f.db)).filter((job) => job.status === "pending");
    expect(open.map((job) => job.queue)).toEqual(["run.reverify"]);
    expect(open[0]!.payload).toMatchObject({ itemId: f.item.id, recheckHead: true });
    await f.restart();
    expect(await recoverOnStartup(f.db, later + 1_000)).toEqual([{ type: "ask_restart" }]);
    expect((await listJobs(f.db)).some((job) => job.queue === "run.resume")).toBe(false);
  } finally {
    await f.close();
  }
}, 60_000);

test("a review command carries the brief and earlier findings only to a runner that accepts them", async () => {
  const earlier = [
    {
      severity: "P1" as const,
      location: "app.txt:1",
      explanation: "wrong constant",
      head: "c".repeat(40),
      status: "open" as const,
    },
  ];
  for (const [version, expected] of [
    ["0.1.54", (base: string) => ({ base })],
    ["9.0.0", (base: string) => ({ base, brief: "Issue: PAS-1", earlier })],
  ] as const) {
    const f = await fixture();
    try {
      await runnerVersion(f, version);
      const options = f.review(new AbortController().signal);
      const base = options.reviewCommand!.base;
      const running = f.services.backend.forItem(f.item.id)({
        ...options,
        reviewCommand: { base, brief: "Issue: PAS-1", earlier },
      });
      await f.until(() => f.placed.length === 1);
      const command = f.placed[0]!;
      expect(command.type === "review" && command.reviewCommand).toEqual(expected(base));
      await f.finish(command, { reviewText: REVIEW_TEXT });
      expect(await running).toMatchObject({ stopReason: "end_turn" });
    } finally {
      await f.close();
    }
  }
}, 60_000);

test("a checks run asks for rules first only on a runner that accepts it", async () => {
  for (const [version, expected] of [
    ["0.1.59", undefined],
    ["0.1.60", true],
  ] as const) {
    const f = await fixture();
    try {
      await runnerVersion(f, version);
      const running = f.services.backend.forItem(f.item.id)({
        ...f.checks(new AbortController().signal),
        closeoutRulesFirst: true,
      });
      await f.until(() => f.placed.length === 1);
      const command = f.placed[0]!;
      expect(command.type === "run" && command.closeoutRulesFirst).toBe(expected);
      await f.finish(command, { candidateSha: f.head, closeoutReport: REPORT });
      expect(await running).toMatchObject({ stopReason: "end_turn" });
    } finally {
      await f.close();
    }
  }
}, 60_000);

const READ_TOKEN = `ghs_${"r".repeat(36)}`;
const READ_PROMPT = "`gh` is signed in with read-only access to this task's repositories.";

function recordingAgentRead(minted = true) {
  const opened: unknown[] = [];
  const closed: string[] = [];
  const agentRead: AgentRead = {
    async open(input) {
      opened.push(input);
      return minted;
    },
    tokens: () => [READ_TOKEN],
    async close(commandId) {
      closed.push(commandId);
    },
  };
  return { agentRead, opened, closed };
}

test("a turn on a runner that takes it gets one read token and its prompt line; an older runner gets neither", async () => {
  for (const [version, current] of [
    ["0.1.67", false],
    ["0.1.68", true],
  ] as const) {
    const read = recordingAgentRead();
    const f = await fixture(read.agentRead);
    try {
      await runnerVersion(f, version);
      const running = f.services.backend.forItem(f.item.id)({
        ...f.checks(new AbortController().signal),
        githubRead: { prompt: READ_PROMPT },
      });
      await f.until(() => f.placed.length === 1);
      const command = f.placed[0]!;
      expect(command.type === "run" && command.githubRead).toBe(current ? true : undefined);
      expect(command.prompt?.endsWith(`\n\n${READ_PROMPT}`)).toBe(current);
      await f.say(command, 1, `gh printed ${READ_TOKEN}`);
      await f.until(async () => (await f.consumed()) === 1);
      await f.finish(command, { candidateSha: f.head, closeoutReport: REPORT });
      expect(await running).toMatchObject({ stopReason: "end_turn" });
      expect(read.opened).toEqual(
        current
          ? [
              {
                commandId: command.id,
                itemId: f.item.id,
                runId: command.runId,
                repository: "acme/fixture",
              },
            ]
          : [],
      );
      expect(read.closed).toEqual(current ? [command.id] : []);
      const stored = readFileSync(
        join(runDir(f.root, f.checks(new AbortController().signal).runId), "acp.jsonl"),
        "utf8",
      );
      expect(stored.includes(READ_TOKEN)).toBe(!current);
      expect(JSON.stringify(f.events).includes(READ_TOKEN)).toBe(!current);
    } finally {
      await f.close();
    }
  }
}, 60_000);

test("a turn without a token still runs, and a stopped turn revokes its token", async () => {
  const failed = recordingAgentRead(false);
  const f = await fixture(failed.agentRead);
  try {
    const running = f.services.backend.forItem(f.item.id)({
      ...f.checks(new AbortController().signal),
      githubRead: { prompt: READ_PROMPT },
    });
    await f.until(() => f.placed.length === 1);
    const command = f.placed[0]!;
    expect(command.type === "run" && command.githubRead).toBeUndefined();
    expect(command.prompt).not.toContain(READ_PROMPT);
    await f.finish(command, { candidateSha: f.head, closeoutReport: REPORT });
    expect(await running).toMatchObject({ stopReason: "end_turn" });
    expect(failed.opened).toHaveLength(1);
    expect(failed.closed).toEqual([]);
  } finally {
    await f.close();
  }
  const read = recordingAgentRead();
  const g = await fixture(read.agentRead);
  try {
    const stop = new AbortController();
    const running = g.services.backend
      .forItem(g.item.id)({ ...g.checks(stop.signal), githubRead: { prompt: READ_PROMPT } })
      .catch((error: unknown) => error);
    await g.until(() => g.placed.length === 1);
    stop.abort();
    await running;
    expect(read.closed).toEqual([g.placed[0]!.id]);
  } finally {
    await g.close();
  }
}, 60_000);

test("a turn Paws reattaches after a restart gets a fresh read lease, and the old one is revoked", async () => {
  const read = recordingAgentRead();
  const f = await fixture(read.agentRead);
  try {
    const withRead = (signal: AbortSignal) => ({
      ...f.checks(signal),
      githubRead: { prompt: READ_PROMPT },
    });
    const command = await shutDownMidCommand(f, withRead);
    expect(command.type === "run" && command.githubRead).toBe(true);
    expect(read.closed).toEqual([command.id]);
    await restartWithRunnerHolding(f);
    const resumed = f.services.backend.forItem(f.item.id)(withRead(new AbortController().signal));
    await f.until(() => read.opened.length === 2);
    await f.finish(command, { candidateSha: f.head, closeoutReport: REPORT });
    expect(await resumed).toMatchObject({ stopReason: "end_turn", closeoutReport: REPORT });
    expect(f.placed).toHaveLength(1);
    expect(read.opened).toEqual([
      expect.objectContaining({ commandId: command.id }),
      {
        commandId: command.id,
        itemId: f.item.id,
        runId: command.runId,
        repository: "acme/fixture",
      },
    ]);
    expect(read.closed).toEqual([command.id, command.id]);
  } finally {
    await f.close();
  }
}, 60_000);

test("a new control-plane process rebuilds read access using a persisted overlapping grant", async () => {
  const f = await fixture(recordingAgentRead().agentRead);
  try {
    const command = await shutDownMidCommand(f, (signal) => ({
      ...f.checks(signal),
      githubRead: { prompt: READ_PROMPT },
    }));
    const token = await f.grant(command);
    await f.grant(command);
    await f.restart(async (dir) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { generateKeyPairSync } from "node:crypto";
        import { openPawsStore } from "./src/db";
        import { createRunnerWork } from "./src/runner-work";
        import { createAgentReadAccess, createAgentReadTokens } from "./src/runner-repository-access";
        import { createFakeGitHub } from "./src/github";
        const store = await openPawsStore({ url: null, pgliteDir: process.env.PROBE_DIR });
        try {
          const work = createRunnerWork({ store: store.store, keyId: "fixture",
            privateKey: generateKeyPairSync("ed25519").privateKey, eventKey: Buffer.alloc(32, 7) });
          const github = createFakeGitHub();
          const agentRead = createAgentReadTokens({ github,
            installationForRepository: async () => "7", revoke: async () => {} });
          const route = createAgentReadAccess({ work, agentRead });
          const request = () => new Request("https://paws/v1/runs/" + process.env.PROBE_RUN + "/github-read-credential", {
            method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.PROBE_TOKEN },
            body: JSON.stringify({ generation: Number(process.env.PROBE_GENERATION) })
          });
          for (let i = 0; i < 2; i++) {
            const response = await route(request(), process.env.PROBE_RUNNER);
            if (response?.status !== 200) throw new Error("credential status " + response?.status);
            if (!(await response.json()).token) throw new Error("missing credential");
          }
          if (github.minted.length !== 1) throw new Error("read lease minted more than once");
          const revoked = [];
          const mint = github.mintInstallationToken;
          github.mintInstallationToken = async (input) => {
            const token = await mint(input);
            await work.finish(process.env.PROBE_RUN, Number(process.env.PROBE_GENERATION));
            return token;
          };
          const racing = createAgentReadTokens({ github,
            installationForRepository: async () => "7", revoke: async (token) => { revoked.push(token); } });
          const fenced = await createAgentReadAccess({ work, agentRead: racing })(request(), process.env.PROBE_RUNNER);
          if (fenced?.status !== 409 || revoked.length !== 1) throw new Error("fenced mint was not revoked");

        } finally { await store.close(); }
      `,
        ],
        {
          env: {
            ...process.env,
            PROBE_DIR: dir,
            PROBE_RUN: command.runId,
            PROBE_RUNNER: f.runnerId,
            PROBE_TOKEN: token,
            PROBE_GENERATION: String(command.generation),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited, stderr).toBe(0);
    });
  } finally {
    await f.close();
  }
}, 60_000);

test("a Closeout check fenced after restart is placed again without a setup timeout", async () => {
  const f = await fixture();
  try {
    const stale = await shutDownMidCommand(f, f.checks);
    await restartWithRunnerHolding(f);
    await f.services.work.finish(stale.runId, stale.generation);
    const resumed = f.services.backend.forItem(f.item.id)(f.checks(new AbortController().signal));
    await f.until(() => f.placed.length === 2);
    const placed = f.placed[1]!;
    expect(placed.generation).toBe(stale.generation + 1);
    await f.finish(placed, { candidateSha: f.head, closeoutReport: REPORT });
    expect(await resumed).toMatchObject({ closeoutReport: REPORT });
  } finally {
    await f.close();
  }
}, 60_000);

test("a lease recovered after reattachment mint failure is redacted and revoked", async () => {
  const github = createFakeGitHub();
  const mint = github.mintInstallationToken;
  let fail = false;
  const failed = Promise.withResolvers<void>();
  github.mintInstallationToken = async (input) => {
    if (fail) {
      failed.resolve();
      throw new Error("transient mint failure");
    }
    return mint(input);
  };
  const revoked: string[] = [];
  const create = () =>
    createAgentReadTokens({
      github,
      installationForRepository: async () => "7",
      revoke: async (token) => {
        revoked.push(token);
      },
    });
  let tokens = create();
  const f = await fixture({
    open: (input) => tokens.open(input),
    tokens: (id) => tokens.tokens(id),
    close: (id) => tokens.close(id),
  });
  try {
    const withRead = (signal: AbortSignal) => ({
      ...f.checks(signal),
      githubRead: { prompt: READ_PROMPT },
    });
    const command = await shutDownMidCommand(f, withRead);
    await restartWithRunnerHolding(f);
    tokens = create();
    fail = true;
    const resumed = f.services.backend.forItem(f.item.id)(withRead(new AbortController().signal));
    await failed.promise;
    fail = false;
    const route = createAgentReadAccess({ work: f.services.work, agentRead: tokens });
    const response = await route(
      new Request(`https://paws/v1/runs/${command.runId}/github-read-credential`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await f.grant(command)}`,
        },
        body: JSON.stringify({ generation: command.generation }),
      }),
      f.runnerId,
    );
    expect(response?.status).toBe(200);
    const credential = (await response!.json()) as { token: string };
    await f.say(command, 2, credential.token);
    await f.until(async () => (await f.consumed()) === 2);
    await f.finish(command, { candidateSha: f.head, closeoutReport: REPORT });
    await resumed;
    expect(JSON.stringify(f.events)).not.toContain(credential.token);
    expect(
      readFileSync(
        join(runDir(f.root, withRead(new AbortController().signal).runId), "acp.jsonl"),
        "utf8",
      ),
    ).not.toContain(credential.token);
    expect(revoked).toEqual([credential.token, credential.token]);
    expect(tokens.tokens(command.id)).toEqual([]);
  } finally {
    await f.close();
  }
}, 60_000);
