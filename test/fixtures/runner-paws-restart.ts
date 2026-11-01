import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spyOn } from "bun:test";
import * as acp from "../../src/acp";
import * as loop from "../../src/loop";
import { startPaws } from "../../src/index";
import {
  beginImplementRun,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  listWorkItems,
  putWorkspaceUser,
  recordLinearInstallation,
  saveTaskMode,
  setJournalSink,
} from "../../src/db";
import { JOB_KIND } from "../../src/core";
import { loadConfigFile, resolveAgentProfiles } from "../../src/config";
import { createFakeTracker } from "../../src/linear";
import { createFakeGitHub } from "../../src/github";
import { createRemoteAgentRunner } from "../../src/runner-backend";
import { createRunnerControl } from "../../src/runner-control";
import { createRunnerHealth } from "../../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../../src/runner-identity";
import { createRunnerPlacement } from "../../src/runner-placement";
import { RunnerRequestError } from "../../src/runner-daemon";
import { readRunnerJob } from "../../src/runner-execution";
import type { RunnerCommand, RunnerResult } from "../../src/runner-protocol";
import { createRunnerResults } from "../../src/runner-results";
import { openRunnerRuntime } from "../../src/runner-runtime";
import { createRunnerWork, RUNNER_LIVE_GRACE_MS, runnerFailureStatus } from "../../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../../src/workspace";
import { githubClient } from "../e2e-harness";
import { workspaceAdmission } from "../fake-workspace";
import { runtimeProcess } from "./runner-runtime-process";

setJournalSink(() => {});
// Match CI even when the parent runner has a restrictive umask.
process.umask(0o022);
const root = process.argv[2]!;
const home = join(root, "paws");
const source = join(root, "source");
const origin = join(root, "origin.git");
const remoteUrl = "https://github.com/pmdroid/paws-demo.git";
const identity = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
Object.assign(process.env, identity);
const realGit = acp.git;
const git = (args: string[]) =>
  realGit(args, { env: { ...process.env, ...identity } }).then((s) => s.trim());
// Every GitHub Git operation goes to the disposable bare repository.
spyOn(acp, "git").mockImplementation((args, options) =>
  realGit(
    args.map((arg) => (arg === remoteUrl ? origin : arg)),
    {
      ...options,
      env: { ...(options?.env ?? process.env), ...identity, GIT_ALLOW_PROTOCOL: "file" },
    },
  ),
);
globalThis.fetch = Object.assign(
  async () => {
    throw new Error("External HTTP is forbidden");
  },
  { preconnect() {} },
);
await git(["init", "-b", "main", source]);
mkdirSync(join(source, ".agents/skills/review"), { recursive: true });
writeFileSync(
  join(source, ".agents/skills/review/SKILL.md"),
  "Review the candidate and report findings.\n",
);
writeFileSync(
  join(source, ".agents/closeout.yaml"),
  JSON.stringify({
    specVersion: "0.1",
    items: [
      {
        id: "review",
        kind: "review",
        gate: "beforePR",
        skill: ".agents/skills/review/SKILL.md",
        independence: { differentSession: true, differentModel: true },
        failOn: "P1",
      },
    ],
  }),
);
writeFileSync(join(source, "app.txt"), "base\n");
await git(["-C", source, "add", "."]);
await git(["-C", source, "commit", "-m", "Base"]);
const base = await git(["-C", source, "rev-parse", "HEAD"]);
await git(["clone", "--bare", source, origin]);
writeFileSync(join(source, "app.txt"), "candidate\n");
await git(["-C", source, "commit", "-am", "Candidate"]);
const head = await git(["-C", source, "rev-parse", "HEAD"]);
await git(["-C", source, "bundle", "create", join(root, "candidate.bundle"), "HEAD", `^${base}`]);
mkdirSync(home, { recursive: true });
writeFileSync(
  join(home, "config.toml"),
  '[agents.defaults.implementer]\nagent = "claude"\nmodel = "implement-model"\n[agents.defaults.reviewer]\nagent = "codex"\nmodel = "review-model"\n',
);
assert.deepEqual(resolveAgentProfiles(loadConfigFile(join(home, "config.toml"))), {
  implementer: { agent: "claude", model: "implement-model" },
  reviewer: { agent: "codex", model: "review-model" },
});

