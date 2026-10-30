import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { FakeClock, JOB_KIND, systemClock, type Clock } from "../src/core";
import { setJournalSink, RunnerCapacityWait } from "../src/core";
import type { RunAgentOptions } from "../src/acp";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  enqueueJob,
  getWorkItem,
  insertRun,
  listJobs,
  listWorkItems,
  putWorkspaceUser,
  recordLinearInstallation,
  setCurrentRun,
  type Job,
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

test("twenty recovering items fill six free slots in one tick and do not fail for capacity", async () => {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  let jitter = 0;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((part) => String(part)).join(" "));
  };
  try {
    await runRecovering({
      count: 20,
      capacity: 6,
      random: () => (jitter++ % 10) / 10,
      clock: new FakeClock(Date.now()),
      lines,
      async assert(started, db, backend) {
        const running = listWorkItems(db).filter((item) => started.has(item.linearIdentifier));
        for (const item of running) expect(backend.tryReserve(item.id).ok).toBe(false);
        const pending = listJobs(db).filter(
          (job) => job.queue === JOB_KIND.resume && job.status === "pending",
        );
        expect(new Set(pending.map((job) => job.runAt)).size).toBeGreaterThan(1);
        expect(started.size, lines.join("\n")).toBe(6);
        const noise = [...lines, ...warnings].join("\n");
        expect(noise).not.toContain("Waiting for a free slot");
        expect(noise).not.toContain("no free capacity");
      },
    });
  } finally {
    console.warn = warn;
    restore();
  }
}, 90_000);

test("a failed preparation releases its reservation and the next recovering item gets the slot", async () => {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  let failPreparation = true;
  try {
    await runRecovering({
      count: 2,
      capacity: 1,
      clock: systemClock,
      maxAttempts: 1,
      placementPollMs: 1,
      random: () => 0,
      lines,
      ready: (started, db) =>
        started.size === 1 && listWorkItems(db).some((item) => item.state === "awaiting_input"),
      wrap(placement) {
        return {
          ...placement,
          started(input) {
            placement.started(input);
            if (failPreparation && input.purpose === "prepare") {
              failPreparation = false;
              throw new Error("preparation blew up");
            }
          },
        };
      },
      async assert(started, db) {
        expect(started.size, lines.join("\n")).toBe(1);
        expect(lines.join("\n")).not.toContain("Waiting for a free slot");
        const failed = listWorkItems(db).filter((item) => item.state === "awaiting_input");
        expect(failed.map((item) => item.linearIdentifier)).toHaveLength(1);
        expect(started.has(failed[0]!.linearIdentifier)).toBe(false);
      },
    });
  } finally {
    restore();
  }
}, 60_000);

test("reviewer preparation can use another runner before implementation takes its slot", async () => {
  await runRecovering({
    count: 1,
    capacity: 1,
    reviewerRunner: true,
    clock: new FakeClock(Date.now()),
    lines: [],
    assert(started) {
      expect(started.size).toBe(1);
    },
  });
}, 60_000);

test("admission belongs to one job, follows run replacement, and only its owner can release it", async () => {
  await runRecovering({
    count: 2,
    capacity: 1,
    clock: new FakeClock(Date.now()),
    lines: [],
    beforeStart(db, backend) {
      const [first, second] = listWorkItems(db);
      const lease = backend.tryReserve(first!.id);
      expect(lease.ok).toBe(true);
      if (!lease.ok || !lease.release) throw new Error("Expected an owned admission");
      const duplicate = backend.tryReserve(first!.id);
      expect(duplicate.ok).toBe(false);
      expect(backend.tryReserve(second!.id).ok).toBe(false);
      const prior = first!.currentRunId!;
      db.run("UPDATE run SET status='lost' WHERE id=?", [prior]);
      const replacement = insertRun(db, {
        itemId: first!.id,
        now: Date.now(),
        status: "active",
        kind: "recheck",
      });
      setCurrentRun(db, first!.id, replacement.id);
      expect(backend.tryReserve(second!.id).ok).toBe(false);
      lease.release();
      const next = backend.tryReserve(second!.id);
      expect(next.ok).toBe(true);
      if (!next.ok || !next.release) throw new Error("Expected the freed slot");
      // A stale release must not delete a later job's hold, even for the same item.
      next.release();
      const later = backend.tryReserve(first!.id);
      expect(later.ok).toBe(true);
      lease.release();
      expect(backend.tryReserve(second!.id).ok).toBe(false);
      if (later.ok) later.release?.();
      setCurrentRun(db, first!.id, prior);
      db.run("UPDATE run SET status='active' WHERE id=?", [prior]);
      db.run("UPDATE run SET status='ended' WHERE id=?", [replacement.id]);
    },
    assert(started) {
      expect(started.size).toBe(1);
    },
  });
}, 60_000);

