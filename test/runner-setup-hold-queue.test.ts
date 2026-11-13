import { expect, test } from "bun:test";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  ensureLinearSession,
  getRunnerSetupHold,
  holdForRunnerSetup,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
  enqueueJob,
  enqueueRunnerSetupCheck,
  enqueueRunnerSetupChecks,
  setRunnerAgentSignedInSteps,
  listJobs,
  type Db,
} from "../src/db";
import { writeAgentSettings } from "../src/config";
import { createFakeTracker, type FakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import {
  itemOwnerEligibleRunnerSteps,
  itemOwnerHasEligibleRunnerSteps,
  itemOwnerRunnerSetupNeedSteps,
} from "../src/runner-placement";
import { and, eq } from "drizzle-orm";
import { seed } from "./dialects";
import { tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const DAY = 24 * 60 * 60 * 1000;
const START = 1_000;
const RUNNERS_URL = "https://paws.example/dashboard/runners";

/** A workspace where `other` owns one online, free runner and `me` delegates PAS-1. */
async function workspace(db: Db) {
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
  );
  const users: Record<string, string> = {};
  for (const [name, role] of [
    ["other", "admin"],
    ["me", "member"],
  ] as const) {
    users[name] = await putWorkspaceUser(db, {
      id: name,
      linearUserId: `linear-${name}`,
      name,
      email: `${name}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: "ws",
      userId: users[name]!,
      role,
      active: true,
      teamIds: ["team"],
      now: 0,
    });
  }
  await addRunner(db, "theirs", users.other!, START, 1);
  const item = await insertQueuedItem(db, { id: "mine", now: START, sessionKey: "session" });
  await seed(db, (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ linearIdentifier: "PAS-1", ownerUserId: users.me! })
      .where(eq(q.t.workItem.id, "mine")),
  );
  await ensureLinearSession(db, {
    sessionId: "session",
    issueId: item.linearIssueId,
    organizationId: "org",
    creatorId: "linear-me",
    now: START,
  });
  await recordLinearInstallation(db, {
    sessionId: "session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: 0,
  });
  await bindLinearSessionTask(db, "session", item.delegationId);
  return users;
}

function addRunner(db: Db, id: string, ownerId: string, seenAt: number, ready: number) {
  return seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id,
        workspaceId: "ws",
        ownerUserId: ownerId,
        name: id,
        status: "active",
        createdAt: 0,
        lastSeenAt: seenAt,
      }),
    (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: id, capacity: 1 }),
    (q) =>
      q.orm
        .insert(q.t.runnerAgentPolicy)
        .values(["claude", "codex"].map((agent) => ({ runnerId: id, agent, ready }))),
  );
}

function seen(db: Db, lastSeenAt: number, id?: string) {
  return seed(db, (q) =>
    q.orm
      .update(q.t.runner)
      .set({ lastSeenAt })
      .where(id === undefined ? undefined : eq(q.t.runner.id, id)),
  );
}

function signIn(db: Db, runnerId: string, agent?: string) {
  return seed(db, (q) =>
    q.orm
      .update(q.t.runnerAgentPolicy)
      .set({ ready: 1 })
      .where(
        and(
          eq(q.t.runnerAgentPolicy.runnerId, runnerId),
          agent === undefined ? undefined : eq(q.t.runnerAgentPolicy.agent, agent),
        ),
      ),
  );
}

function share(db: Db, runnerId: string, sharing: number) {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.runnerPolicy)
      .values({ runnerId, sharing })
      .onConflictDoUpdate({ target: q.t.runnerPolicy.runnerId, set: { sharing } }),
  );
}

/** The orchestrator as `src/index.ts` wires it when work runs on runners. */
function orchestrator(
  db: Db,
  clock: FakeClock,
  jobs = new JobLoop(db, clock),
  extra: { tracker?: FakeTracker; pawsRoot?: string } = {},
) {
  return new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: async () => ({}),
    runnersUrl: RUNNERS_URL,
    ownerHasRunner: (q, itemId, agent, now) =>
      itemOwnerHasEligibleRunnerSteps(q, { itemId, agent, now }),
    runnerSetupNeed: async (itemId, agent, now) =>
      db.run((q) => itemOwnerRunnerSetupNeedSteps(q, { itemId, agent, now })),
    eligibleRunner: async (itemId, agent, now) =>
      db.run((q) => itemOwnerEligibleRunnerSteps(q, { itemId, agent, now })),
    ...extra,
  });
}

async function thoughts(db: Db): Promise<string[]> {
  return (await listOutbox(db))
    .map((row) => row.payload as { kind?: string; body?: string })
    .filter((payload) => payload.kind === "thought")
    .map((payload) => payload.body ?? "");
}

async function itemJobs(db: Db, itemId: string): Promise<number> {
  return (await listJobs(db)).filter(
    (job) =>
      (job.status === "pending" || job.status === "running") &&
      (job.payload as { itemId?: string }).itemId === itemId,
  ).length;
}

test("a delegator without a runner, beside another member's free runner, is held with one thought for a day", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const paws = orchestrator(db, clock, jobs);
  try {
    const users = await workspace(db);
    await paws.reconcileExecution();
    await paws.reconcileExecution();
    expect(await getRunnerSetupHold(db, "mine")).toMatchObject({
      reason: "no-runner",
      ownerUserId: users.me,
    });
    expect(await thoughts(db)).toEqual([
      `You don't have a runner Paws can use yet. Create a VM or add a host here: ${RUNNERS_URL}. I'll start on my own once it's ready.`,
    ]);
    expect(await itemJobs(db, "mine")).toBe(0);

    // A fake day later, with the other runner still online and free: no new write, no job, no
    // failure.
    const outbox = (await listOutbox(db)).length;
    for (const step of [60_000, 60 * 60_000, DAY]) {
      clock.advance(step);
      await seen(db, clock.now());
      await paws.reconcileExecution();
    }
    expect((await getWorkItem(db, "mine"))?.state).toBe("queued");
    expect((await listOutbox(db)).length).toBe(outbox);
    expect(await itemJobs(db, "mine")).toBe(0);

    // The scheduler tick alone never ends the hold. The delegator's own runner queues a check,
    // and that job ends the hold and lets the scheduler start the item.
    await addRunner(db, "own", users.me!, clock.now(), 1);
    await paws.reconcileExecution();
    expect(await itemJobs(db, "mine")).toBe(0);
    while ((await jobs.tick([JOB_KIND.runnerSetupCheck])) !== null);
    expect(await getRunnerSetupHold(db, "mine")).toBeNull();
    expect(await itemJobs(db, "mine")).toBe(1);
  } finally {
    await paws.shutdown();
    await close();
  }
});