const tracker = createFakeTracker();
const github = createFakeGitHub();
const signing = generateKeyPairSync("ed25519");
let services!: {
  work: ReturnType<typeof createRunnerWork>;
  results: ReturnType<typeof createRunnerResults>;
  health: ReturnType<typeof createRunnerHealth>;
};
let orchestrator!: ReturnType<typeof loop.attachOrchestrator>;
const attach = loop.attachOrchestrator;
spyOn(loop, "attachOrchestrator").mockImplementation((options) => {
  const { db, jobs, outbox } = options;
  const work = createRunnerWork({ db, keyId: "fixture", privateKey: signing.privateKey });
  const results = createRunnerResults({ db, work });
  const health = createRunnerHealth({ db, work });
  services = { work, results, health };
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    placement: createRunnerPlacement({ db }),
    pollIntervalMs: 5,
    async fetchCandidate(input) {
      await git(["-C", input.worktree, "fetch", origin, input.candidateSha]);
      await git(["-C", input.worktree, "reset", "--hard", input.candidateSha]);
    },
    transcripts: {
      async download(runId) {
        return Buffer.from(transcripts.get(runId) ?? "");
      },
    },
  });
  orchestrator = attach({
    db,
    jobs,
    outbox,
    pawsRoot: home,
    home,
    tracker,
    admission: workspaceAdmission(db),
    linearTaskModes: true,
    outboxWaitMs: 50,
    repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl }],
    repositoryToken: async () => "fixture",
    githubForRepository: () => ({
      appId: "",
      installationId: "",
      privateKeyPem: "",
      tokenProvider: { mode: "token", tokenFor: async () => "fixture" },
      client: githubClient(origin, github),
    }),
    remoteExecution: {
      agentForItem: (id) => backend.forItem(id),
      agentForSession() {
        throw new Error("Unexpected routing helper");
      },
      cancelItem: (id) => backend.cancelItem(id),
      runInProgress: async (id) => backend.runInProgress(id),
    },
    launch() {
      return { command: "/forbidden-local-agent", args: [] };
    },
  });
  return orchestrator;
});
const transcripts = new Map<string, string>();
const start = () =>
  startPaws(
    { PAWS_HOME: home, PAWS_PORT: "0" },
    { refreshAgentCatalog: false, refreshRepositories: false },
  );
let paws = start();
await paws.ready;
const userId = putWorkspaceUser(paws.db, {
  id: workspaceId(),
  linearUserId: "owner",
  name: "Owner",
  email: "owner@example.invalid",
});
const workspace = consumeWorkspaceBootstrap(paws.db, {
  id: workspaceId(),
  organizationId: "org",
  name: "Fixture",
  userId,
  tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(paws.db, "org", Date.now())),
  now: Date.now(),
});
paws.db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
  workspace.id,
  "pmdroid/paws-demo",
  "team",
]);
const issuer = join(root, "issuer");
const control = createRunnerControl({
  db: paws.db,
  authority: await initializeRunnerAuthority(issuer),
  certificateRoot: issuer,
  disconnect() {},
});
const enrollment = { name: "fixture", csr: (await createRunnerKey(join(root, "client"))).csr };
const { runnerId } = await control.enroll({
  ...enrollment,
  token: control.createEnrollment(
    { workspaceId: workspace.id, userId, role: "admin", authenticatedAt: Date.now(), teamIds: [] },
    enrollment,
  ).token,
});
paws.db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
paws.db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
for (const agent of ["claude", "codex"])
  paws.db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,1)", [
    runnerId,
    agent,
  ]);