test("a failed attempt keeps its job's admission for the next preparation attempt", async () => {
  let fail = true;
  await runRecovering({
    count: 2,
    capacity: 1,
    clock: new FakeClock(Date.now()),
    lines: [],
    wrap(placement) {
      return {
        ...placement,
        started(value) {
          placement.started(value);
          if (fail && value.purpose === "prepare") {
            fail = false;
            throw new Error("retry preparation");
          }
        },
      };
    },
    async beforeStart(db, backend, agentInput) {
      const [first, second] = listWorkItems(db);
      bindWorkItemRepository(db, first!.id, {
        owner: "acme",
        repo: "fixture",
        remoteUrl: GITHUB_URL,
      });
      db.run("UPDATE work_item SET state='running' WHERE id=?", [first!.id]);
      const lease = backend.tryReserve(first!.id);
      if (!lease.ok || !lease.release) throw new Error("Expected an owned admission");
      await expect(backend.forItem(first!.id)(agentInput)).rejects.toThrow("retry preparation");
      expect(backend.tryReserve(second!.id).ok).toBe(false);
      await backend.forItem(first!.id)(agentInput);
      expect(backend.tryReserve(second!.id).ok).toBe(false);
      lease.release();
      const next = backend.tryReserve(second!.id);
      expect(next.ok).toBe(true);
      if (next.ok) next.release?.();
      db.run("UPDATE work_item SET state='recovering' WHERE id=?", [first!.id]);
    },
    assert(started) {
      expect(started.size).toBe(1);
    },
  });
}, 60_000);

test("concurrent preparation, attachment and stale review cannot read or cancel the active turn", async () => {
  await runRecovering({
    count: 1,
    capacity: 1,
    clock: new FakeClock(Date.now()),
    lines: [],
    async assert(started, db, backend, agentInput) {
      const item = listWorkItems(db)[0]!;
      const commands = () => db.query("SELECT id,kind FROM runner_command ORDER BY ordinal").all();
      const before = commands();
      const runAgent = backend.forItem(item.id);
      await expect(runAgent(agentInput)).rejects.toBeInstanceOf(RunnerCapacityWait);
      await expect(
        runAgent({ ...agentInput, prepareOnly: false, readOnly: false }),
      ).rejects.toBeInstanceOf(RunnerCapacityWait);
      await expect(
        runAgent({ ...agentInput, prepareOnly: false, role: "reviewer", prompt: "a new review" }),
      ).rejects.toBeInstanceOf(RunnerCapacityWait);
      const prior = item.currentRunId!;
      const replacement = insertRun(db, { itemId: item.id, now: Date.now(), status: "active" });
      setCurrentRun(db, item.id, replacement.id);
      try {
        await expect(runAgent({ ...agentInput, runId: replacement.id })).rejects.toBeInstanceOf(
          RunnerCapacityWait,
        );
      } finally {
        setCurrentRun(db, item.id, prior);
        db.run("UPDATE run SET status='ended' WHERE id=?", [replacement.id]);
      }
      expect(commands()).toEqual(before);
      expect(backend.runInProgress(prior)).toBe(true);
      expect(started.size).toBe(1);
    },
  });
}, 60_000);

