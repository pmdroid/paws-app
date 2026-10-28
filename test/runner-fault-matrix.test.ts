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
import {
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  createLinearClient,
} from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement } from "../src/runner-placement";
import { RUNNER_LEASE_GRACE_MS, type RunnerCommand } from "../src/runner-protocol";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork, RUNNER_LIVE_GRACE_MS } from "../src/runner-work";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

type Fault =
  | "fenced"
  | "outage"
  | "busy"
  | "unpaired"
  | "usage-limit"
  | "preparation-usage-limit"
  | "linear-503"
  | "restarted"
  | "silent-live"
  | "silent-unconfirmed"
  | "silent-hung";

const RUN_LOST = "The runner lost this run after it restarted; continuing from the branch.";
const SILENT_RUN_MS = 300;
const HUNG_RUN_MS = 900;
const RUN_HUNG = "The agent sent nothing for ";
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

test("a run whose runner restarted without it is lost on the next heartbeat and the task resumes", async () => {
  const result = await runRemoteFault("restarted");
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.retries, result.detail).toEqual([]);
  expect(result.faultedAttempts, result.detail).toBe(1);
  // The lease was never let lapse: the heartbeat that left the command out fenced it.
  expect(result.lostBeforeLease, result.detail).toBe(true);
  expect(
    result.thoughts.filter((body) => body.includes(RUN_LOST)),
    result.detail,
  ).toEqual([RUN_LOST]);
  expect(result.runs, result.detail).toEqual(["implement:ended"]);
}, 60_000);

test("a silent run that the runner still reports as live is not recovered", async () => {
  const result = await runRemoteFault("silent-live");
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.retries, result.detail).toEqual([]);
  expect(result.faultedAttempts, result.detail).toBe(1);
  expect(
    result.thoughts.some((body) => body.includes(RUN_LOST)),
    result.detail,
  ).toBe(false);
  expect(result.runs, result.detail).toEqual(["implement:ended"]);
}, 60_000);

test("a silent run that the runner does not confirm is recovered after the silence bound", async () => {
  const result = await runRemoteFault("silent-unconfirmed");
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.retries, result.detail).toEqual([]);
  expect(result.faultedAttempts, result.detail).toBe(1);
  expect(
    result.thoughts.filter((body) => body.includes(RUN_LOST)),
    result.detail,
  ).toEqual([RUN_LOST]);
  expect(result.runs, result.detail).toEqual(["implement:ended"]);
}, 60_000);

test("a silent run that the runner still confirms is stopped as hung after the hung bound", async () => {
  const result = await runRemoteFault("silent-hung");
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.retries, result.detail).toEqual([]);
  expect(result.faultedAttempts, result.detail).toBe(1);
  expect(result.hungStopped, result.detail).toBe(true);
  expect(
    result.thoughts.filter((body) => body.startsWith(RUN_HUNG)),
    result.detail,
  ).toHaveLength(1);
  expect(
    result.thoughts.some((body) => body.includes(RUN_LOST)),
    result.detail,
  ).toBe(false);
  expect(result.runs, result.detail).toEqual(["implement:ended"]);
}, 60_000);

test("a runner that is unreachable for longer than its lease keeps its run and reaches Closeout", async () => {
  const result = await runRemoteFault("outage");
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.retries, result.detail).toEqual([]);
  expect(result.faultedAttempts, result.detail).toBe(1);
  expect(result.runs, result.detail).toEqual(["implement:ended"]);
}, 60_000);

test("a slot taken before assignment waits for the runner without a retry and reaches Closeout", async () => {
  const result = await runRemoteFault("busy");
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  // A slot wait is not a lease expiry: the item keeps its state and its run.
  expect(result.deferredState, result.detail).toBe("running");
  expect(result.retries, result.detail).toEqual([0]);
  expect(result.faultedAttempts, result.detail).toBe(1);
  // The retry places the run again, and its start line is not posted a second time.
  expect(result.thoughts, result.detail).toEqual(["Starting on fixture in acme/fixture."]);
  expect(result.runs, result.detail).toEqual(["implement:ended"]);
}, 60_000);