let down = false;
let offlineCalls = 0;
let duplicateEvents = 0;
const lostEventReceipts = new Set<string>();
const reachable = () => {
  if (down) {
    offlineCalls++;
    throw new RunnerRequestError(503, "POST", "/fixture");
  }
};
let pending: RunnerCommand[] = [];
const commands = new Map<string, RunnerCommand>();
const accepted: RunnerResult[] = [];
const executions = new Map<string, string>();
const finished = new Set<string>();
const stopped = new Set<string>();
let stops = 0;
const errors: string[] = [];
const runnerRoot = join(root, "runner");
mkdirSync(runnerRoot, { mode: 0o700 });
const spool = {
  root: join(runnerRoot, "spool"),
  runnerUid: process.getuid!(),
  agentGid: process.getgid!(),
};
const resultFiles = {
  root: join(runnerRoot, "results"),
  agentUid: process.getuid!(),
  resultsGid: process.getgid!(),
};
for (const directory of [spool.root, resultFiles.root]) {
  mkdirSync(directory);
  chmodSync(directory, 0o750);
}
const paired = {
  phase: "paired" as const,
  runnerId,
  workspaceId: workspace.id,
  fingerprint: "fixture",
  expiresAt: Date.now() + 3_600_000,
};
function result(command: RunnerCommand, executionId: string) {
  assert("profile" in command && command.profile.model, "Fixture commands need a pinned model");
  return {
    executionId,
    commandId: command.id,
    role: command.type === "review" ? ("reviewer" as const) : ("implementer" as const),
    stopReason: "end_turn" as const,
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    identity: {
      session: `session-${command.id}`,
      model: command.profile.model,
      provider: "fixture",
    },
  };
}
let preparing = false;
let releasePreparation: (() => void) | undefined;
let preparationGate: Promise<void> | undefined;
let releaseCleanup: (() => void) | undefined;
let cleanupGate: Promise<void> | undefined;
let cleanupEntered = false;
let heartbeats = 0;
const runtimeOptions: Parameters<typeof openRunnerRuntime>[0] = {
  root: runnerRoot,
  spool,
  results: resultFiles,
  repositoryRoot: join(runnerRoot, "repositories"),
  home: runnerRoot,
  resultRetryMs: 0,
  onError: (e) => errors.push(e.message),
  networkGit: async (input) => {
    if (input.operation === "clone") await git(["clone", "--bare", origin, input.dest!]);
    else if (input.operation === "fetch")
      await git(["-C", input.dest!, "fetch", origin, "+refs/heads/*:refs/heads/*"]);
    else await git(["-C", input.cwd, "push", origin, input.refspec!]);
  },
  broker: {
    async start(id) {
      const { command } = readRunnerJob(spool, id);
      assert(!executions.has(command.id), "a command must start only one worker");
      executions.set(command.id, id);
      const directory = join(resultFiles.root, id);
      mkdirSync(directory);
      chmodSync(directory, 0o750);
      writeFileSync(join(directory, "events.jsonl"), "", { mode: 0o640 });
      chmodSync(join(directory, "events.jsonl"), 0o640);
      return { alreadyAdmitted: false };
    },
    async stop(id) {
      if (cleanupGate) cleanupEntered = true;
      await cleanupGate;
      stopped.add(id);
      if (!finished.has(id)) stops++;
    },
    alive: (id) => !finished.has(id) && !stopped.has(id),
  },
  daemon: {
    status: () => paired,
    async heartbeat(skills, runtimes, agents, live) {
      reachable();
      heartbeats++;
      return services.work.heartbeat(
        runnerId,
        1,
        { runnerVersion: "9.0.0" },
        undefined,
        skills,
        runtimes,
        agents,
        live,
      );
    },
    async pollCommands() {
      reachable();
      for (const envelope of services.work.commands(runnerId)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        commands.set(command.id, command);
        if (command.type === "probe") {
          services.work.acknowledge(runnerId, command.id);
          services.health.submit(runnerId, result(command, workspaceId()));
        } else if (!pending.some((c) => c.id === command.id)) pending.push(command);
      }
      return { commands: pending, rejected: [], deniedRepositories: [] };
    },
    pendingCommands: () => pending,
    async acknowledgeCommand(id) {
      reachable();
      services.work.acknowledge(runnerId, id);
      pending = pending.filter((c) => c.id !== id);
    },
    async issueRunGrant(runId, request) {
      reachable();
      try {
        return services.work.issueGrant({ runnerId, runId, ...request });
      } catch (error) {
        throw new RunnerRequestError(
          runnerFailureStatus(error),
          "POST",
          "/grant",
          0,
          String(error),
        );
      }
    },
    async sendEvent(event, token) {
      reachable();
      const receipt = services.work.event({ runnerId, token, ...event });
      if (receipt.duplicate) duplicateEvents++;
      if (!lostEventReceipts.has(`${event.runId}:${event.generation}`)) {
        lostEventReceipts.add(`${event.runId}:${event.generation}`);
        throw new RunnerRequestError(503, "POST", "/events");
      }
      return receipt;
    },
    async answers() {
      reachable();
      return { answers: [] };
    },
    async postResult(runId, generation, value, token) {
      reachable();
      const receipt = services.results.submit({
        runnerId,
        runId,
        generation,
        result: value,
        token,
      });
      if (!receipt.duplicate) accepted.push(value);
      // Lose the first receipt, requiring runtime replay of the same immutable result.
      if (!receipt.duplicate) throw new RunnerRequestError(503, "POST", "/result");
      return receipt;
    },
    async repositoryCredential(runId) {
      reachable();
      if (preparationGate) {
        preparing = true;
        await preparationGate;
      }
      const item = listWorkItems(paws.db).find((i) => i.currentRunId === runId)!;
      return {
        token: "fixture",
        expiresAt: Date.now() + 60_000,
        remoteUrl,
        branch: item.branchName,
      };
    },
    async renewCertificate() {
      reachable();
      return paired;
    },
    async uploadArtifact() {
      throw new Error("Unexpected artifact");
    },
    async uploadTranscript(runId, chunk) {
      reachable();
      const previous = transcripts.get(runId) ?? "";
      const bytes = Buffer.from(chunk.data, "base64").toString();
      transcripts.set(runId, previous + bytes);
      return { offset: chunk.offset, duplicate: false };
    },
    async finishTranscript() {
      reachable();
      return { uri: "transcript" };
    },
  },
};
const runnerRestart = process.argv[3];
let runtime = runnerRestart
  ? await runtimeProcess(runtimeOptions)
  : await openRunnerRuntime(runtimeOptions);

