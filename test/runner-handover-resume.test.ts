import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, gt, sql } from "drizzle-orm";
import { PawsShutdown } from "../src/core";
import { candidateRef, mirrorPath } from "../src/acp";
import { createAgentSessions, createFakeAgentSessionObjects } from "../src/agent-sessions";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  getWorkItem,
  insertQueuedItem,
  listRunnerOverview,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
  type Db,
  type Q,
} from "../src/db";
import { createRunnerControl, createRunnerSessionMoves } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import {
  QUESTION_ENDS_TURN_RUNNER_VERSION,
  verifyRunnerCommand,
  type RunnerCommand,
  type RunnerEvent,
} from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { tempStore } from "./pglite";

type RunCommand = Extract<RunnerCommand, { type: "run" }>;
type Setup = Awaited<ReturnType<typeof setup>>;

function setRunner(db: Db, id: string, values: Partial<Q["t"]["runner"]["$inferInsert"]>) {
  return db.run((q) => q.exec(q.orm.update(q.t.runner).set(values).where(eq(q.t.runner.id, id))));
}

function setAgentReady(db: Db, runnerId: string, ready: number) {
  return db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.runnerAgentPolicy)
        .set({ ready })
        .where(eq(q.t.runnerAgentPolicy.runnerId, runnerId)),
    ),
  );
}

function setRunnerVersion(db: Db, runnerId: string, runnerVersion: string) {
  return db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.runnerHostStatus)
        .set({ runnerVersion })
        .where(eq(q.t.runnerHostStatus.runnerId, runnerId)),
    ),
  );
}

function setWorkItem(db: Db, id: string, values: Partial<Q["t"]["workItem"]["$inferInsert"]>) {
  return db.run((q) =>
    q.exec(q.orm.update(q.t.workItem).set(values).where(eq(q.t.workItem.id, id))),
  );
}

function endRun(db: Db, id: string) {
  return db.run((q) =>
    q.exec(q.orm.update(q.t.run).set({ status: "ended" }).where(eq(q.t.run.id, id))),
  );
}

function insertQuestion(
  db: Db,
  values: { itemId: string; runId: string; sessionId: string; body: string; status: string },
) {
  return db.run((q) =>
    q.exec(
      q.orm
        .insert(q.t.question)
        .values({ id: workspaceId(), kind: "agent", createdAt: context.now, ...values }),
    ),
  );
}

function answerQuestion(db: Db, runId: string, answer: string) {
  return db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.question)
        .set({ status: "answered", answer })
        .where(eq(q.t.question.runId, runId)),
    ),
  );
}

function openedQuestion(db: Db, runId: string) {
  return db.run((q) =>
    q.one(
      q.orm
        .select({ answer: q.t.question.answer })
        .from(q.t.question)
        .where(eq(q.t.question.runId, runId)),
    ),
  );
}