test("a delegator whose own runner needs its agent signed in hears the runner and the agent", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(START);
  const paws = orchestrator(db, clock);
  try {
    const users = await workspace(db);
    await addRunner(db, "member-vm", users.me!, START, 0);
    await paws.reconcileExecution();
    expect(await getRunnerSetupHold(db, "mine")).toMatchObject({
      reason: "agent-not-signed-in",
      runnerId: "member-vm",
    });
    expect(await thoughts(db)).toHaveLength(1);
    expect((await thoughts(db))[0]).toMatch(
      /^Your runner member-vm needs (Claude|Codex) signed in\. Sign in on the \[Runners page\]\(https:\/\/paws\.example\/dashboard\/runners\); I'll start right after\.$/,
    );
  } finally {
    await paws.shutdown();
    await close();
  }
});

const HOLD_LINE = `You don't have a runner Paws can use yet. Create a VM or add a host here: ${RUNNERS_URL}. I'll start on my own once it's ready.`;

async function checkJobs(db: Db): Promise<string[]> {
  return (await listJobs(db))
    .filter((job) => job.queue === JOB_KIND.runnerSetupCheck && job.status === "pending")
    .map((job) => (job.payload as { ownerUserId: string }).ownerUserId);
}

/** Drop the checks that setting up a fixture queued, so a test sees only its own trigger. */
function forgetChecks(db: Db) {
  return seed(db, (q) => q.orm.delete(q.t.job).where(eq(q.t.job.queue, JOB_KIND.runnerSetupCheck)));
}

