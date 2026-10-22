import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { runAgent, type RunAgentOptions } from "../src/acp";
import { JOB_KIND, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  getWorkItem,
  listJobs,
  listRuns,
  listWorkItems,
  putWorkspaceUser,
  recordLinearInstallation,
  resumeUsagePauseNow,
} from "../src/db";
import { syncItemDependencies } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import type { RunnerCommand } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

type Fault = "fenced" | "busy" | "unpaired" | "usage-limit" | "preparation-usage-limit";

const GITHUB_URL = "https://github.com/acme/fixture.git";
const fakeAgent = join(import.meta.dir, "../src/acp/testing/fake-agent.ts");
const gitConfig = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
const previousGitConfig = gitConfig.map((key) => process.env[key]);

afterAll(() => {
  gitConfig.forEach((key, index) => {
    const value = previousGitConfig[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

test.each([
  ["a fenced lease", "fenced", "The runner restarted or lost its lease during the run.", 3],
  ["a slot taken before assignment", "busy", "Runner became busy before assignment", 3],
  [
    "no paired runner",
    "unpaired",
    "No available paired runner can access this Linear task repository",
    1,
  ],
] as const)(
  "%s escapes failover, defers the task, and reaches Closeout once the runner is back",
  async (_label, fault, message, attempts) => {
    const result = await runRemoteFault(fault);
    expect(result.state, result.detail).toBe("merge_queue");
    expect(result.errors, result.detail).toEqual([]);
    expect(result.deferredState, result.detail).toBe("recovering");
    expect(result.retries, result.detail).toEqual([1]);
    expect(result.faultedAttempts, result.detail).toBe(attempts);
    expect(
      result.thoughts.some(
        (body) => body.includes(message) && /Paws tries again in \d+ s\.$/.test(body),
      ),
      result.detail,
    ).toBe(true);
    expect(result.runs, result.detail).toEqual(["implement:lost", "implement:ended"]);
  },
  60_000,
);

test("a deferred remote run is lost, holds no runner slot, and its retry is a new run", async () => {
  const result = await runRemoteFault("fenced");
  expect(result.runs, result.detail).toEqual(["implement:lost", "implement:ended"]);
  expect(new Set(result.runIds).size, result.detail).toBe(2);
  expect(result.heldSlots, result.detail).toBe(0);
}, 60_000);

test("a usage limit is waited out inside failover and the task reaches Closeout after the reset", async () => {
  const result = await runRemoteFault("usage-limit");
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.retries, result.detail).toEqual([]);
  expect(result.faultedAttempts, result.detail).toBe(1);
  expect(result.runs, result.detail).toEqual(["implement:ended"]);
  expect(
    result.thoughts.some((body) => body.includes("reached its usage limit")),
    result.detail,
  ).toBe(true);
}, 60_000);

test("a usage limit while the implementer is prepared posts one thought naming the agent and the reset time", async () => {
  const result = await runRemoteFault("preparation-usage-limit");
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.faultedAttempts, result.detail).toBe(1);
  expect(
    result.thoughts.filter((body) => body.includes("reached its usage limit")),
    result.detail,
  ).toEqual([
    expect.stringMatching(
      /^Paused: Claude reached its usage limit\. Paws continues at \d{2}:\d{2} UTC\.$/,
    ),
  ]);
}, 60_000);

async function runRemoteFault(fault: Fault) {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-faults-"));
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  async function git(args: string[]) {
    const child = Bun.spawn(["/usr/bin/git", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(err);
    return out.trim();
  }
  await git(["init", "-b", "main", source]);
  mkdirSync(join(source, ".agents/skills/review"), { recursive: true });
  writeFileSync(join(source, "README.md"), "Fixture\n");
  writeFileSync(join(source, ".agents/skills/review/SKILL.md"), "Review and return findings.\n");
  writeFileSync(join(source, ".agents/closeout.yaml"), CLOSEOUT_POLICY);
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Fixture policy"]);
  await git(["clone", "--bare", source, origin]);
  writeFileSync(join(source, "result.txt"), "candidate\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Candidate"]);
  const candidateSha = await git(["-C", source, "rev-parse", "HEAD"]);
  await git(["-C", source, "push", origin, "HEAD:refs/heads/candidate"]);
  Object.assign(process.env, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`,
    GIT_CONFIG_VALUE_0: GITHUB_URL,
  });

  const db = migratedDatabase(join(root, "paws.db"));
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
  const pairing = await control.beginPairing({
    name: "fixture",
    csr: (await createRunnerKey(join(root, "client"))).csr,
  });
  const owner = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const { runnerId } = await control.approvePairing(owner, pairing.code);
  db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
  for (const agent of ["claude", "codex"])
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,1)", [
      runnerId,
      agent,
    ]);
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  const results = createRunnerResults({ db, work });
  const health = createRunnerHealth({ db, work });
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "issue",
    teamId: "team",
    assigneeId: "owner",
    delegateId: "app-user",
    stateType: "started",
    projectId: "project",
  });
  const runner = {
    faulty: true,
    stale: false,
    stopped: false,
    faultedAttempts: 0,
    deferredState: null as string | null,
    heldSlots: null as number | null,
  };
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    placement: createRunnerPlacement({
      db,
      lifecycle,
      tracker: { listProjectMembers: async () => ["owner"] },
    }),
    pollIntervalMs: 5,
    async fetchCandidate(candidate) {
      await git(["-C", candidate.worktree, "fetch", origin, candidate.candidateSha]);
      await git(["-C", candidate.worktree, "reset", "--hard", candidate.candidateSha]);
    },
    async checkpointBot() {
      if (fault === "busy" && runner.faulty) {
        runner.faultedAttempts++;
        db.run(
          "INSERT INTO runner_helper(id,runner_id,workspace_id,session_id,session_generation,runner_fence,envelope,expires_at) VALUES(?,?,?,'session',0,0,'{}',?)",
          [`helper-${runner.faultedAttempts}`, runnerId, workspace.id, Date.now() + 50],
        );
      }
      return { appId: "1", login: "paws[bot]", id: 1 };
    },
  });

  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-42",
      title: "Write output",
      description: null,
      subIssues: [],
    },
  ]);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  let reviews = 0;
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: root,
    home: root,
    tracker,
    repository: { owner: "acme", repo: "fixture", remoteUrl: GITHUB_URL },
    retryBaseMs: 10,
    launch() {
      return { command: "/forbidden-local-agent", args: [] };
    },
    remoteExecution: {
      agentForSession() {
        throw new Error("This fixture does not request a routing helper");
      },
      agentForItem(itemId) {
        return async (options: RunAgentOptions) => {
          if (options.role === "implementer")
            return backend.forItem(itemId)({ ...options, networkGit: git });
          const script = join(root, `review-${++reviews}.json`);
          writeFileSync(
            script,
            JSON.stringify({
              sessionId: `review-${reviews}`,
              model: "fixture-review-model",
              steps: [
                {
                  type: "update",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "[]" },
                  },
                },
                { type: "end" },
              ],
            }),
          );
          return runAgent({
            ...options,
            command: process.execPath,
            args: [fakeAgent, "", script],
            env: { PATH: process.env.PATH!, HOME: root },
          });
        };
      },
    },
  });

  if (fault === "unpaired") db.run("UPDATE runner SET status='paused' WHERE id=?", [runnerId]);
  function recover() {
    if (!runner.faulty) return;
    const paused = db.query<{ runId: string }, []>("SELECT run_id AS runId FROM usage_pause").get();
    if (paused) {
      runner.faulty = false;
      resumeUsagePauseNow(db, paused.runId, Date.now());
      return;
    }
    const deferred = listJobs(db).find((job) => job.queue === JOB_KIND.resume);
    if (!deferred) return;
    if (fault === "unpaired") runner.faultedAttempts++;
    runner.faulty = false;
    runner.deferredState = getWorkItem(db, (deferred.payload as { itemId: string }).itemId)!.state;
    runner.heldSlots = db
      .query<{ held: number }, [number]>(
        "SELECT count(*) AS held FROM runner_work WHERE ended_at IS NULL AND lease_until>?",
      )
      .get(Date.now())!.held;
    db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  }
  const handled = new Set<string>();
  const loop = (async () => {
    while (!runner.stopped) {
      recover();
      if (!runner.stale) work.heartbeat(runnerId);
      for (const envelope of work.commands(runnerId)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        if (handled.has(command.id)) continue;
        handled.add(command.id);
        work.acknowledge(runnerId, command.id);
        if (command.type === "cancel" && runner.stale) {
          work.heartbeat(runnerId);
          runner.stale = false;
        }
        if (command.type === "login_check")
          health.submit(runnerId, {
            ...receipt(command),
            login: { agent: command.agent, authenticated: true, method: "subscription" },
          });
        if (command.type === "probe" && fault === "preparation-usage-limit" && runner.faulty) {
          runner.faultedAttempts++;
          health.submit(runnerId, {
            ...receipt(command),
            stopReason: "error",
            errorMessage: "You've hit your session limit. Retry-After: 120",
          });
        } else if (command.type === "probe")
          health.submit(runnerId, {
            ...receipt(command),
            models: [{ id: "fixture-implement-model", name: "Fixture" }],
          });
        if (command.type !== "run") continue;
        if (fault === "fenced" && runner.faulty) {
          runner.faultedAttempts++;
          runner.stale = true;
          db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [Date.now() - 60_001, runnerId]);
          db.run("UPDATE runner_work SET lease_until=? WHERE run_id=?", [
            Date.now() - 1,
            command.runId,
          ]);
          continue;
        }
        const grant = work.issueGrant({
          runnerId,
          runId: command.runId,
          commandId: command.id,
          generation: command.generation,
        });
        const limited = fault === "usage-limit" && runner.faulty;
        if (limited) runner.faultedAttempts++;
        results.submit({
          runnerId,
          runId: command.runId,
          generation: command.generation,
          token: grant.token,
          result: limited
            ? {
                ...receipt(command),
                stopReason: "error",
                errorMessage: "You've hit your session limit. Retry-After: 120",
              }
            : { ...receipt(command), candidateSha, closeoutReport: passedReport(candidateSha) },
        });
      }
      await Bun.sleep(5);
    }
  })();

  try {
    await orchestrator.onLinearEvent({
      dedupeKey: "created:issue",
      deliveryId: null,
      source: "webhook",
      action: "created",
      sessionId: "session",
      issueId: "issue",
      activityId: null,
      actorId: null,
      body: null,
      signal: null,
      updatedAtMs: Date.now(),
      payload: "{}",
    });
    const item = listWorkItems(db)[0]!;
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId: "session",
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, item.id]);
    await syncItemDependencies(db, {
      itemId: item.id,
      workspaceId: workspace.id,
      expectedGeneration: 0,
      tracker,
      lifecycle,
    });
    const deadline = Date.now() + 45_000;
    while (
      Date.now() < deadline &&
      !["merge_queue", "merged", "failed", "awaiting_input"].includes(
        getWorkItem(db, item.id)?.state ?? "",
      )
    ) {
      const ran = await jobs.tick();
      recover();
      if (ran === null) {
        outbox.tick();
        await Bun.sleep(10);
      }
    }
    while (outbox.tick().length > 0) await outbox.idle();
    const progress = (kind: string) =>
      tracker.progress.filter((update) => update.kind === kind).map((update) => update.body);
    return {
      state: getWorkItem(db, item.id)?.state ?? null,
      thoughts: progress("thought"),
      errors: progress("error"),
      retries: listJobs(db)
        .filter((job) => job.queue === JOB_KIND.resume)
        .map((job) => (job.payload as { retry?: number }).retry ?? 0),
      runs: listRuns(db).map((run) => `${run.kind}:${run.status}`),
      runIds: listRuns(db).map((run) => run.id),
      faultedAttempts: runner.faultedAttempts,
      deferredState: runner.deferredState,
      heldSlots: runner.heldSlots,
      detail: JSON.stringify({
        state: getWorkItem(db, item.id)?.state,
        runs: listRuns(db).map((run) => `${run.kind}:${run.status}`),
        jobs: listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`),
        progress: tracker.progress.map((update) => `${update.kind}: ${update.body}`),
        faultedAttempts: runner.faultedAttempts,
      }),
    };
  } finally {
    runner.stopped = true;
    await loop;
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function receipt(command: RunnerCommand) {
  return {
    executionId: workspaceId(),
    commandId: command.id,
    role: "implementer" as const,
    stopReason: "end_turn" as const,
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    identity: {
      session: `session-${command.id}`,
      model: "fixture-implement-model",
      provider: "fixture",
    },
  };
}

function passedReport(head: string): string {
  return JSON.stringify({
    required: [
      {
        id: "check",
        status: "passed",
        result: {
          argv: ["/forbidden-local-check"],
          head,
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: "",
          stderr: "",
          truncated: false,
        },
      },
    ],
    pending: [],
    blocked: null,
    bypassed: false,
  });
}

const CLOSEOUT_POLICY = JSON.stringify({
  specVersion: "0.1",
  items: [
    {
      id: "check",
      kind: "command",
      gate: "beforePR",
      exec: ["/forbidden-local-check"],
      timeoutSeconds: 5,
    },
    {
      id: "review",
      kind: "review",
      gate: "beforePR",
      skill: ".agents/skills/review/SKILL.md",
      independence: { differentSession: true, differentModel: true },
      failOn: "P1",
    },
  ],
});
