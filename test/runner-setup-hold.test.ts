import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { JOB_KIND, systemClock, type LinearCommand } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyLinearCommand,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  getRunnerSetupHold,
  getWorkItem,
  insertQueuedItem,
  insertRun,
  listJobs,
  listOutbox,
  listWorkItems,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import { syncItemDependencies } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { attachOrchestrator, stopUndelegatedIssue } from "../src/loop";
import { createRemoteAgentRunner } from "../src/runner-backend";
import { createRunnerControl } from "../src/runner-control";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerKey, initializeRunnerAuthority } from "../src/runner-identity";
import { createRunnerPlacement, itemOwnerEligibleRunner } from "../src/runner-placement";
import { createRunnerResults } from "../src/runner-results";
import { createRunnerWork } from "../src/runner-work";
import { dispatch } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { migratedDatabase } from "./helpers";

const GITHUB_URL = "https://github.com/acme/fixture.git";
const RUNNERS_URL = "https://paws.example/status/runners";
const DAY_MS = 24 * 60 * 60_000;
const gitConfig = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
const previousGitConfig = gitConfig.map((key) => process.env[key]);

afterAll(() => {
  gitConfig.forEach((key, index) => {
    const value = previousGitConfig[index];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

type DelegatorRunner = "none" | "unsigned" | "busy" | "offline";

/**
 * A workspace where the owner's runner is online and free, and a member delegates ENG-1. The
 * member has no runner, a runner whose agent is not signed in, or a signed-in runner that is busy.
 */
async function delegate(delegatorRunner: DelegatorRunner) {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-setup-"));
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
  const ownerId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId: ownerId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  const memberId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "member",
    name: "Member",
    email: "member@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace.id,
    userId: memberId,
    role: "member",
    active: true,
    teamIds: ["team"],
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
  const pair = async (name: string, userId: string, ready: number) => {
    const enrollment = {
      name,
      csr: (await createRunnerKey(join(root, name))).csr,
    };
    const { runnerId } = await control.enroll({
      ...enrollment,
      token: control.createEnrollment(
        {
          workspaceId: workspace.id,
          userId: ownerId,
          role: "admin",
          authenticatedAt: now,
          teamIds: [],
        },
        enrollment,
      ).token,
    });
    db.run("UPDATE runner SET status='active' WHERE id=?", [runnerId]);
    db.run("UPDATE runner SET owner_user_id=? WHERE id=?", [userId, runnerId]);
    db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',?)", [
      runnerId,
      ready,
    ]);
    return runnerId;
  };
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  const freeRunner = await pair("owner-runner", ownerId, 1);
  work.heartbeat(freeRunner, 8);
  let memberRunner: string | null = null;
  if (delegatorRunner !== "none") {
    memberRunner = await pair("member-vm", memberId, delegatorRunner === "busy" ? 1 : 0);
    if (delegatorRunner === "offline")
      db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [now - 10 * 60_000, memberRunner]);
    else work.heartbeat(memberRunner, 1);
  }
  if (delegatorRunner === "busy") {
    const other = insertQueuedItem(db, { id: "other", now });
    const otherRun = insertRun(db, { itemId: other.id, now, status: "active" });
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,1,0,'other',?)",
      [otherRun.id, memberRunner, workspace.id, now + 60 * 60_000],
    );
  }

  const results = createRunnerResults({ db, work });
  const health = createRunnerHealth({ db, work });
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    pollIntervalMs: 5,
    placement: createRunnerPlacement({ db }),
    async fetchCandidate() {
      throw new Error("This fixture does not return a candidate");
    },
    async checkpointBot() {
      return { appId: "1", login: "paws[bot]", id: 1 };
    },
  });
  const fake = createFakeTracker([
    {
      linearIssueId: "issue-1",
      identifier: "ENG-1",
      title: "Task ENG-1",
      description: null,
      subIssues: [],
    },
  ]);
  // Counts every Linear call made while a runner-setup hold exists.
  const linearWhileHeld: string[] = [];
  const linearCalls: string[] = [];
  const tracker = new Proxy(fake, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        linearCalls.push(String(key));
        if (db.query("SELECT 1 FROM runner_setup_hold").get()) linearWhileHeld.push(String(key));
        return value.apply(target, args);
      };
    },
  });
  const jobs = new JobLoop(db, systemClock, { concurrency: 2, pollMs: 5 });
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
    runnersUrl: RUNNERS_URL,
    eligibleRunner: (itemId, agent, at) => itemOwnerEligibleRunner(db, { itemId, agent, now: at }),
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

  const sim = { stopped: false };
  const heartbeats = (async () => {
    while (!sim.stopped) {
      work.heartbeat(freeRunner, 8);
      if (memberRunner && delegatorRunner !== "offline") work.heartbeat(memberRunner, 1);
      await Bun.sleep(5);
    }
  })();

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
  bindLinearSessionTask(db, "session-1", item.delegationId, { actorId: "member" });
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [memberId, item.id]);
  await syncItemDependencies(db, {
    itemId: item.id,
    workspaceId: workspace.id,
    expectedGeneration: 0,
    tracker,
    lifecycle: createFakeLinearIssueLifecycle({
      id: "issue-1",
      teamId: "team",
      assigneeId: "member",
      delegateId: "app-user",
      stateType: "started",
      projectId: "project",
    }),
  });
  dispatch(db, { now: Date.now() });

  const controller = new AbortController();
  const loop = jobs.run(controller.signal, (ms) => Bun.sleep(ms));
  const settled = () => {
    const current = getWorkItem(db, item.id)!;
    if (getRunnerSetupHold(db, item.id) && current.state === "queued") return true;
    return listJobs(db).some(
      (job) =>
        job.queue === JOB_KIND.resume &&
        job.status === "pending" &&
        (job.payload as { itemId?: string }).itemId === item.id,
    );
  };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !settled()) await Bun.sleep(10);
  // Let the job that held the item finish before reading jobs.
  await Bun.sleep(100);

  return {
    db,
    itemId: item.id,
    memberId,
    memberRunner,
    tracker,
    linearWhileHeld,
    linearCalls,
    thoughts: () =>
      listOutbox(db, "session-1")
        .map((row) => row.payload as { kind?: string; body?: string })
        .filter((payload) => payload.kind === "thought")
        .map((payload) => payload.body),
    itemJobs: () =>
      listJobs(db).filter((job) => (job.payload as { itemId?: string }).itemId === item.id),
    async close() {
      controller.abort();
      sim.stopped = true;
      await heartbeats;
      await orchestrator.shutdown().catch(() => undefined);
      await loop;
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a delegator without a runner gets one thought and a quiet hold that takes no slot", async () => {
  const fixture = await delegate("none");
  try {
    const { db, itemId } = fixture;
    const detail = JSON.stringify({
      item: getWorkItem(db, itemId),
      jobs: fixture.itemJobs().map((job) => `${job.queue}:${job.status}`),
      thoughts: fixture.thoughts(),
    });
    expect(getWorkItem(db, itemId)!.state, detail).toBe("queued");
    expect(getRunnerSetupHold(db, itemId), detail).toMatchObject({
      reason: "no-runner",
      ownerUserId: fixture.memberId,
      notifiedAt: expect.any(Number),
    });
    expect(fixture.thoughts(), detail).toEqual([
      `You don't have a runner Paws can use yet. Create a VM or add a host here: ${RUNNERS_URL}. I'll start on my own once it's ready.`,
    ]);
    // No runner slot is held: nothing on any runner, no admission, no live run.
    expect(
      db
        .query("SELECT 1 FROM runner_work WHERE run_id IN (SELECT id FROM run WHERE item_id=?)")
        .all(itemId),
    ).toEqual([]);
    expect(
      db
        .query("SELECT 1 FROM run WHERE item_id=? AND status IN ('active','provisioning')")
        .all(itemId),
    ).toEqual([]);

    // A day later the scheduler neither starts it nor counts it as waiting, so no queue notice,
    // no start timeout and no retry job.
    const outboxBefore = listOutbox(db).length;
    const waiting: string[] = [];
    for (const offset of [60_000, 2 * 60 * 60_000, DAY_MS, DAY_MS + 60_000]) {
      const admitted = dispatch(db, {
        now: Date.now() + offset,
        onWaiting: (ids) => waiting.push(...ids),
      });
      expect(admitted).not.toContain(itemId);
    }
    expect(waiting).not.toContain(itemId);
    expect(db.query("SELECT 1 FROM scheduler_admission WHERE item_id=?").all(itemId)).toEqual([]);
    expect(fixture.itemJobs().filter((job) => job.status === "running")).toEqual([]);
    expect(
      fixture
        .itemJobs()
        .filter((job) => job.status === "pending")
        .map((job) => job.queue),
    ).toEqual([JOB_KIND.resume]);
    expect(getWorkItem(db, itemId)!.state).toBe("queued");
    expect(listOutbox(db).length).toBe(outboxBefore);
    expect(fixture.thoughts().join("\n")).not.toMatch(/Stopped after|couldn't start|Queued:/);
  } finally {
    await fixture.close();
  }
}, 60_000);

test("a delegator whose runner needs its agent signed in hears the runner and the agent", async () => {
  const fixture = await delegate("unsigned");
  try {
    const { db, itemId } = fixture;
    expect(getWorkItem(db, itemId)!.state).toBe("queued");
    expect(getRunnerSetupHold(db, itemId)).toMatchObject({
      reason: "agent-not-signed-in",
      runnerId: fixture.memberRunner,
      agent: "claude",
    });
    expect(fixture.thoughts()).toEqual([
      `Your runner member-vm needs Claude signed in. Sign in on the [Runners page](${RUNNERS_URL}); I'll start right after.`,
    ]);
  } finally {
    await fixture.close();
  }
}, 60_000);

test("a delegator whose runner is only busy still waits for capacity", async () => {
  const fixture = await delegate("busy");
  try {
    const { db, itemId } = fixture;
    expect(getRunnerSetupHold(db, itemId)).toBeNull();
    expect(
      fixture
        .itemJobs()
        .filter((job) => job.queue === JOB_KIND.resume && job.status === "pending")
        .map((job) => (job.payload as { capacityWait?: unknown }).capacityWait),
    ).toEqual([{ since: expect.any(Number), attempt: 0, runnerIds: [fixture.memberRunner] }]);
    expect(fixture.thoughts().join("\n")).not.toContain("runner Paws can use");
  } finally {
    await fixture.close();
  }
}, 60_000);

test("a delegator whose own runner is offline waits for it instead of hearing they have none", async () => {
  const fixture = await delegate("offline");
  try {
    const { db, itemId } = fixture;
    expect(getRunnerSetupHold(db, itemId)).toBeNull();
    expect(
      fixture
        .itemJobs()
        .filter((job) => job.queue === JOB_KIND.resume && job.status === "pending")
        .map((job) => (job.payload as { capacityWait?: unknown }).capacityWait),
    ).toEqual([{ since: expect.any(Number), attempt: 0, runnerIds: [] }]);
    expect(fixture.thoughts().join("\n")).not.toContain("runner Paws can use");
  } finally {
    await fixture.close();
  }
}, 60_000);

test("Stop ends the hold", async () => {
  const fixture = await delegate("none");
  try {
    const { db, itemId } = fixture;
    expect(getRunnerSetupHold(db, itemId)).not.toBeNull();
    const stop: LinearCommand = { type: "stop", itemId, source: "linear", requestedAt: Date.now() };
    expect(applyLinearCommand(db, stop).applied).toBe(true);
    expect(getRunnerSetupHold(db, itemId)).toBeNull();
    expect(getWorkItem(db, itemId)!.state).toBe("cancelled");
  } finally {
    await fixture.close();
  }
}, 60_000);

test("undelegation cancels a held item and ends its hold", async () => {
  const fixture = await delegate("none");
  try {
    const { db, itemId } = fixture;
    expect(getRunnerSetupHold(db, itemId)).not.toBeNull();
    await stopUndelegatedIssue(
      db,
      { organizationId: "org", appUserId: "app-user", issueId: "issue-1", createdAtMs: Date.now() },
      { notify() {} },
    );
    expect(getWorkItem(db, itemId)!.state).toBe("cancelled");
    expect(getRunnerSetupHold(db, itemId)).toBeNull();
  } finally {
    await fixture.close();
  }
}, 60_000);

test("signing the agent in resumes the held item in the same run and session, without reading Linear", async () => {
  const fixture = await delegate("unsigned");
  try {
    const { db, itemId } = fixture;
    const hold = getRunnerSetupHold(db, itemId)!;
    const item = getWorkItem(db, itemId)!;
    expect(hold.runId).not.toBeNull();
    expect(item.currentRunId).toBe(hold.runId);

    db.run("UPDATE runner_agent_policy SET ready=1 WHERE runner_id=?", [fixture.memberRunner]);
    const deadline = Date.now() + 20_000;
    const active = () =>
      db.query("SELECT 1 FROM run WHERE id=? AND status='active'").get(hold.runId!) !== null;
    while (Date.now() < deadline && !active()) await Bun.sleep(10);

    const resumed = getWorkItem(db, itemId)!;
    expect(getRunnerSetupHold(db, itemId)).toBeNull();
    expect(active()).toBe(true);
    expect(resumed.currentRunId).toBe(hold.runId);
    expect(resumed.sessionKey).toBe("session-1");
    expect(db.query("SELECT count(*) AS n FROM run WHERE item_id=?").get(itemId)).toEqual({ n: 1 });
    expect(fixture.thoughts().slice(0, 2)).toEqual([
      `Your runner member-vm needs Claude signed in. Sign in on the [Runners page](${RUNNERS_URL}); I'll start right after.`,
      "Starting ENG-1 on member-vm.",
    ]);
    expect(fixture.thoughts().filter((body) => body?.startsWith("Starting "))).toHaveLength(1);
    // The counting fake saw the intake's calls, and none while the item was held.
    expect(fixture.linearCalls.length).toBeGreaterThan(0);
    expect(fixture.linearWhileHeld).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 60_000);
