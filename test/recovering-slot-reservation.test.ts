import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { FakeClock, JOB_KIND, systemClock, setJournalSink, type Clock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  enqueueJob,
  getWorkItem,
  insertRun,
  listJobs,
  listWorkItems,
  putWorkspaceUser,
  recordLinearInstallation,
  setCurrentRun,
  type Db,
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
import { seed } from "./dialects";
import { tempStore } from "./pglite";

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
  const clock = new FakeClock(Date.now());
  try {
    await runRecovering({
      count: 20,
      capacity: 6,
      random: () => (jitter++ % 10) / 10,
      clock,
      lines,
      async assert(started, db) {
        const pending = (await listJobs(db)).filter(
          (job) => job.queue === JOB_KIND.resume && job.status === "pending",
        );
        expect(pending).toHaveLength(14);
        expect(new Set(pending.map((job) => job.runAt)).size).toBeGreaterThan(1);
        expect(started.size, lines.join("\n")).toBe(6);
        expect(
          (await listWorkItems(db)).filter((item) =>
            ["failed", "awaiting_input"].includes(item.state),
          ),
        ).toHaveLength(0);
        const running = (await listWorkItems(db)).filter((item) =>
          started.has(item.linearIdentifier),
        );
        for (const item of running)
          expect(lines.filter((line) => line.includes(`item=${item.id}`)).join("\n")).not.toContain(
            "Waiting for a free slot",
          );
      },
    });
  } finally {
    restore();
  }
}, 150_000);

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
      ready: async (started, db) =>
        started.size === 1 &&
        (await listWorkItems(db)).some((item) => item.state === "awaiting_input"),
      wrap(placement) {
        return {
          ...placement,
          *startedSteps(q, input) {
            yield* placement.startedSteps(q, input);
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
        const failed = (await listWorkItems(db)).filter((item) => item.state === "awaiting_input");
        expect(failed.map((item) => item.linearIdentifier)).toHaveLength(1);
        expect(started.has(failed[0]!.linearIdentifier)).toBe(false);
      },
    });
  } finally {
    restore();
  }
}, 150_000);