test("a deferred remote run is lost, holds no runner slot, and its retry is a new run", async () => {
  const result = await runRemoteFault("fenced");
  expect(result.runs, result.detail).toEqual(["implement:lost", "implement:ended"]);
  expect(new Set(result.runIds).size, result.detail).toBe(2);
  expect(result.heldSlots, result.detail).toBe(0);
}, 60_000);

test("a Linear 503 while the task starts on its runner is retried and the task reaches Closeout", async () => {
  const result = await runRemoteFault("linear-503");
  expect(result.state, result.detail).toBe("merge_queue");
  expect(result.errors, result.detail).toEqual([]);
  expect(result.retries, result.detail).toEqual([1]);
  expect(result.faultedAttempts, result.detail).toBe(1);
  expect(
    result.thoughts.some(
      (body) =>
        body.includes("Linear GraphQL HTTP 503") && /Paws tries again in \d+ s\.$/.test(body),
    ),
    result.detail,
  ).toBe(true);
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
      /^Paused: Claude reached its usage limit\. Paws continues at (?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} UTC\.$/,
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
  const enrollment = {
    name: "fixture",
    csr: (await createRunnerKey(join(root, "client"))).csr,
  };
  const owner = {
    workspaceId: workspace.id,
    userId,
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const { runnerId } = await control.enroll({
    ...enrollment,
    token: control.createEnrollment(owner, enrollment).token,
  });
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
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
    lostBeforeLease: null as boolean | null,
    hungStopped: null as boolean | null,
  };
  // The work this fake runner names in its heartbeat, for faults where the runner reports it.
  const reporting = fault === "restarted" || fault === "silent-live" || fault === "silent-hung";
  const live = new Map<
    string,
    { command: Extract<RunnerCommand, { type: "run" }>; at: number; hung?: boolean }
  >();
  const heartbeat = () =>
    work.heartbeat(
      runnerId,
      1,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      reporting
        ? [...live.values()].map(({ command }) => ({
            runId: command.runId,
            generation: command.generation,
          }))
        : undefined,
    );
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    placement: createRunnerPlacement({ db }),
    pollIntervalMs: 5,
    ...(fault.startsWith("silent") ? { silentRunMs: SILENT_RUN_MS } : {}),
    ...(fault === "silent-hung" ? { hungRunMs: HUNG_RUN_MS } : {}),
    async fetchCandidate(candidate) {
      await git(["-C", candidate.worktree, "fetch", origin, candidate.candidateSha]);
      await git(["-C", candidate.worktree, "reset", "--hard", candidate.candidateSha]);
    },
    async checkpointBot() {
      if (fault === "busy" && runner.faulty) {
        runner.faultedAttempts++;
        db.run(
          "INSERT INTO runner_helper(id,runner_id,workspace_id,session_id,session_generation,runner_fence,envelope,expires_at) VALUES(?,?,?,'session',0,0,'{}',?)",
          // Held until `recover` sees the deferred start, so a slow machine cannot free the slot
          // before placement looks at it.
          [`helper-${runner.faultedAttempts}`, runnerId, workspace.id, Date.now() + 60_000],
        );
      }
      if (fault === "linear-503" && runner.faulty) {
        runner.faultedAttempts++;
        await createLinearClient({
          auth: {
            hasToken: () => true,
            ensureFresh: async () => "synthetic-linear-token",
            forceRefresh: async () => "synthetic-linear-token",
          },
          fetch: async () => new Response("", { status: 503 }),
        }).query("query { viewer { id } }");
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
    repositories: [{ owner: "acme", repo: "fixture", remoteUrl: GITHUB_URL }],
    retryBaseMs: 10,
    placementPollMs: 5,
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
    if (fault === "busy")
      db.run("UPDATE runner_helper SET ended_at=? WHERE ended_at IS NULL", [Date.now()]);
    runner.heldSlots = db
      .query<{ held: number }, [number]>(
        "SELECT count(*) AS held FROM runner_work WHERE ended_at IS NULL AND lease_until>?",
      )
      .get(Date.now())!.held;
    db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  }
  const handled = new Set<string>();
  let unreachable: { command: RunnerCommand; since: number } | undefined;
  function deliver(command: Extract<RunnerCommand, { type: "run" }>) {
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
  const loop = (async () => {
    while (!runner.stopped) {
      recover();
      if (unreachable && Date.now() - unreachable.since > 250) {
        const { command } = unreachable;
        unreachable = undefined;
        runner.stale = false;
        runner.faulty = false;
        heartbeat();
        if (command.type === "run") deliver(command);
      }
      for (const [key, entry] of live)
        if (!entry.hung && Date.now() - entry.at > SILENT_RUN_MS * 2) {
          live.delete(key);
          deliver(entry.command);
        }
      if (!runner.stale) {
        const lostBefore =
          fault === "restarted" && runner.lostBeforeLease === null
            ? db
                .query<{ leaseUntil: number }, []>(
                  "SELECT lease_until AS leaseUntil FROM runner_work WHERE ended_at IS NULL",
                )
                .get()
            : null;
        const reply = heartbeat();
        if (lostBefore && reply.fenced.length)
          runner.lostBeforeLease = lostBefore.leaseUntil > Date.now();
        // A hung agent's lease is no longer renewed although the runner still names its work.
        for (const [key, entry] of live)
          if (
            entry.hung &&
            !reply.leases.some(
              (lease) =>
                lease.runId === entry.command.runId &&
                lease.generation === entry.command.generation,
            )
          ) {
            live.delete(key);
            runner.hungStopped = Date.now() - entry.at >= HUNG_RUN_MS;
          }
      }
      for (const envelope of work.commands(runnerId)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        if (handled.has(command.id)) continue;
        handled.add(command.id);
        work.acknowledge(runnerId, command.id);
        if (command.type === "cancel" && runner.stale) {
          heartbeat();
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
          db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [
            Date.now() - 60_001 - RUNNER_LEASE_GRACE_MS,
            runnerId,
          ]);
          db.run("UPDATE runner_work SET lease_until=? WHERE run_id=?", [
            Date.now() - 1 - RUNNER_LEASE_GRACE_MS,
            command.runId,
          ]);
          continue;
        }
        if (fault === "restarted" && runner.faulty) {
          // The runner ran the command for a while, then restarted and came back without it.
          runner.faultedAttempts++;
          runner.faulty = false;
          db.run("UPDATE runner_command SET acknowledged_at=? WHERE id=?", [
            Date.now() - 2 * RUNNER_LIVE_GRACE_MS,
            command.id,
          ]);
          continue;
        }
        if (fault === "silent-live" && runner.faulty) {
          // A tool call that prints nothing for longer than the silence bound, then finishes.
          runner.faultedAttempts++;
          runner.faulty = false;
          live.set(command.id, { command, at: Date.now() });
          continue;
        }
        if (fault === "silent-hung" && runner.faulty) {
          // The runner stays alive and names the command, but its agent never sends anything.
          runner.faultedAttempts++;
          runner.faulty = false;
          // Paws starts its silence clock when it issues the command, which a busy machine can
          // leave well before this loop picks it up, so the hung bound is measured from then.
          live.set(command.id, { command, at: command.issuedAt, hung: true });
          continue;
        }
        if (fault === "silent-unconfirmed" && runner.faulty) {
          // A runner that does not name its work keeps renewing the lease while it is silent.
          runner.faultedAttempts++;
          runner.faulty = false;
          continue;
        }
        if (fault === "outage" && runner.faulty) {
          runner.faultedAttempts++;
          runner.stale = true;
          db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [Date.now() - 120_000, runnerId]);
          db.run("UPDATE runner_work SET lease_until=? WHERE run_id=?", [
            Date.now() - 60_000,
            command.runId,
          ]);
          unreachable = { command, since: Date.now() };
          continue;
        }
        deliver(command);
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
    orchestrator.reconcileExecution();
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
      lostBeforeLease: runner.lostBeforeLease,
      hungStopped: runner.hungStopped,
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
          timeoutSeconds: 5,
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
