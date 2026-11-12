import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  putWorkspaceUser,
  recordLinearInstallation,
  listJobs,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import { itemOwnerHasEligibleRunnerSteps } from "../src/runner-placement";
import { tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const DAY = 24 * 60 * 60 * 1000;
const START = 1_000;

/** A workspace where `other` owns one busy single-slot runner and `me` owns none. */
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
  await addRunner(db, "theirs", users.other!, START);
  // An item with no delegator. It takes the only slot.
  await insertQueuedItem(db, { id: "busy", now: -1, sessionKey: "busy-session" });
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

function addRunner(db: Db, id: string, ownerId: string, seenAt: number): Promise<void> {
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
        .values(["claude", "codex"].map((agent) => ({ runnerId: id, agent, ready: 1 }))),
  );
}

function orchestrator(db: Db, clock: FakeClock) {
  return new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: async () => ({}),
    ownerHasRunner: (q, itemId, agent, now) =>
      itemOwnerHasEligibleRunnerSteps(q, { itemId, agent, now }),
  });
}

async function bodies(db: Db, kind: string): Promise<string[]> {
  return (await listOutbox(db))
    .map((row) => row.payload as { kind?: string; body?: string })
    .filter((payload) => payload.kind === kind)
    .map((payload) => payload.body ?? "");
}

async function startJobs(db: Db, itemId: string): Promise<number> {
  return (await listJobs(db)).filter(
    (job) =>
      job.queue === "item.start" &&
      job.status === "pending" &&
      (job.payload as { itemId?: string }).itemId === itemId,
  ).length;
}

test("a delegator with no runner they may use is not queued behind busy slots and never times out", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(START);
  const paws = orchestrator(db, clock);
  try {
    const users = await workspace(db);
    await paws.reconcileExecution();
    await paws.reconcileExecution();
    expect(await startJobs(db, "busy")).toBe(1);
    expect((await bodies(db, "thought")).filter((body) => body.startsWith("Queued"))).toEqual([]);
    expect(
      (await bodies(db, "thought")).filter((body) => body.includes("runner you can use")),
    ).toEqual([
      "PAS-1 waits for a runner you can use. Add one on the Runners page and sign in to its agent, or ask your project lead to share theirs. Paws starts PAS-1 on its own once a runner is ready.",
    ]);

    // Well past the start timeout, with the other runner still online and busy.
    clock.advance(2 * DAY);
    await seed(db, (q) => q.orm.update(q.t.runner).set({ lastSeenAt: clock.now() }));
    await paws.reconcileExecution();
    expect((await getWorkItem(db, "mine"))?.state).toBe("queued");
    expect(await bodies(db, "error")).toEqual([]);
    expect(
      (await bodies(db, "thought")).filter((body) => body.includes("runner you can use")),
    ).toHaveLength(1);
    expect((await bodies(db, "thought")).filter((body) => body.startsWith("Queued"))).toEqual([]);

    // Once the delegator pairs a runner with a free slot, the scheduler starts the item.
    await addRunner(db, "own", users.me!, clock.now());
    await paws.reconcileExecution();
    expect(await startJobs(db, "mine")).toBe(1);
  } finally {
    await paws.shutdown();
    await close();
  }
});

test("a delegator whose only runner is busy still gets the queue notice with the position", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(START);
  const paws = orchestrator(db, clock);
  try {
    const users = await workspace(db);
    // The delegator's runner is the only active one, and the other item takes its slot.
    await seed(db, (q) =>
      q.orm.update(q.t.runner).set({ status: "paused" }).where(eq(q.t.runner.id, "theirs")),
    );
    await addRunner(db, "own", users.me!, START);
    await paws.reconcileExecution();
    expect(await startJobs(db, "busy")).toBe(1);
    expect(await startJobs(db, "mine")).toBe(0);
    expect(await bodies(db, "thought")).toContain(
      "Queued, 1st in line. 1 of 1 runner slot is busy. Paws starts PAS-1 when a slot frees.",
    );
    expect(
      (await bodies(db, "thought")).filter((body) => body.includes("runner you can use")),
    ).toEqual([]);
  } finally {
    await paws.shutdown();
    await close();
  }
});
