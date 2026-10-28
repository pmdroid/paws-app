import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { JOB_KIND, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  getWorkItem,
  insertQueuedItem,
  insertRun,
  listJobs,
  listWorkItems,
  putWorkspaceUser,
  recordLinearInstallation,
  type Job,
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
import { dispatch } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

const GITHUB_URL = "https://github.com/acme/fixture.git";
const gitConfig = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
const previousGitConfig = gitConfig.map((key) => process.env[key]);

afterAll(() => {
  gitConfig.forEach((key, index) => {
    const value = previousGitConfig[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

test("four tasks waiting for a busy runner leave the execution workers free for a fifth task on a free runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-capacity-wait-"));
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
  writeFileSync(join(source, "README.md"), "Fixture\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Fixture"]);
  await git(["clone", "--bare", source, origin]);
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
  const owner = {
    workspaceId: workspace.id,
    userId,
    role: "admin" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const pair = async (name: string) => {
    const enrollment = {
      name,
      csr: (await createRunnerKey(join(root, name))).csr,
    };
    const { runnerId } = await control.enroll({
      ...enrollment,
      token: control.createEnrollment(owner, enrollment).token,
    });
    db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
    db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [
      runnerId,
    ]);
    return runnerId;
  };
  const busyRunner = await pair("busy");
  const freeRunner = await pair("free");
  const other = insertQueuedItem(db, { id: "other", now });
  const otherRun = insertRun(db, { itemId: other.id, now, status: "active" });
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,1,0,'other',?)",
    [otherRun.id, busyRunner, workspace.id, now + 60 * 60_000],
  );

  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  work.heartbeat(freeRunner, 8);
  const results = createRunnerResults({ db, work });
  const health = createRunnerHealth({ db, work });
  const identifiers = ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"];
  const waiting = new Set(identifiers.slice(0, 4));
  const placement = createRunnerPlacement({ db });
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    pollIntervalMs: 5,
    placement: {
      ...placement,
      async candidates(request) {
        const want = waiting.has(getWorkItem(db, request.itemId ?? "")?.linearIdentifier ?? "")
          ? busyRunner
          : freeRunner;
        return (await placement.candidates(request)).filter((runner) => runner.id === want);
      },
    },
    async fetchCandidate() {
      throw new Error("This fixture does not return a candidate");
    },
    async checkpointBot() {
      return { appId: "1", login: "paws[bot]", id: 1 };
    },
  });

  const tracker = createFakeTracker(
    identifiers.map((identifier, index) => ({
      linearIssueId: `issue-${index}`,
      identifier,
      title: `Task ${identifier}`,
      description: null,
      subIssues: [],
    })),
  );
  const jobs = new JobLoop(db, systemClock, { concurrency: 4, pollMs: 5 });
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: root,
    home: root,
    tracker,
    repositories: [{ owner: "acme", repo: "fixture", remoteUrl: GITHUB_URL }],
    scheduling: () => ({}),
    launch() {
      return { command: "/forbidden-local-agent", args: [] };
    },
    remoteExecution: {
      agentForSession() {
        throw new Error("This fixture does not request a routing helper");
      },
      agentForItem(itemId) {
        return (options) => backend.forItem(itemId)({ ...options, networkGit: git });
      },
    },
  });

  const started = new Set<string>();
  const sim = { stopped: false };
  const handled = new Set<string>();
  const runner = (async () => {
    while (!sim.stopped) {
      db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [Date.now(), busyRunner]);
      work.heartbeat(freeRunner, 8);
      for (const envelope of work.commands(freeRunner)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        if (handled.has(command.id)) continue;
        handled.add(command.id);
        work.acknowledge(freeRunner, command.id);
        if (command.type === "login_check")
          health.submit(freeRunner, {
            ...receipt(command),
            login: { agent: command.agent, authenticated: true, method: "subscription" },
          });
        if (command.type === "probe")
          health.submit(freeRunner, {
            ...receipt(command),
            models: [{ id: "fixture-implement-model", name: "Fixture" }],
          });
        if (command.type === "run")
          started.add(
            listWorkItems(db).find((item) => item.currentRunId === command.runId)!.linearIdentifier,
          );
      }
      await Bun.sleep(5);
    }
  })();

  const controller = new AbortController();
  let loop: Promise<void> | undefined;
  try {
    for (const [index] of identifiers.entries()) {
      await orchestrator.onLinearEvent({
        dedupeKey: `created:${index}`,
        deliveryId: null,
        source: "webhook",
        action: "created",
        sessionId: `session-${index}`,
        issueId: `issue-${index}`,
        activityId: null,
        actorId: null,
        body: null,
        signal: null,
        updatedAtMs: Date.now(),
        payload: "{}",
      });
      const item = listWorkItems(db).find((row) => row.sessionKey === `session-${index}`)!;
      recordLinearInstallation(db, {
        organizationId: "org",
        oauthClientId: "app",
        appUserId: "app-user",
        sessionId: `session-${index}`,
        teamId: "team",
        observedAtMs: now,
      });
      bindLinearSessionTask(db, `session-${index}`, item.delegationId, { actorId: "owner" });
      db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, item.id]);
      await syncItemDependencies(db, {
        itemId: item.id,
        workspaceId: workspace.id,
        expectedGeneration: 0,
        tracker,
        lifecycle: createFakeLinearIssueLifecycle({
          id: `issue-${index}`,
          teamId: "team",
          assigneeId: "owner",
          delegateId: "app-user",
          stateType: "started",
          projectId: "project",
        }),
      });
    }
    dispatch(db, { now: Date.now() });
    expect(db.query("SELECT item_id FROM scheduler_admission").all()).toHaveLength(5);
    loop = jobs.run(controller.signal, (ms) => Bun.sleep(ms));
    const deadline = Date.now() + 20_000;
    const parked = () =>
      listJobs(db).filter((job) => job.queue === JOB_KIND.resume && job.status === "pending")
        .length;
    while (Date.now() < deadline && !(started.has("ENG-5") && parked() === 4)) await Bun.sleep(10);
    const itemJob = (job: Job) =>
      getWorkItem(db, (job.payload as { itemId: string }).itemId)?.linearIdentifier ?? "";
    const executions = listJobs(db).filter((job) =>
      [JOB_KIND.start, JOB_KIND.resume].includes(job.queue as typeof JOB_KIND.start),
    );
    const detail = JSON.stringify({
      started: [...started],
      jobs: executions.map((job) => `${itemJob(job)}:${job.queue}:${job.status}`),
      items: listWorkItems(db).map((item) => `${item.linearIdentifier}:${item.state}`),
    });
    expect([...started], detail).toEqual(["ENG-5"]);
    expect(
      executions
        .filter((job) => waiting.has(itemJob(job)) && job.status === "running")
        .map(itemJob),
      detail,
    ).toEqual([]);
    expect(
      executions
        .filter((job) => job.queue === JOB_KIND.resume && job.status === "pending")
        .map((job) => [itemJob(job), (job.payload as { capacityWait?: unknown }).capacityWait])
        .sort(),
      detail,
    ).toEqual(
      [...waiting].map((identifier) => [
        identifier,
        { since: expect.any(Number), attempt: 0, runnerIds: [busyRunner] },
      ]),
    );
  } finally {
    controller.abort();
    sim.stopped = true;
    await runner;
    await orchestrator.shutdown().catch(() => undefined);
    await loop;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

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
