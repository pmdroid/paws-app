import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  getWorkItem,
  listWorkItemEventRows,
  listWorkItems,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { syncItemDependencies } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement, type RunnerPlacement } from "../src/runner-placement";
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

type Fixture = {
  db: ReturnType<typeof migratedDatabase>;
  runnerId: string;
  placement: RunnerPlacement;
};

/**
 * One delegated item, one paired runner that answers probes and records the run commands it gets.
 * `wrap` replaces placement around the real one. Resolves once the runner received a run command
 * or the item failed.
 */
async function runItem(wrap: (fixture: Fixture) => RunnerPlacement) {
  const root = mkdtempSync(join(tmpdir(), "paws-placement-race-"));
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
    role: "owner" as const,
    authenticatedAt: now,
    teamIds: [],
  };
  const enrollment = { name: "goldbox", csr: (await createRunnerKey(join(root, "goldbox"))).csr };
  const { runnerId } = await control.enroll({
    ...enrollment,
    token: control.createEnrollment(owner, enrollment).token,
  });
  db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
  db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [runnerId]);

  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  work.heartbeat(runnerId, 8);
  const results = createRunnerResults({ db, work });
  const health = createRunnerHealth({ db, work });
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    pollIntervalMs: 5,
    placement: wrap({ db, runnerId, placement: createRunnerPlacement({ db }) }),
    async fetchCandidate() {
      throw new Error("This fixture does not return a candidate");
    },
    async checkpointBot() {
      return { appId: "1", login: "paws[bot]", id: 1 };
    },
  });
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue-1",
      identifier: "ENG-1",
      title: "Task ENG-1",
      description: null,
      subIssues: [],
    },
  ]);
  const jobs = new JobLoop(db, systemClock, { concurrency: 2, pollMs: 5 });
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: root,
    home: root,
    tracker,
    repository: { owner: "acme", repo: "fixture", remoteUrl: GITHUB_URL },
    scheduling: () => ({}),
    // Waits for a runner are re-placed in milliseconds rather than seconds.
    placementPollMs: 1,
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

  const runs: string[] = [];
  const sim = { stopped: false };
  const handled = new Set<string>();
  const runner = (async () => {
    while (!sim.stopped) {
      work.heartbeat(runnerId, 8);
      for (const envelope of work.commands(runnerId)) {
        const command = JSON.parse(
          Buffer.from(envelope.payload, "base64url").toString(),
        ) as RunnerCommand;
        if (handled.has(command.id)) continue;
        handled.add(command.id);
        work.acknowledge(runnerId, command.id);
        if (command.type === "login_check")
          health.submit(runnerId, {
            ...receipt(command),
            login: { agent: command.agent, authenticated: true, method: "subscription" },
          });
        if (command.type === "probe")
          health.submit(runnerId, {
            ...receipt(command),
            models: [{ id: "fixture-implement-model", name: "Fixture" }],
          });
        if (command.type === "run") runs.push(command.runnerId);
      }
      await Bun.sleep(5);
    }
  })();

  const controller = new AbortController();
  let loop: Promise<void> | undefined;
  try {
    await orchestrator.onLinearEvent({
      dedupeKey: "created:1",
      deliveryId: null,
      source: "webhook",
      action: "created",
      sessionId: "session-1",
      issueId: "issue-1",
      activityId: null,
      actorId: null,
      body: null,
      signal: null,
      updatedAtMs: Date.now(),
      payload: "{}",
    });
    const item = listWorkItems(db).find((row) => row.sessionKey === "session-1")!;
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId: "session-1",
      teamId: "team",
      observedAtMs: now,
    });
    bindLinearSessionTask(db, "session-1", item.delegationId, { actorId: "owner" });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, item.id]);
    await syncItemDependencies(db, {
      itemId: item.id,
      workspaceId: workspace.id,
      expectedGeneration: 0,
      tracker,
      lifecycle: createFakeLinearIssueLifecycle({
        id: "issue-1",
        teamId: "team",
        assigneeId: "owner",
        delegateId: "app-user",
        stateType: "started",
        projectId: "project",
      }),
    });
    dispatch(db, { now: Date.now() });
    loop = jobs.run(controller.signal, (ms) => Bun.sleep(ms));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !runs.length && getWorkItem(db, item.id)?.state !== "failed")
      await Bun.sleep(10);
    return {
      runnerId,
      runs: [...runs],
      state: getWorkItem(db, item.id)?.state,
      events: listWorkItemEventRows(db, item.id).map((row) => row.event),
    };
  } finally {
    controller.abort();
    sim.stopped = true;
    await runner;
    await orchestrator.shutdown().catch(() => undefined);
    await loop;
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a runner that restarts between selection and assignment gets the item again instead of failing it", async () => {
  let restarts = 0;
  const outcome = await runItem(({ db, runnerId, placement }) => ({
    ...placement,
    async candidates(request) {
      const chosen = await placement.candidates(request);
      // The second work placement is the admission check just before assignment. The runner
      // restarts right after it and reports its agent again, so the admission no longer holds.
      if (request.purpose === "work" && chosen.length && ++restarts === 2)
        db.run("UPDATE runner_agent_policy SET resolved_model='after-restart' WHERE runner_id=?", [
          runnerId,
        ]);
      return chosen;
    },
  }));
  const detail = JSON.stringify(outcome);
  expect(restarts, detail).toBeGreaterThan(2);
  expect(outcome.runs, detail).toEqual([outcome.runnerId]);
  expect(outcome.state, detail).toBe("running");
  expect(outcome.events, detail).not.toContain("run_failed");
}, 60_000);

test("a real assignment error still fails the item", async () => {
  const outcome = await runItem(({ placement }) => ({
    ...placement,
    started(input) {
      if (input.purpose === "work") throw new Error("Runner usage receipt could not be written");
      placement.started(input);
    },
  }));
  const detail = JSON.stringify(outcome);
  expect(outcome.runs, detail).toEqual([]);
  expect(outcome.state, detail).toBe("failed");
  expect(outcome.events, detail).toContain("run_failed");
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