async function until(label: string, done: () => boolean) {
  const deadline = performance.now() + 12_000;
  while (!done() && performance.now() < deadline) {
    await runtime.tick();
    await Bun.sleep(5);
  }
  assert(
    done(),
    `${label}: ${JSON.stringify({ errors, items: listWorkItems(paws.db), commands: [...commands.values()], activities: listOutbox(paws.db).map((row) => row.payload) })}`,
  );
}
function addItem(id: string, answer = false) {
  const sessionKey = `session-${id}`;
  const item = insertQueuedItem(paws.db, { id, sessionKey, now: Date.now() });
  recordLinearInstallation(paws.db, {
    organizationId: "org",
    oauthClientId: "app",
    appUserId: "app-user",
    sessionId: sessionKey,
    teamId: "team",
    observedAtMs: Date.now(),
  });
  bindLinearSessionTask(paws.db, sessionKey, item.delegationId, { actorId: "owner" });
  paws.db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, id]);
  if (answer) saveTaskMode(paws.db, id, "answer");
  else bindWorkItemRepository(paws.db, id, { owner: "pmdroid", repo: "paws-demo", remoteUrl });
  const { run } = beginImplementRun(paws.db, id, Date.now());
  enqueueJob(paws.db, {
    queue: JOB_KIND.resume,
    payload: { itemId: id, runId: run.id, freshSession: true },
  });
  return id;
}
function activeCommand(type: string) {
  return [...commands.values()].find(
    (c) =>
      c.type === type &&
      executions.has(c.id) &&
      !stopped.has(executions.get(c.id)!) &&
      !accepted.some((r) => r.commandId === c.id),
  );
}
// Permission notices are public activities without post_update's intentional throttle.
// Message chunks also exercise the transcript restored for the final answer.
function say(command: RunnerCommand, text: string) {
  const id = executions.get(command.id)!;
  appendFileSync(
    join(resultFiles.root, id, "events.jsonl"),
    JSON.stringify({
      type: "acp",
      event: { type: "permission", toolCallId: text, decision: "deny", reason: text, title: text },
    }) +
      "\n" +
      JSON.stringify({
        type: "acp",
        event: {
          type: "session_update",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      }) +
      "\n",
  );
}
function finish(command: RunnerCommand) {
  const id = executions.get(command.id)!;
  const candidate = command.type === "run";
  if (candidate)
    writeFileSync(
      join(resultFiles.root, id, "candidate.bundle"),
      readFileSync(join(root, "candidate.bundle")),
      { mode: 0o640 },
    );
  writeFileSync(
    join(resultFiles.root, id, "result.json"),
    JSON.stringify({
      executionId: id,
      commandId: command.id,
      run: result(command, id),
      ...(candidate ? { candidateSha: head } : {}),
      ...(command.type === "review" ? { reviewText: "[]" } : {}),
    }),
    { mode: 0o640 },
  );
  for (const file of command.type === "run" ? ["result.json", "candidate.bundle"] : ["result.json"])
    chmodSync(join(resultFiles.root, id, file), 0o640);
  finished.add(id);
}
async function restartMidTurn(command: RunnerCommand) {
  assert(command.type === "run" || command.type === "review" || command.type === "task");
  const execution = executions.get(command.id)!;
  const consumed = () =>
    paws.db
      .query<{ n: number }, [string]>(
        "SELECT consumed_sequence AS n FROM runner_work WHERE command_id=?",
      )
      .get(command.id)!.n;
  const previous = consumed();
  say(command, `Before restart ${command.id}.`);
  await until("activity consumed", () => consumed() > previous);
  await paws.stop();
  down = true;
  // Keep ticking the same runtime while its coordinator and database are closed.
  for (let i = 0; i < 3; i++) {
    await runtime.tick();
    await Bun.sleep(100);
  }
  assert(offlineCalls > 0);
  assert.equal(stops, 0);
  assert.equal(
    (runtime as Awaited<ReturnType<typeof openRunnerRuntime>>).status().active?.executionId,
    execution,
  );
  say(command, `After restart ${command.id}.`);
  finish(command);
  await runtime.tick();
  assert(!accepted.some((r) => r.commandId === command.id));
  paws = start();
  await paws.ready;
  down = false;
  assert.equal(getWorkItem(paws.db, command.itemId)?.recoveryAttempts, 0);
  await until("original result accepted", () => accepted.some((r) => r.commandId === command.id));
  assert.equal(executions.get(command.id), execution);
  assert.equal(accepted.filter((r) => r.commandId === command.id).length, 1);
  assert.equal(stops, 0);
}
try {
  if (runnerRestart) {
    const preparation = process.argv[4] === "preparing";
    if (preparation)
      preparationGate = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
    const code = addItem("runner-restart");
    await until("turn interrupted at requested phase", () =>
      preparation ? preparing : !!activeCommand("run"),
    );
    const old = [...commands.values()].find((c) => c.type === "run")!;
    assert(old.type === "run");
    const oldExecution = executions.get(old.id);
    const branch = getWorkItem(paws.db, code)?.branchName;
    assert(
      paws.db
        .query("SELECT 1 FROM runner_command WHERE id=? AND acknowledged_at IS NOT NULL")
        .get(old.id),
    );
    // The turn has been running for longer than the grace Paws gives a fresh acknowledgment.
    paws.db.run("UPDATE runner_command SET acknowledged_at=? WHERE id=?", [
      Date.now() - 2 * RUNNER_LIVE_GRACE_MS,
      old.id,
    ]);
    const beforeHeartbeat = heartbeats;
    const beforeExecutions = executions.size;
    const beforeAccepted = accepted.length;
    cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let opened = false;
    let reopening: Promise<Awaited<ReturnType<typeof runtimeProcess>>>;
    if (runnerRestart === "crash") {
      await (runtime as Awaited<ReturnType<typeof runtimeProcess>>).crash();
      releasePreparation?.();
      preparationGate = undefined;
      reopening = runtimeProcess(runtimeOptions).then((value) => {
        opened = true;
        return value;
      });
    } else {
      const stopping = runtime.stop();
      releasePreparation?.();
      preparationGate = undefined;
      reopening = stopping
        .then(() => runtimeProcess(runtimeOptions))
        .then((value) => {
          opened = true;
          return value;
        });
    }
    const observedCleanup = () => cleanupEntered;
    for (let i = 0; i < 2000 && !observedCleanup(); i++) await Bun.sleep(5);
    assert(cleanupEntered, "restart must reach broker cleanup");
    runtime = await reopening;
    assert(opened, "restart keeps heartbeats running while cleanup is unconfirmed");
    for (let i = 0; i < 5; i++) await runtime.tick();
    assert(heartbeats > beforeHeartbeat, "heartbeats continue while cleanup is unconfirmed");
    assert.equal(executions.size, beforeExecutions, "no new worker before confirmed cleanup");
    assert.equal(accepted.length, beforeAccepted);
    releaseCleanup!();
    cleanupGate = undefined;
    await until(
      "replacement implementation",
      () => !!activeCommand("run") && activeCommand("run")!.id !== old.id,
    );
    const replacement = activeCommand("run")!;
    assert(replacement.type === "run");
    assert.equal(getWorkItem(paws.db, code)?.branchName, branch);
    assert(!accepted.some((r) => r.commandId === old.id));
    assert(replacement.generation > old.generation);
    assert.notEqual(getWorkItem(paws.db, code)?.state, "failed");
    if (oldExecution) assert(stops > 0, "old worker must be stopped before replacement");
    finish(replacement);
    await until("reviewer after recovery", () => !!activeCommand("review"));
    finish(activeCommand("review")!);
    await until("pull request after recovery", () => github.opened.length === 1);
    assert.equal(getWorkItem(paws.db, code)?.acceptedHead, head);
    const activities = listOutbox(paws.db).map((row) => JSON.stringify(row.payload));
    assert(activities.some((body) => body.includes("continuing from the branch")));
    assert(!activities.some((body) => body.includes("The runner stopped this run")));
    console.log("runner restart integration passed");
  } else {
    const code = addItem("code");
    await until("implementer running", () => !!activeCommand("run"));
    await restartMidTurn(activeCommand("run")!);
    await until("reviewer running", () => !!activeCommand("review"));
    await restartMidTurn(activeCommand("review")!);
    await until("one pull request published", () => github.opened.length === 1);
    const answer = addItem("answer", true);
    await until("answer running", () => !!activeCommand("task"));
    await restartMidTurn(activeCommand("task")!);
    await until("answer completed", () => getWorkItem(paws.db, answer)?.state === "completed");
    assert.equal(github.opened.length, 1);
    assert.equal(getWorkItem(paws.db, code)?.acceptedHead, head);
    assert.equal(stops, 0);
    assert.equal(paws.db.query("SELECT 1 FROM runner_command WHERE kind='cancel'").all().length, 0);
    assert.equal(executions.size, 3);
    assert.equal(
      paws.db.query("SELECT 1 FROM runner_command WHERE kind IN ('run','review','task')").all()
        .length,
      3,
    );
    assert.equal(accepted.length, 3);
    assert(duplicateEvents >= 3, "lost event receipts must replay across restarts");
    for (const value of accepted) {
      assert.equal(value.stopReason, "end_turn");
      assert.equal(value.cancelled, false);
      assert.equal(value.agentExited, true);
      assert.equal(
        paws.db.query("SELECT 1 FROM runner_result WHERE command_id=?").all(value.commandId).length,
        1,
      );
    }
    const activities = listOutbox(paws.db).filter((row) => row.op === "activity");
    for (const command of [...commands.values()].filter(
      (c) => executions.has(c.id) && c.type !== "review",
    )) {
      for (const prefix of ["Before", "After"]) {
        const text = `${prefix} restart ${command.id}.`;
        assert.equal(
          activities.filter((row) => (row.payload as { body?: string }).body === text).length,
          1,
          `${command.type} ${text}`,
        );
      }
    }
    console.log("restart integration passed");
  }
} finally {
  await paws.stop();
  await runtime.stop();
}