/**
 * `me` holds PAS-1 for runner setup with the state `prepare` leaves, and no check is pending.
 * Returns the harness to fire one trigger and run the jobs it queued, once each.
 */
async function held(
  prepare: (db: Db, users: Record<string, string>, now: number) => Promise<void>,
) {
  const { db, close } = await tempStore();
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const paws = orchestrator(db, clock, jobs);
  const users = await workspace(db);
  await paws.reconcileExecution();
  expect(await getRunnerSetupHold(db, "mine")).not.toBeNull();
  await prepare(db, users, clock.now());
  while ((await jobs.tick([JOB_KIND.runnerSetupCheck])) !== null);
  // The prepared state alone is not enough, or the fixture would have resumed already.
  expect(await getRunnerSetupHold(db, "mine")).not.toBeNull();
  await forgetChecks(db);
  return {
    db,
    clock,
    users,
    jobs,
    /** Run every pending check once, as one job run each. */
    async runChecks() {
      let ran = 0;
      while ((await jobs.tick([JOB_KIND.runnerSetupCheck])) !== null) ran += 1;
      return ran;
    },
    async close() {
      await paws.shutdown();
      await close();
    },
  };
}

const TRIGGERS: {
  name: string;
  prepare: (db: Db, users: Record<string, string>, now: number) => Promise<void>;
  fire: (db: Db, users: Record<string, string>, now: number) => Promise<void>;
  runner: string;
}[] = [
  {
    name: "a runner they own enrolls",
    async prepare() {},
    async fire(db, users, now) {
      await addRunner(db, "own", users.me!, now, 1);
    },
    runner: "own",
  },
  {
    name: "their member VM reaches ready",
    async prepare(db, users, now) {
      // The runner is up, but placement only reaches it once the VM job finishes. Its own writes
      // are dropped here, so only the VM step queues a check.
      await addRunner(db, "vm", users.me!, now, 0);
      await seed(db, (q) =>
        q.orm.insert(q.t.memberVm).values({
          id: "vm",
          workspaceId: "ws",
          userId: users.me!,
          vmName: "paws-me",
          step: "health",
          runnerId: "vm",
          stepStartedAt: now,
          createdAt: now,
          updatedAt: now,
        }),
      );
    },
    async fire(db, _users, now) {
      await signIn(db, "vm");
      await forgetChecks(db);
      await seed(db, (q) =>
        q.orm
          .update(q.t.memberVm)
          .set({ step: "ready", updatedAt: now })
          .where(eq(q.t.memberVm.id, "vm")),
      );
    },
    runner: "vm",
  },
  {
    name: "their runner heartbeats back online",
    async prepare(db, users, now) {
      await addRunner(db, "own", users.me!, now - 10 * 60_000, 1);
    },
    async fire(db, _users, now) {
      await seen(db, now, "own");
    },
    runner: "own",
  },
  {
    name: "an agent becomes ready on their runner",
    async prepare(db, users, now) {
      await addRunner(db, "own", users.me!, now, 0);
    },
    async fire(db) {
      await signIn(db, "own");
    },
    runner: "own",
  },
  {
    name: "the project lead turns on sharing",
    async prepare(db) {
      await seed(db, (q) =>
        q.orm.insert(q.t.workItemScheduling).values({
          itemId: "mine",
          projectId: "project",
          projectKnown: 1,
          projectLeadId: "linear-other",
        }),
      );
      await share(db, "theirs", 0);
    },
    async fire(db) {
      await share(db, "theirs", 1);
    },
    runner: "theirs",
  },
];