async function runRecovering(input: {
  count: number;
  capacity: number;
  clock: Clock;
  lines: string[];
  maxAttempts?: number;
  placementPollMs?: number;
  random?: () => number;
  wrap?: (placement: RunnerPlacement) => RunnerPlacement;
  ready?: (started: Set<string>, db: Db) => Promise<boolean>;
  assert: (started: Set<string>, db: Db) => void | Promise<void>;
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

  const { db, close } = await tempStore();
  const now = input.clock.now();
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
    token: (await control.createEnrollment(owner, enrollment)).token,
  });
  await seed(
    db,
    (q) =>
      q.orm
        .update(q.t.runner)
        .set({ status: "active", lastSeenAt: Date.now() })
        .where(eq(q.t.runner.id, runnerId)),
    (q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId }),
    (q) =>
      q.orm.insert(q.t.runnerAgentPolicy).values([
        { runnerId, agent: "claude", ready: 1 },
        { runnerId, agent: "codex", ready: 1 },
      ]),
  );

  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
  });
  await work.heartbeat(runnerId, input.capacity);
  const results = createRunnerResults({ store: db, work });
  const health = createRunnerHealth({ store: db, work });
  const prepared = new Map<string, Set<string>>();
  const basePlacement = createRunnerPlacement({ store: db });
  const trackedPlacement: RunnerPlacement = {
    ...basePlacement,
    *startedSteps(q, value) {
      yield* basePlacement.startedSteps(q, value);
      if (value.purpose === "prepare" && value.itemId) {
        const roles = prepared.get(value.itemId) ?? new Set<string>();
        roles.add(value.role);
        prepared.set(value.itemId, roles);
      }
    },
  };
  const placement = input.wrap?.(trackedPlacement) ?? trackedPlacement;
  const backend = createRemoteAgentRunner({
    store: db,
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
    store: db,
    jobs,
    outbox,
    clock: input.clock,
    pawsRoot: root,
    home: root,
    tracker,
    repositories: [{ owner: "acme", repo: "fixture", remoteUrl: GITHUB_URL }],
    scheduling: async () => ({}),
    reviewRequirements: async () => ({
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
    },
  });

  const started = new Set<string>();
  const sim = { stopped: false };
  const handled = new Set<string>();
  const runnerIds = [runnerId];
  const runner = (async () => {
    while (!sim.stopped) {
      for (const simulatedRunnerId of runnerIds) {
        await seed(db, (q) =>
          q.orm
            .update(q.t.runner)
            .set({ lastSeenAt: Date.now() })
            .where(eq(q.t.runner.id, simulatedRunnerId)),
        );
        await work.heartbeat(simulatedRunnerId, input.capacity);
        for (const envelope of await work.commands(simulatedRunnerId)) {
          const command = JSON.parse(
            Buffer.from(envelope.payload, "base64url").toString(),
          ) as RunnerCommand;
          if (handled.has(command.id)) continue;
          handled.add(command.id);
          await work.acknowledge(simulatedRunnerId, command.id);
          if (command.type === "login_check")
            await health.submit(simulatedRunnerId, {
              ...receipt(command),
              login: { agent: command.agent, authenticated: true, method: "subscription" },
            });
          if (command.type === "probe")
            await health.submit(simulatedRunnerId, {
              ...receipt(command),
              models: [{ id: "fixture-implement-model", name: "Fixture" }],
            });
          if (command.type === "run") {
            const item = (await listWorkItems(db)).find(
              (row) => row.currentRunId === command.runId,
            );
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
      const item = (await listWorkItems(db)).find((row) => row.sessionKey === `session-${index}`)!;
      await recordLinearInstallation(db, {
        organizationId: "org",
        oauthClientId: "app",
        appUserId: "app-user",
        sessionId: `session-${index}`,
        teamId: "team",
        observedAtMs: now,
      });
      await bindLinearSessionTask(db, `session-${index}`, item.delegationId, {
        actorId: "owner",
      });
      await seed(db, (q) =>
        q.orm.update(q.t.workItem).set({ ownerUserId: userId }).where(eq(q.t.workItem.id, item.id)),
      );
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
      await recover(db, item.id, input.clock.now(), input.maxAttempts ?? 10);
    }
    await seed(db, (q) =>
      q.orm
        .update(q.t.job)
        .set({ status: "cancelled", finishedAt: input.clock.now() })
        .where(and(eq(q.t.job.queue, JOB_KIND.start), eq(q.t.job.status, "pending"))),
    );
    loop = jobs.run(controller.signal, (ms) => Bun.sleep(ms));
    const deadline = Date.now() + 120_000;
    const parked = async () =>
      (await listJobs(db)).filter(
        (job) => job.queue === JOB_KIND.resume && job.status === "pending",
      ).length;
    const settled = async () =>
      (await input.ready?.(started, db)) ??
      (started.size >= Math.min(input.count, input.capacity) &&
        (input.clock instanceof FakeClock
          ? (await parked()) === input.count - input.capacity
          : true));
    while (Date.now() < deadline && !(await settled())) await Bun.sleep(10);
    const detail = JSON.stringify({
      started: [...started],
      parked: await parked(),
      jobs: await Promise.all(
        (await listJobs(db))
          .filter((job) => job.queue === JOB_KIND.resume)
          .map((job) => resumeLine(db, job)),
      ),
      items: (await listWorkItems(db)).map((item) => `${item.linearIdentifier}:${item.state}`),
      lines: input.lines,
    });
    expect(started.size, detail).toBe(Math.min(input.count, input.capacity));
    if (input.clock instanceof FakeClock) {
      expect(await parked(), detail).toBe(input.count - input.capacity);
    }
    for (const item of (await listWorkItems(db)).filter((row) => started.has(row.linearIdentifier)))
      expect([...(prepared.get(item.id) ?? [])].sort()).toEqual(["implementer", "reviewer"]);
    await input.assert(started, db);
  } finally {
    controller.abort();
    sim.stopped = true;
    await runner;
    await orchestrator.shutdown().catch(() => undefined);
    await loop;
    await close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function recover(db: Db, itemId: string, now: number, maxAttempts: number) {
  await applyWorkItemEvent(db, itemId, "dispatched");
  const run = await insertRun(db, { itemId, now, status: "active" });
  await setCurrentRun(db, itemId, run.id);
  await applyWorkItemEvent(db, itemId, "lease_expired");
  await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId, runId: run.id, reason: "transient_failure", retry: 0 },
    runAt: now,
    now,
    maxAttempts,
  });
}

async function resumeLine(db: Db, job: Job): Promise<string> {
  const itemId = (job.payload as { itemId?: string }).itemId ?? "";
  return `${(await getWorkItem(db, itemId))?.linearIdentifier ?? itemId}:${job.status}`;
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