async function runRecovering(input: {
  count: number;
  capacity: number;
  clock: Clock;
  lines: string[];
  reviewerRunner?: boolean;
  beforeStart?: (
    db: ReturnType<typeof migratedDatabase>,
    backend: ReturnType<typeof createRemoteAgentRunner>,
    agentInput: RunAgentOptions,
  ) => void | Promise<void>;
  maxAttempts?: number;
  placementPollMs?: number;
  random?: () => number;
  wrap?: (placement: RunnerPlacement) => RunnerPlacement;
  ready?: (started: Set<string>, db: ReturnType<typeof migratedDatabase>) => boolean;
  assert: (
    started: Set<string>,
    db: ReturnType<typeof migratedDatabase>,
    backend: ReturnType<typeof createRemoteAgentRunner>,
    agentInput: RunAgentOptions,
  ) => void | Promise<void>;
}) {
  const root = mkdtempSync(join(tmpdir(), "paws-recovering-slots-"));
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
  const now = input.clock.now();
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
  const enrollment = { name: "goldbox", csr: (await createRunnerKey(join(root, "goldbox"))).csr };
  const { runnerId } = await control.enroll({
    ...enrollment,
    token: control.createEnrollment(owner, enrollment).token,
  });
  db.run("UPDATE runner SET status='active', last_seen_at=? WHERE id=?", [Date.now(), runnerId]);
  db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [runnerId]);
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [runnerId]);

  let reviewerRunnerId = runnerId;
  if (input.reviewerRunner) {
    const reviewEnrollment = {
      name: "reviewbox",
      csr: (await createRunnerKey(join(root, "reviewbox"))).csr,
    };
    reviewerRunnerId = (
      await control.enroll({
        ...reviewEnrollment,
        token: control.createEnrollment(owner, reviewEnrollment).token,
      })
    ).runnerId;
    db.run("UPDATE runner SET status='active', last_seen_at=? WHERE id=?", [
      Date.now(),
      reviewerRunnerId,
    ]);
    db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [reviewerRunnerId]);
  }
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',1)", [
    reviewerRunnerId,
  ]);

  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  work.heartbeat(runnerId, input.capacity);
  work.heartbeat(reviewerRunnerId, input.capacity);
  const results = createRunnerResults({ db, work });
  const health = createRunnerHealth({ db, work });
  const prepared = new Map<string, Set<string>>();
  const basePlacement = createRunnerPlacement({ db });
  const trackedPlacement: RunnerPlacement = {
    ...basePlacement,
    async candidates(request) {
      const candidates = await basePlacement.candidates(request);
      if (!input.reviewerRunner) return candidates;
      const target = request.role === "reviewer" ? reviewerRunnerId : runnerId;
      return candidates.filter((candidate) => candidate.id === target);
    },
    started(value) {
      basePlacement.started(value);
      if (value.purpose === "prepare" && value.itemId) {
        const roles = prepared.get(value.itemId) ?? new Set<string>();
        roles.add(value.role);
        prepared.set(value.itemId, roles);
      }
    },
  };
  const placement = input.wrap?.(trackedPlacement) ?? trackedPlacement;
  const backend = createRemoteAgentRunner({
    db,
    work,
    results,
    health,
    pollIntervalMs: 5,
    placement,
    async fetchCandidate() {
      throw new Error("This fixture does not return a candidate");
    },
    async checkpointBot() {
      return { appId: "1", login: "paws[bot]", id: 1 };
    },
  });
  const identifiers = Array.from({ length: input.count }, (_, index) => `ENG-${index + 1}`);
  const tracker = createFakeTracker(
    identifiers.map((identifier, index) => ({
      linearIssueId: `issue-${index}`,
      identifier,
      title: `Task ${identifier}`,
      description: null,
      subIssues: [],
    })),
  );
  const jobs = new JobLoop(db, input.clock, { concurrency: input.count, pollMs: 5 });
  const outbox = new OutboxDispatcher(db, input.clock);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    clock: input.clock,
    pawsRoot: root,
    home: root,
    tracker,
    repositories: [{ owner: "acme", repo: "fixture", remoteUrl: GITHUB_URL }],
    scheduling: () => ({}),
    reviewRequirements: () => ({
      ok: true,
      items: [
        {
          id: "review",
          gate: "beforePR",
          independence: { differentSession: true, differentModel: false },
          parallel: false,
          failOn: "P1",
        },
      ],
    }),
    placementPollMs: input.placementPollMs,
    random: input.random,
    journal: (line) => input.lines.push(line),
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
      tryReserve: (itemId) => backend.tryReserve(itemId),
    },
  });

  const started = new Set<string>();
  const sim = { stopped: false };
  const handled = new Set<string>();
  const runnerIds = [...new Set([runnerId, reviewerRunnerId])];
  const runner = (async () => {
    while (!sim.stopped) {
      for (const simulatedRunnerId of runnerIds) {
        db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [Date.now(), simulatedRunnerId]);
        work.heartbeat(simulatedRunnerId, input.capacity);
        for (const envelope of work.commands(simulatedRunnerId)) {
          const command = JSON.parse(
            Buffer.from(envelope.payload, "base64url").toString(),
          ) as RunnerCommand;
          if (handled.has(command.id)) continue;
          handled.add(command.id);
          work.acknowledge(simulatedRunnerId, command.id);
          if (command.type === "login_check")
            health.submit(simulatedRunnerId, {
              ...receipt(command),
              login: { agent: command.agent, authenticated: true, method: "subscription" },
            });
          if (command.type === "probe")
            health.submit(simulatedRunnerId, {
              ...receipt(command),
              models: [{ id: "fixture-implement-model", name: "Fixture" }],
            });
          if (command.type === "run") {
            const item = listWorkItems(db).find((row) => row.currentRunId === command.runId);
            if (item) started.add(item.linearIdentifier);
          }
        }
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
      recover(db, item.id, input.clock.now(), input.maxAttempts ?? 10);
    }
    db.run("UPDATE job SET status='cancelled', finished_at=? WHERE queue=? AND status='pending'", [
      input.clock.now(),
      JOB_KIND.start,
    ]);
    const first = listWorkItems(db)[0]!;
    const agentInput: RunAgentOptions = {
      command: "/forbidden-local-agent",
      args: [],
      role: "implementer",
      profile: { agent: "claude", model: null },
      itemId: first.id,
      runId: first.currentRunId!,
      worktreePath: source,
      pawsRoot: root,
      prepareOnly: true,
      readOnly: true,
      checkpoint: false,
      prompt: "",
      networkGit: git,
    };
    await input.beforeStart?.(db, backend, agentInput);
    loop = jobs.run(controller.signal, (ms) => Bun.sleep(ms));
    const deadline = Date.now() + 45_000;
    const parked = () =>
      listJobs(db).filter((job) => job.queue === JOB_KIND.resume && job.status === "pending")
        .length;
    const settled = () =>
      input.ready?.(started, db) ??
      (started.size >= Math.min(input.count, input.capacity) &&
        (input.clock instanceof FakeClock ? parked() === input.count - input.capacity : true));
    while (Date.now() < deadline && !settled()) await Bun.sleep(10);
    const detail = JSON.stringify({
      started: [...started],
      parked: parked(),
      jobs: listJobs(db)
        .filter((job) => job.queue === JOB_KIND.resume)
        .map((job) => resumeLine(db, job)),
      items: listWorkItems(db).map((item) => `${item.linearIdentifier}:${item.state}`),
      lines: input.lines,
    });
    expect(started.size, detail).toBe(Math.min(input.count, input.capacity));
    if (input.clock instanceof FakeClock) {
      expect(parked(), detail).toBe(input.count - input.capacity);
    }
    for (const item of listWorkItems(db).filter((row) => started.has(row.linearIdentifier)))
      expect([...(prepared.get(item.id) ?? [])].sort()).toEqual(["implementer", "reviewer"]);
    await input.assert(started, db, backend, agentInput);
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

function recover(
  db: ReturnType<typeof migratedDatabase>,
  itemId: string,
  now: number,
  maxAttempts: number,
) {
  applyWorkItemEvent(db, itemId, "dispatched");
  const run = insertRun(db, { itemId, now, status: "active" });
  setCurrentRun(db, itemId, run.id);
  applyWorkItemEvent(db, itemId, "lease_expired");
  enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId, runId: run.id, reason: "transient_failure", retry: 0 },
    runAt: now,
    now,
    maxAttempts,
  });
}

function resumeLine(db: ReturnType<typeof migratedDatabase>, job: Job): string {
  const itemId = (job.payload as { itemId?: string }).itemId ?? "";
  return `${getWorkItem(db, itemId)?.linearIdentifier ?? itemId}:${job.status}`;
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