for (const trigger of TRIGGERS)
  test(`${trigger.name} resumes the held item in one job run`, async () => {
    const fixture = await held(trigger.prepare);
    try {
      const { db, users, clock } = fixture;
      expect(await checkJobs(db)).toEqual([]);
      await trigger.fire(db, users, clock.now());
      await enqueueRunnerSetupCheck(db, users.me!, clock.now());
      expect(await checkJobs(db)).toEqual([users.me!]);
      expect(await fixture.runChecks()).toBe(1);
      expect(await getRunnerSetupHold(db, "mine")).toBeNull();
      expect(await thoughts(db)).toEqual([HOLD_LINE, `Starting PAS-1 on ${trigger.runner}.`]);
      expect(await itemJobs(db, "mine")).toBe(1);
    } finally {
      await fixture.close();
    }
  });

test("an agent signing in on their runner resumes the item held for it", async () => {
  const fixture = await held(async (db, users, now) => {
    await addRunner(db, "own", users.me!, now, 0);
    await holdForRunnerSetup(db, {
      itemId: "mine",
      ownerUserId: users.me!,
      reason: "agent-not-signed-in",
      runnerId: "own",
      agent: "claude",
      now,
    });
  });
  try {
    const { db, users, clock } = fixture;
    expect((await getRunnerSetupHold(db, "mine"))?.reason).toBe("agent-not-signed-in");
    for (const agent of ["claude", "codex"])
      await db.transaction((q) => setRunnerAgentSignedInSteps(q, "own", agent, true, clock.now()));
    expect(await checkJobs(db)).toEqual([users.me!]);
    expect(await fixture.runChecks()).toBe(1);
    expect(await getRunnerSetupHold(db, "mine")).toBeNull();
    expect(await itemJobs(db, "mine")).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("startup resumes an item held before its runner became ready", async () => {
  const fixture = await held((db, users, now) => addRunner(db, "own", users.me!, now, 0));
  try {
    const { db, users, clock } = fixture;
    await signIn(db, "own");
    expect(await checkJobs(db)).toEqual([]);
    await enqueueRunnerSetupChecks(db, clock.now());
    await enqueueRunnerSetupChecks(db, clock.now());
    expect(await checkJobs(db)).toEqual([users.me!]);
    expect(await fixture.runChecks()).toBe(1);
    expect(await getRunnerSetupHold(db, "mine")).toBeNull();
    expect(await itemJobs(db, "mine")).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("a runner that becomes usable for another member leaves this member's hold alone", async () => {
  const fixture = await held((db) => share(db, "theirs", 0));
  try {
    const { db, users, clock } = fixture;
    await addRunner(db, "third", users.other!, clock.now(), 1);
    await seen(db, clock.now() + 120_000, "theirs");
    await share(db, "theirs", 1);
    await enqueueRunnerSetupCheck(db, users.me!, clock.now());
    expect(await checkJobs(db)).toEqual([users.me!]);
    await fixture.runChecks();
    expect(await getRunnerSetupHold(db, "mine")).not.toBeNull();
    expect(await thoughts(db)).toEqual([HOLD_LINE]);
    expect(await itemJobs(db, "mine")).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("two triggers at once resume the item once", async () => {
  const fixture = await held((db, users, now) =>
    addRunner(db, "own", users.me!, now - 10 * 60_000, 0),
  );
  try {
    const { db, users, clock } = fixture;
    await seen(db, clock.now(), "own");
    await enqueueRunnerSetupCheck(db, users.me!, clock.now());
    await signIn(db, "own");
    await enqueueRunnerSetupCheck(db, users.me!, clock.now());
    expect(await checkJobs(db)).toEqual([users.me!]);
    // Two checks running at the same time still resume it once.
    await enqueueJob(db, {
      queue: JOB_KIND.runnerSetupCheck,
      payload: { ownerUserId: users.me! },
      runAt: 0,
      now: 0,
    });
    await Promise.all([
      fixture.jobs.tick([JOB_KIND.runnerSetupCheck]),
      fixture.jobs.tick([JOB_KIND.runnerSetupCheck]),
    ]);
    expect(await checkJobs(db)).toEqual([]);
    expect(await getRunnerSetupHold(db, "mine")).toBeNull();
    expect(await thoughts(db)).toEqual([HOLD_LINE, "Starting PAS-1 on own."]);
    expect(await itemJobs(db, "mine")).toBe(1);
  } finally {
    await fixture.close();
  }
});

/** Acme's default implementer is Claude; the Codex preset is reachable only through its label. */
function labelled(db: Db, clock: FakeClock, jobs: JobLoop, presets = true) {
  const pawsRoot = tempHome();
  writeAgentSettings(join(pawsRoot, "config.toml"), {
    defaults: {
      implementer: { agent: "claude", model: "acme-claude" },
      reviewer: { agent: "codex", model: "acme-review" },
    },
    ...(presets ? { presets: { Codex: { agent: "codex", model: "acme-codex" } } } : {}),
  });
  const tracker = createFakeTracker();
  const counted = { reads: 0 };
  const read = tracker.issueRepositoryHints!.bind(tracker);
  tracker.issueRepositoryHints = async (issueId, options) => {
    counted.reads += 1;
    return read(issueId, options);
  };
  const paws = orchestrator(db, clock, jobs, { tracker, pawsRoot });
  const label = async (implementer: string) =>
    tracker.repositoryHints.set((await getWorkItem(db, "mine"))!.linearIssueId, {
      mentions: [],
      issueLabels: [],
      parentLabels: [],
      projectLabels: [],
      profileLabels: { implementer },
    });
  return { paws, label, counted };
}

const onlyCodex = async (db: Db, runner: string) => {
  await seed(db, (q) =>
    q.orm
      .update(q.t.runnerAgentPolicy)
      .set({ ready: 0 })
      .where(eq(q.t.runnerAgentPolicy.runnerId, runner)),
  );
  await signIn(db, runner, "codex");
};

test("an Acme issue labelled Codex starts on its owner's Codex-only runner", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const { paws, label, counted } = labelled(db, clock, jobs);
  try {
    const users = await workspace(db);
    await addRunner(db, "own", users.me!, START, 1);
    await onlyCodex(db, "own");
    await label("Codex");
    await paws.reconcileExecution();
    expect(await getRunnerSetupHold(db, "mine")).toBeNull();
    await Bun.sleep(0);
    expect(counted.reads).toBe(1);
    expect(await getRunnerSetupHold(db, "mine")).toBeNull();
    expect(await itemJobs(db, "mine")).toBe(1);
  } finally {
    await paws.shutdown();
    await close();
  }
});

test("a labelled Acme issue is held for its labelled agent and resumes when that agent signs in", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const { paws, label, counted } = labelled(db, clock, jobs);
  try {
    const users = await workspace(db);
    await addRunner(db, "own", users.me!, START, 0);
    await label("Codex");
    await paws.reconcileExecution();
    await Bun.sleep(0);
    expect(await getRunnerSetupHold(db, "mine")).toMatchObject({
      reason: "agent-not-signed-in",
    });
    expect(await thoughts(db)).toHaveLength(1);
    expect((await thoughts(db))[0]).toContain("Codex");
    await paws.reconcileExecution();
    await Bun.sleep(0);
    expect(counted.reads).toBe(1);
    await onlyCodex(db, "own");
    clock.advance(60_000);
    await seen(db, clock.now());
    await paws.reconcileExecution();
    while ((await jobs.tick([JOB_KIND.runnerSetupCheck])) !== null);
    expect(await getRunnerSetupHold(db, "mine")).toBeNull();
    expect(await itemJobs(db, "mine")).toBe(1);
  } finally {
    await paws.shutdown();
    await close();
  }
});

test("without presets a label can't change the agent, so a hold costs no Linear read", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const { paws, counted } = labelled(db, clock, jobs, false);
  try {
    await workspace(db);
    await paws.reconcileExecution();
    await Bun.sleep(0);
    expect(counted.reads).toBe(0);
    expect(await getRunnerSetupHold(db, "mine")).toMatchObject({ reason: "no-runner" });
  } finally {
    await paws.shutdown();
    await close();
  }
});