function questionAnswers(db: Db, runId: string) {
  return db.run((q) =>
    q.all(
      q.orm
        .select()
        .from(q.t.runnerQuestionAnswer)
        .where(eq(q.t.runnerQuestionAnswer.runId, runId)),
    ),
  );
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "paws-handover-resume-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const { db, close } = await tempStore();
  const now = Date.now();
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = await issueWorkspaceBootstrap(db, "fixture-work", now);
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "fixture-work",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(bootstrap),
    now,
  });
  await db.run((q) =>
    q.exec(
      q.orm.insert(q.t.workspaceRepository).values({
        workspaceId: workspace.id,
        repository: "fixture/repository",
        teamId: "fixture-team",
      }),
    ),
  );
  const principal = {
    workspaceId: workspace.id,
    userId,
    role: "admin" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const issuer = join(root, "issuer");
  const control = createRunnerControl({
    store: db,
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
        token: (await control.createEnrollment(principal, pending)).token,
      })
    ).runnerId;
  }
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: signing.privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  const results = createRunnerResults({ store: db, work, now: () => now });
  const health = createRunnerHealth({ store: db, work, now: () => now });
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
  // Paws' bare mirror of the repository, and runner A's checkout of the same repository.
  const source = join(root, "source");
  git(["init", "-q", "-b", "main", source]);
  writeFileSync(join(source, "result.txt"), "base");
  git(["-C", source, "add", "."]);
  git(["-C", source, "commit", "-q", "-m", "Base"]);
  const base = git(["-C", source, "rev-parse", "HEAD"]);
  const paws = mirrorPath(root, "fixture", "repository");
  git(["clone", "-q", "--bare", source, paws]);
  const checkout = join(root, "runner-a");
  git(["clone", "-q", source, checkout]);
  const backend = createRemoteAgentRunner({
    store: db,
    work,
    results,
    health,
    now: () => now,
    pollIntervalMs: 1,
    placement: createRunnerPlacement({ store: db, now: () => now }),
    async fetchCandidate(candidate) {
      git(["-C", candidate.mirror, "fetch", "-q", checkout, candidate.candidateSha]);
      git(["-C", candidate.mirror, "update-ref", candidate.ref, candidate.candidateSha]);
    },
  });
  const seen = new Set<string>();
  /** The next command for `runnerId`, or null once `attempts` polls found none. */
  async function next(runnerId: string, attempts = 5000) {
    for (let index = 0; index < attempts; index++) {
      for (const envelope of await work.commands(runnerId)) {
        const verified = verifyRunnerCommand(envelope, {
          trustedKeys: new Map([["fixture", signing.publicKey]]),
          runnerId,
          workspaceId: workspace.id,
          now,
          allowedRepositories: ["fixture/repository"],
          claimCommand: (id) => !seen.has(id) && Boolean(seen.add(id)),
        });
        if (verified.ok) {
          await work.acknowledge(runnerId, verified.command.id);
          return verified.command;
        }
      }
      await delay(1);
    }
    return null;
  }
  const grant = async (command: RunCommand, runnerId: string) =>
    (
      await work.issueGrant({
        runnerId,
        runId: command.runId,
        commandId: command.id,
        generation: command.generation,
      })
    ).token;
  async function events(command: RunCommand, runnerId: string, list: RunnerEvent[]) {
    const token = await grant(command, runnerId);
    const after =
      (
        await db.run((q) =>
          q.one(
            q.orm
              .select({ sequence: q.t.runnerWork.lastSequence })
              .from(q.t.runnerWork)
              .where(
                and(
                  eq(q.t.runnerWork.runId, command.runId),
                  eq(q.t.runnerWork.generation, command.generation),
                ),
              ),
          ),
        )
      )?.sequence ?? 0;
    for (const [index, event] of list.entries())
      await work.event({
        runnerId,
        runId: command.runId,
        generation: command.generation,
        sequence: after + index + 1,
        token,
        event,
      });
  }
  async function submit(
    command: RunCommand,
    runnerId: string,
    extra: { handedOver?: true; candidateSha?: string },
  ) {
    await results.submit({
      runnerId,
      runId: command.runId,
      generation: command.generation,
      token: await grant(command, runnerId),
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
    const access = {
      runnerId: runners.a,
      runId: command.runId,
      token: await grant(command, runners.a),
    };
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
    await events(command, runners.a, [{ type: "handover", handedOver: true }]);
    await submit(command, runners.a, { handedOver: true, candidateSha: wip });
    return wip;
  }
  // A handed-over run waits for a runner until it stops, so every test stops its runs.
  const stops = new Set<AbortController>();
  let sequence = 0;
  /**
   * Both runners active, online and signed in to Claude; only A is free until `start` places.
   * With `alongside`, the runs already active keep running.
   */
  async function item(alongside = false) {
    if (!alongside) {
      git(["-C", checkout, "reset", "-q", "--hard", base]);
      await db.run(function* (q) {
        yield* q.exec(
          q.orm.update(q.t.run).set({ status: "ended" }).where(eq(q.t.run.status, "active")),
        );
        yield* q.exec(q.orm.delete(q.t.runnerCapacity));
      });
    }
    for (const runnerId of Object.values(runners)) {
      await setRunner(db, runnerId, { status: "active", ownerUserId: userId });
      await work.heartbeat(runnerId);
      await db.run(function* (q) {
        yield* q.exec(
          q.orm
            .insert(q.t.runnerHostStatus)
            .values({ runnerId, runnerVersion: "0.1.44", reportedAt: now })
            .onConflictDoUpdate({
              target: q.t.runnerHostStatus.runnerId,
              set: { runnerVersion: "0.1.44" },
            }),
        );
        yield* q.exec(
          q.orm.delete(q.t.runnerAgentPolicy).where(eq(q.t.runnerAgentPolicy.runnerId, runnerId)),
        );
        yield* q.exec(
          q.orm
            .insert(q.t.runnerAgentPolicy)
            .values({ runnerId, agent: "claude", ready: 1, authExpired: 0 }),
        );
        yield* q.exec(q.orm.delete(q.t.runnerAgent).where(eq(q.t.runnerAgent.runnerId, runnerId)));
        yield* q.exec(
          q.orm.insert(q.t.runnerAgent).values({
            runnerId,
            agent: "claude",
            version: "2.1.7",
            status: "current",
            reportedAt: now,
          }),
        );
      });
    }
    const id = `item-${++sequence}`;
    git(["--git-dir", paws, "update-ref", candidateRef(`display-${id}`), base]);
    const sessionKey = `session-${sequence}`;
    const record = await insertQueuedItem(db, { id, now, sessionKey });
    const { run } = await beginImplementRun(db, id, now);
    await recordLinearInstallation(db, {
      organizationId: "fixture-work",
      oauthClientId: "fixture-app",
      appUserId: "app-user",
      sessionId: sessionKey,
      teamId: "fixture-team",
      observedAtMs: now,
    });
    await bindLinearSessionTask(db, sessionKey, record.delegationId, {
      actorId: "owner",
    });
    await setWorkItem(db, id, { ownerUserId: userId });
    await bindWorkItemRepository(db, id, {
      owner: "fixture",
      repo: "repository",
      remoteUrl: "https://github.com/fixture/repository.git",
    });
    return { id, runId: run.id, sessionKey };
  }
  /** One turn of `record`, which runs until a runner finishes it or `stop` aborts it. */
  function turn(
    record: { id: string; runId: string },
    notices: string[],
    question?:
      | "answered"
      | "open"
      | "stale"
      | "waiting"
      | ((request: { question: string }) => Promise<{ answer: string }>),
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
        worktreePath: join(root, "workspace"),
        pawsRoot: root,
        networkGit: async () => "",
        signal: stop.signal,
        ...(question
          ? {
              askTeam: {
                // The question store records the question, answered or still open.
                async ask(request: { question: string }) {
                  if (question === "stale") throw new Error("Question owner is stale");
                  if (question === "waiting")
                    return await new Promise<never>((_, reject) =>
                      stop.signal.addEventListener("abort", () => reject(stop.signal.reason), {
                        once: true,
                      }),
                    );
                  if (typeof question === "function") return question(request);
                  await insertQuestion(db, {
                    itemId: record.id,
                    runId: record.runId,
                    sessionId: `session-${record.id}`,
                    body: request.question,
                    status: question,
                  });
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
  async function handOverTurn(
    whileMoving: () => Promise<unknown> = async () => {},
    question?: "answered" | "open",
  ) {
    const record = await item();
    const notices: string[] = [];
    const prompts: string[] = [];
    await setRunner(db, runners.b, { status: "paused" });
    const { running, stop } = turn(record, notices, question);
    const onA = (await next(runners.a)) as RunCommand;
    prompts.push(onA.prompt);
    await setRunner(db, runners.b, { status: "active" });
    await whileMoving();
    await events(onA, runners.a, [
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
      for (let index = 0; index < 5000 && !(await openedQuestion(db, record.runId)); index++)
        await delay(1);
    const handing = backend.handOverItem(record.id);
    const wip = await handOver(onA);
    expect(await handing).toEqual({ status: "handed_over", wipCommit: wip });
    return { record, onA, wip, notices, prompts, running, stop };
  }
  return {
    db,
    now,
    root,
    base,
    git,
    runners,
    backend,
    results,
    async answers(command: RunCommand, after = 0) {
      return results.answers({
        runnerId: runners.a,
        runId: command.runId,
        generation: command.generation,
        token: await grant(command, runners.a),
        after,
      });
    },
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
    async cleanup() {
      await close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let context: Setup;
beforeAll(async () => {
  context = await setup();
});
afterEach(() => context.stopAll());
afterAll(async () => {
  context.stopAll();
  await context.cleanup();
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
  await context.events(onB, runners.b, [{ type: "session_restore", restored: true }]);
  await context.submit(onB, runners.b, { candidateSha: wip });
  const result = await running;
  expect(result).toMatchObject({ stopReason: "end_turn", candidateSha: wip });
  expect((await getWorkItem(context.db, record.id))?.checkpoint?.wipCommit).toBe(wip);
  expect(notices.filter((notice) => notice.startsWith("Moved"))).toEqual([
    `Moved from A to B. Continuing the agent's session from turn ${onA.generation}.\n`,
  ]);
  expect(notices.some((notice) => notice.startsWith("Waiting"))).toBe(false);
});

test("a reviewer after a moved session never carries the implementer's native session", async () => {
  const { runners } = context;
  const { record, wip, running } = await context.handOverTurn();
  const onB = (await context.next(runners.b)) as RunCommand;
  expect(onB.restoreSession).toBeDefined();
  await context.events(onB, runners.b, [{ type: "session_restore", restored: true }]);
  await context.submit(onB, runners.b, { candidateSha: wip });
  await running;
  const stop = new AbortController();
  const reviewing = context.backend
    .forItem(record.id)({
      profile: { agent: "claude", model: "reviewer-model" },
      role: "reviewer",
      readOnly: true,
      itemId: `display-${record.id}`,
      runId: `rev-${record.id}-1`,
      prompt: "Review fixture",
      worktreePath: join(context.root, "workspace"),
      pawsRoot: context.root,
      signal: stop.signal,
    })
    .catch((error: unknown) => error);
  let review: RunnerCommand | null = null;
  for (let index = 0; index < 50 && !review; index++)
    review = (await context.next(runners.a, 20)) ?? (await context.next(runners.b, 20)) ?? null;
  stop.abort();
  await reviewing;
  for (const runner of [runners.a, runners.b]) while (await context.next(runner, 20));
  expect(review?.type).toBe("review");
  expect(review).not.toHaveProperty("restoreSession");
  expect(review).not.toHaveProperty("resumeSessionId");
});

test("with no eligible runner the session waits, says why once, and moves when one fits", async () => {
  const { db, runners } = context;
  const { onA, wip, notices, running } = await context.handOverTurn(() =>
    setAgentReady(db, runners.b, 0),
  );
  // Neither runner gets the work while B is signed out, and the run does not fail.
  expect(await context.next(runners.b, 300)).toBeNull();
  expect(await context.next(runners.a, 10)).toBeNull();
  expect(notices.filter((notice) => notice.startsWith("Waiting"))).toEqual([
    "Waiting to move this session from A: Sign in to Claude on another runner. Paws moves it as soon as a runner fits.\n",
  ]);
  expect(await Promise.race([running, delay(1, "waiting")])).toBe("waiting");
  await setAgentReady(db, runners.b, 1);
  const onB = (await context.next(runners.b)) as RunCommand;
  expect(onB.runId).toBe(onA.runId);
  expect(onB.repository.baseSha).toBe(wip);
  await context.submit(onB, runners.b, { candidateSha: wip });
  expect(await running).toMatchObject({ stopReason: "end_turn", candidateSha: wip });
  expect(notices.filter((notice) => notice.startsWith("Waiting"))).toHaveLength(1);
});

test("a run that stops while it waits for a runner ends with the stop, not a failure", async () => {
  const { db, runners } = context;
  const { running, stop, notices } = await context.handOverTurn(() =>
    setRunner(db, runners.b, { status: "paused" }),
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
  await context.submit(onB, runners.b, { candidateSha: wip });
  expect(await running).toMatchObject({ stopReason: "end_turn", candidateSha: wip });
});

test("a session still waiting on its question keeps it and does not move", async () => {
  const { runners } = context;
  const { running } = await context.handOverTurn(undefined, "open");
  expect(await running).toMatchObject({ handedOver: true });
  expect(await context.next(runners.b, 50)).toBeNull();
});

test("only a runner that ends the turn at a question is told to; an older one keeps the question in the turn", async () => {
  const { db, runners } = context;
  for (const [version, told] of [
    ["0.1.73", undefined],
    [QUESTION_ENDS_TURN_RUNNER_VERSION.join("."), true],
  ] as const) {
    const record = await context.item();
    await setRunner(db, runners.b, { status: "paused" });
    await setRunnerVersion(db, runners.a, version);
    const { running } = context.turn(record, [], "open");
    const onA = (await context.next(runners.a)) as RunCommand;
    expect(onA.questionEndsTurn).toBe(told);
    await context.submit(onA, runners.a, { candidateSha: context.base });
    expect(await running).toMatchObject({ stopReason: "end_turn" });
  }
});

test("a question that cannot be asked keeps the turn's work as a WIP commit before the cancel", async () => {
  const { db, runners } = context;
  const record = await context.item();
  await setRunner(db, runners.b, { status: "paused" });
  await setRunnerVersion(db, runners.a, "0.1.73");
  const { running } = context.turn(record, [], "stale");
  const onA = (await context.next(runners.a)) as RunCommand;
  await context.events(onA, runners.a, [
    { type: "question", text: "Which delimiter?", options: [] },
  ]);
  const checkpoint = await context.next(runners.a);
  expect(checkpoint).toMatchObject({ type: "checkpoint", runId: onA.runId });
  const wip = "a".repeat(40);
  await context.events(onA, runners.a, [{ type: "checkpoint", reason: "stop", sha: wip }]);
  expect(await context.next(runners.a)).toMatchObject({ type: "cancel", runId: onA.runId });
  expect(await running).toMatchObject({ message: "Question owner is stale" });
  expect((await getWorkItem(db, record.id))?.checkpoint?.wipCommit).toBe(wip);
});

test("a Paws shutdown while the run waits on its question keeps the turn's work before the cancel", async () => {
  const { db, runners } = context;
  const record = await context.item();
  await setRunner(db, runners.b, { status: "paused" });
  await setRunnerVersion(db, runners.a, "0.1.73");
  const { running, stop } = context.turn(record, [], "waiting");
  const onA = (await context.next(runners.a)) as RunCommand;
  await context.events(onA, runners.a, [
    { type: "question", text: "Which delimiter?", options: [] },
  ]);
  for (
    let index = 0;
    index < 5000 &&
    !(await db.run((q) =>
      q.one(
        q.orm
          .select({ runId: q.t.runnerWork.runId })
          .from(q.t.runnerWork)
          .where(and(eq(q.t.runnerWork.runId, onA.runId), gt(q.t.runnerWork.consumedSequence, 0))),
      ),
    ));
    index++
  )
    await delay(1);
  await setWorkItem(db, record.id, { state: "awaiting_input" });
  stop.abort(new PawsShutdown());
  expect(await context.next(runners.a)).toMatchObject({ type: "checkpoint", runId: onA.runId });
  const wip = "b".repeat(40);
  await context.events(onA, runners.a, [{ type: "checkpoint", reason: "stop", sha: wip }]);
  expect(await context.next(runners.a)).toMatchObject({ type: "cancel", runId: onA.runId });
  await running;
  expect((await getWorkItem(db, record.id))?.checkpoint?.wipCommit).toBe(wip);
});

test("after a restart the handed-over run still avoids the runner it left and waits", async () => {
  const { db, runners } = context;
  const { record, onA, wip, notices, stop, running } = await context.handOverTurn(() =>
    setRunner(db, runners.b, { status: "paused" }),
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
  await setRunner(db, runners.b, { status: "active" });
  const onB = (await context.next(runners.b)) as RunCommand;
  expect(onB.runId).toBe(onA.runId);
  expect(onB.repository.baseSha).toBe(wip);
  await context.submit(onB, runners.b, { candidateSha: wip });
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
async function card(runnerId: string) {
  return (
    (await listRunnerOverview(context.db, context.workspaceId, context.now)).find(
      (runner) => runner.id === runnerId,
    )?.running ?? []
  );
}

/** A turn running on A, with B paused until it lands there. */
async function runningOnA(notices: string[] = []) {
  const { db, runners } = context;
  const record = await context.item();
  await setRunner(db, runners.b, { status: "paused" });
  const { running } = context.turn(record, notices);
  const onA = (await context.next(runners.a)) as RunCommand;
  await setRunner(db, runners.b, { status: "active" });
  return { record, running, onA };
}

/** A ends the turn at the base commit, so the next test starts with A free. */
async function finish(onA: RunCommand, running: Promise<unknown>) {
  const base = context.base;
  await context.submit(onA, context.runners.a, { candidateSha: base });
  expect(await running).toMatchObject({ stopReason: "end_turn", candidateSha: base });
}

/** The move route over the fixture's backend; every request here is its route. */
function sessionMoves() {
  const moves = createRunnerSessionMoves({
    store: context.db,
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

test("an admin moves a session from its runner card, and it continues on the second runner", async () => {
  const { runners } = context;
  const moves = sessionMoves();
  const { record, running, onA } = await runningOnA();
  expect(await card(runners.a)).toMatchObject([{ runId: record.runId, movable: true, move: null }]);

  const response = await moves.fetch(moveRequest(runners.a, record.runId), context.principal);
  expect(response.status).toBe(202);
  expect((await card(runners.a))[0]?.move).toEqual({ status: "moving", reason: null });
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
  expect(await card(runners.a)).toEqual([]);
  expect(await card(runners.b)).toMatchObject([{ runId: record.runId, movable: true, move: null }]);
  expect(await context.next(runners.a, 10)).toBeNull();

  await context.submit(onB, runners.b, { candidateSha: wip });
  expect(await running).toMatchObject({ stopReason: "end_turn", candidateSha: wip });
});

test("with no eligible runner the card row says why, as Linear hears it", async () => {
  const { db, runners } = context;
  const moves = sessionMoves();
  const notices: string[] = [];
  const { record, onA } = await runningOnA(notices);
  await setAgentReady(db, runners.b, 0);
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
  expect(await card(runners.a)).toMatchObject([
    {
      runId: record.runId,
      movable: false,
      move: { status: "waiting", reason: "Sign in to Claude on another runner." },
    },
  ]);
});

test("a member's or inactive admin's move request is refused and the runner is not asked", async () => {
  const { db, runners } = context;
  const moves = sessionMoves();
  const { record, running, onA } = await runningOnA();
  // An inactive admin is refused like a member: only an active admin may move work.
  for (const [name, role, active] of [
    ["member", "member", true],
    ["inactive", "admin", false],
  ] as const) {
    const userId = await putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: `${name}-${record.id}`,
      name,
      email: `${name}-${record.id}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: context.workspaceId,
      userId,
      role,
      active,
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
      error: "Only workspace admins can move running work.",
    });
  }
  await moves.settled();
  expect(await card(runners.a)).toMatchObject([{ runId: record.runId, movable: true, move: null }]);
  expect(await context.next(runners.a, 50)).toBeNull();
  await finish(onA, running);
});

test("a session that is not running on that runner is not moved", async () => {
  const { runners } = context;
  const moves = sessionMoves();
  const { record, running, onA } = await runningOnA();
  const response = await moves.fetch(moveRequest(runners.b, record.runId), context.principal);
  expect(response.status).toBe(409);
  expect((await card(runners.a))[0]?.move).toBeNull();
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
    const record = await context.item(alongside);
    // Each runner has two slots, so both sessions fit on A and then on B.
    for (const runnerId of Object.values(runners))
      await db.run((q) =>
        q.exec(
          q.orm
            .insert(q.t.runnerCapacity)
            .values({ runnerId, capacity: 2 })
            .onConflictDoUpdate({ target: q.t.runnerCapacity.runnerId, set: { capacity: 2 } }),
        ),
      );
    await setRunner(db, runners.b, { status: "paused" });
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
  await setRunner(db, runners.a, { status: "draining" });
  await setRunner(db, runners.b, { status: "active" });
  expect(await card(runners.a)).toHaveLength(2);

  const response = await moves.fetch(moveAllRequest(runners.a), context.principal);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true, moving: 2 });
  // One move per session, each through the same path as Move to another runner.
  expect((await card(runners.a)).map((session) => session.move)).toEqual([
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
  expect(await card(runners.a)).toEqual([]);
  expect(
    (await card(runners.b))
      .map(({ runId, movable, move }) => ({ runId, movable, move }))
      .sort((left, right) => left.runId.localeCompare(right.runId)),
  ).toEqual(runIds.map((runId) => ({ runId, movable: true, move: null })));
  const overview = await listRunnerOverview(db, context.workspaceId, context.now);
  expect(overview.find((runner) => runner.id === runners.a)).toMatchObject({
    status: "draining",
    slots: { used: 0 },
    running: [],
  });
  expect(await context.next(runners.a, 10)).toBeNull();

  // B finishes both turns from their WIP commits.
  for (const [index, { onA, running }] of turns.entries()) {
    const onB = landed.find((command) => command.runId === onA.runId)!;
    await context.submit(onB, runners.b, { candidateSha: wips[index]! });
    expect(await running).toMatchObject({ stopReason: "end_turn" });
  }
});

test("with no eligible runner both sessions stay on the draining card with the reason", async () => {
  const { db, runners } = context;
  const moves = sessionMoves();
  const notices: string[] = [];
  const turns = await twoRunningOnA(notices);
  await setRunner(db, runners.a, { status: "draining" });
  await setRunner(db, runners.b, { status: "active" });
  await setAgentReady(db, runners.b, 0);
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
    (await card(runners.a))
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

test("Move running work needs a draining runner and an admin", async () => {
  const { db, runners } = context;
  const moves = sessionMoves();
  const { record, running, onA } = await runningOnA();
  const refused = await moves.fetch(moveAllRequest(runners.a), context.principal);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({
    error: "Drain this runner before moving all of its running work.",
  });
  await setRunner(db, runners.a, { status: "draining" });
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: `inactive-all-${record.id}`,
    name: "inactive",
    email: `inactive-all-${record.id}@example.invalid`,
  });
  await syncWorkspaceMember(db, {
    workspaceId: context.workspaceId,
    userId,
    role: "admin",
    active: false,
    teamIds: [],
    now: context.now,
  });
  const inactive = await moves.fetch(moveAllRequest(runners.a), {
    ...context.principal,
    userId,
    role: "admin",
  });
  expect(inactive.status).toBe(403);
  await moves.settled();
  expect(await card(runners.a)).toMatchObject([{ runId: record.runId, move: null }]);
  expect(await context.next(runners.a, 50)).toBeNull();
  await setRunner(db, runners.a, { status: "active" });
  await finish(onA, running);
});

test("the work turn after start_work waits for a slot on the session's runner, then resumes the same session", async () => {
  const { db, runners } = context;
  const record = await context.item();
  await setRunner(db, runners.b, { status: "paused" });
  const first = context.turn(record, []);
  const earlier = (await context.next(runners.a)) as RunCommand;
  await context.submit(earlier, runners.a, { candidateSha: context.base });
  expect(await first.running).toMatchObject({ stopReason: "end_turn" });
  // restart() ends the conversation's run; the work turn starts the item's next run.
  await endRun(db, record.runId);
  await setWorkItem(db, record.id, { state: "queued" });
  const next = {
    id: record.id,
    runId: (await beginImplementRun(db, record.id, context.now)).run.id,
  };

  // Another item takes A's only work slot; B stays paused.
  const busy = await context.item(true);
  await setRunner(db, runners.b, { status: "paused" });
  const other = context.turn(busy, []);
  const busyOnA = (await context.next(runners.a)) as RunCommand;
  expect(busyOnA.runId).toBe(busy.runId);

  // With every work slot busy the turn takes none: the resume job waits in line for a slot.
  const waiting = context.turn(next, []);
  expect(String(await waiting.running)).toBe(
    `RunnerCapacityWait: Waiting for a free slot on runner ${runners.a}`,
  );
  expect(await context.next(runners.a, 50)).toBeNull();
  expect(await context.next(runners.b, 50)).toBeNull();

  await context.submit(busyOnA, runners.a, { candidateSha: context.base });
  await other.running;
  await endRun(db, busy.runId);
  const work = context.turn(next, []);
  const onA = (await context.next(runners.a)) as RunCommand;
  expect(onA).toMatchObject({
    type: "run",
    runId: next.runId,
    resumeSessionId: "claude-session",
  });
  expect(onA.checkpoint).not.toBe(false);
  await context.submit(onA, runners.a, { candidateSha: context.base });
  expect(await work.running).toMatchObject({ stopReason: "end_turn" });
});

test("replayed questions attach to the open answer without asking or cancelling again", async () => {
  const { db, runners } = context;
  const record = await context.item();
  await setRunner(context.db, runners.b, { status: "paused" });
  let asks = 0;
  const ask = async (request: { question: string }) => {
    asks++;
    await insertQuestion(db, {
      itemId: record.id,
      runId: record.runId,
      sessionId: record.id,
      body: request.question,
      status: "open",
    });
    for (;;) {
      const row = await openedQuestion(db, record.runId);
      if (row?.answer) return { answer: row.answer };
      await delay(1);
    }
  };
  const first = context.turn(record, [], ask);
  const command = (await context.next(runners.a)) as RunCommand;
  const event = { type: "question" as const, text: "Which delimiter?", options: [] };
  await context.events(command, runners.a, [event]);
  for (let i = 0; i < 5000; i++) {
    if (asks > 0) break;
    await delay(1);
  }
  // Replay while the first ask is still waiting on its answer.
  await context.events(command, runners.a, [event, event]);
  expect(await context.next(runners.a, 50)).toBeNull();
  expect(asks).toBe(1);
  await answerQuestion(db, record.runId, "Use commas.");
  for (let i = 0; i < 1000; i++) {
    if (await context.results.answered(command.runId, command.generation, 3)) break;
    await delay(1);
  }
  expect(await context.results.answered(command.runId, command.generation, 1)).toBe("Use commas.");
  expect(await questionAnswers(db, record.runId)).toHaveLength(3);
  expect(
    (await context.answers(command)).map(({ sequence, answer }) => ({ sequence, answer })),
  ).toEqual([1, 2, 3].map((sequence) => ({ sequence, answer: "Use commas." })));
  expect(await context.answers(command, 3)).toEqual([]);
  // A later answered request must not be held behind an unanswered duplicate.
  await context.events(command, runners.a, [
    { type: "question", text: "Which encoding?", options: [] },
  ]);
  await context.results.answer({
    runId: command.runId,
    generation: command.generation,
    sequence: 4,
    answer: "UTF-8",
  });
  expect(await context.answers(command, 3)).toEqual([{ sequence: 4, answer: "UTF-8" }]);
  expect(await context.next(runners.a, 50)).toBeNull();
  expect(asks).toBe(1);
  await context.submit(command, runners.a, { candidateSha: context.base });
  expect(await first.running).toMatchObject({ stopReason: "end_turn" });
});

test("different text while a question is open still fails as overlapping questions", async () => {
  const { runners } = context;
  const record = await context.item();
  await setRunner(context.db, runners.b, { status: "paused" });
  let release!: (answer: { answer: string }) => void;
  const turn = context.turn(
    record,
    [],
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const command = (await context.next(runners.a)) as RunCommand;
  await context.events(command, runners.a, [
    { type: "question", text: "Which delimiter?", options: [] },
    { type: "question", text: "Which encoding?", options: [] },
  ]);
  expect(await context.next(runners.a)).toMatchObject({ type: "cancel" });
  release({ answer: "Unused after cancellation" });
  expect(String(await turn.running)).toContain("overlapping questions");
});

test("a replay attaches to a question already stored by an earlier attachment", async () => {
  const { db, runners } = context;
  const record = await context.item();
  await setRunner(context.db, runners.b, { status: "paused" });
  await insertQuestion(db, {
    itemId: record.id,
    runId: record.runId,
    sessionId: record.sessionKey,
    body: "Which delimiter?",
    status: "open",
  });
  // Opening the question bumped the item version; that alone must not make the replay stale.
  await db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.workItem)
        .set({ version: sql`${q.t.workItem.version} + 1` })
        .where(eq(q.t.workItem.id, record.id)),
    ),
  );
  let asks = 0;
  const turn = context.turn(record, [], async () => {
    asks++;
    throw new Error("Question owner is stale");
  });
  const command = (await context.next(runners.a)) as RunCommand;
  await context.events(command, runners.a, [
    { type: "question", text: "Which delimiter?", options: [] },
  ]);
  expect(await context.next(runners.a, 50)).toBeNull();
  expect(asks).toBe(0);
  // The first sequence was consumed before Paws restarted; the runner replays at sequence 2.
  turn.stop.abort(new PawsShutdown());
  await turn.running;
  const resumed = context.turn(record, [], "stale");
  await context.events(command, runners.a, [
    { type: "question", text: "Which delimiter?", options: [] },
  ]);
  expect(await context.next(runners.a, 50)).toBeNull();
  await answerQuestion(db, record.runId, "Use commas.");
  for (let i = 0; i < 1000; i++) {
    if (await context.results.answered(command.runId, command.generation, 2)) break;
    await delay(1);
  }
  expect(await context.results.answered(command.runId, command.generation, 1)).toBe("Use commas.");
  expect(await questionAnswers(db, record.runId)).toHaveLength(2);
  expect(await context.next(runners.a, 50)).toBeNull();
  await context.submit(command, runners.a, { candidateSha: context.base });
  expect(
    (await context.answers(command)).map(({ sequence, answer }) => ({ sequence, answer })),
  ).toEqual([1, 2].map((sequence) => ({ sequence, answer: "Use commas." })));
  expect(await context.answers(command, 2)).toEqual([]);
  expect(await resumed.running).toMatchObject({ stopReason: "end_turn" });
});

for (const [owner, change] of [
  ["is cancelled", { cancelRequested: 1 }],
  ["has no current run", { currentRunId: null }],
] as const) {
  test(`a replay gets no answer when the item ${owner}, before or after attaching`, async () => {
    for (const whileAttached of [false, true]) {
      const { db, runners } = context;
      const record = await context.item();
      await setRunner(db, runners.b, { status: "paused" });
      await insertQuestion(db, {
        itemId: record.id,
        runId: record.runId,
        sessionId: record.sessionKey,
        body: "Which delimiter?",
        status: "open",
      });
      let asks = 0;
      const turn = context.turn(record, [], async () => {
        asks++;
        return { answer: "Never asked." };
      });
      const command = (await context.next(runners.a)) as RunCommand;
      const stale = () => setWorkItem(db, record.id, change);
      await context.events(command, runners.a, [
        { type: "question", text: "Which delimiter?", options: [] },
      ]);
      // Nothing awaits before this `stale()`, so the backend has not read the event yet.
      if (!whileAttached) await stale();
      else {
        expect(await context.next(runners.a, 50)).toBeNull();
        await stale();
        await answerQuestion(db, record.runId, "Too late.");
      }
      expect(await context.next(runners.a)).toMatchObject({ type: "cancel" });
      // The run's lease checks may refuse this turn before the question owner check does.
      expect(await turn.running).toBeInstanceOf(Error);
      expect(asks).toBe(0);
      expect(await questionAnswers(db, record.runId)).toEqual([]);
    }
  });
}

test("a replay fails as stale when the open question belongs to an earlier session", async () => {
  const { db, runners } = context;
  const record = await context.item();
  await setRunner(db, runners.b, { status: "paused" });
  await insertQuestion(db, {
    itemId: record.id,
    runId: record.runId,
    sessionId: "earlier-session",
    body: "Which delimiter?",
    status: "open",
  });
  let asks = 0;
  const turn = context.turn(record, [], async () => {
    asks++;
    return { answer: "Never asked." };
  });
  const command = (await context.next(runners.a)) as RunCommand;
  await context.events(command, runners.a, [
    { type: "question", text: "Which delimiter?", options: [] },
  ]);
  expect(await context.next(runners.a)).toMatchObject({ type: "cancel" });
  expect(await turn.running).toMatchObject({ message: "Question owner is stale" });
  expect(asks).toBe(0);
  expect(await questionAnswers(db, record.runId)).toEqual([]);
});
