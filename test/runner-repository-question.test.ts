import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND, RunnerCapacityWait } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  bindWorkItemRepository,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerRepositories,
  setRunnerAdminRepositories,
  syncWorkspaceMember,
  listJobs,
  type Db,
} from "../src/db";
import { asc, eq } from "drizzle-orm";
import { Orchestrator } from "../src/loop";
import {
  itemOwnerEligibleRunnerSteps,
  itemOwnerHasEligibleRunnerSteps,
  itemOwnerRunnerSetupNeedSteps,
  itemRepositoryAllowedOnSteps,
  itemRepositoryRefusalsSteps,
} from "../src/runner-placement";
import { json, seed } from "./dialects";
import { tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const START = 1_000;
const RUNNERS_URL = "https://paws.example/dashboard/runners";

async function workspace(db: Db) {
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
  );
  await putWorkspaceUser(db, {
    id: "me",
    linearUserId: "linear-me",
    name: "me",
    email: "me@example.invalid",
  });
  await syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId: "me",
    role: "admin",
    active: true,
    teamIds: ["team"],
    now: 0,
  });
  await addRunner(db, "runner-1", START);
  const item = await insertQueuedItem(db, { id: "cli", now: START, sessionKey: "session" });
  await seed(db, (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ linearIdentifier: "DEP-12", ownerUserId: "me" })
      .where(eq(q.t.workItem.id, "cli")),
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
  await bindWorkItemRepository(db, "cli", {
    owner: "acme",
    repo: "cli",
    remoteUrl: "https://github.com/acme/cli.git",
  });
}

function addRunner(db: Db, id: string, seenAt: number) {
  return seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id,
        workspaceId: "ws",
        ownerUserId: "me",
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

function orchestrator(db: Db, clock: FakeClock, jobs: JobLoop) {
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
    repositoryRefusals: async (itemId, now) =>
      db.run((q) => itemRepositoryRefusalsSteps(q, { itemId, now })),
    repositoryAllowedOn: async (itemId, runnerId, now) =>
      db.run((q) => itemRepositoryAllowedOnSteps(q, { itemId, runnerId, now })),
  });
}

function questions(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({
          id: q.t.question.id,
          body: q.t.question.body,
          status: q.t.question.status,
          answer: q.t.question.answer,
          by: q.t.question.answeredBy,
        })
        .from(q.t.question)
        .where(eq(q.t.question.kind, "runner-repository"))
        .orderBy(asc(q.t.question.createdAt)),
    ),
  );
}

async function elicitations(db: Db): Promise<number> {
  return (await listOutbox(db)).filter((row) => row.op === "elicitation").length;
}

async function start(jobs: JobLoop) {
  while ((await jobs.tick([JOB_KIND.start, JOB_KIND.resume])) !== null);
}

async function startJobs(db: Db): Promise<number> {
  return (await listJobs(db)).filter(
    (job) =>
      (job.queue === JOB_KIND.start || job.queue === JOB_KIND.resume) &&
      (job.status === "pending" || job.status === "running") &&
      (job.payload as { itemId?: string }).itemId === "cli",
  ).length;
}

async function withPaws(
  run: (input: { db: Db; clock: FakeClock; jobs: JobLoop; paws: Orchestrator }) => Promise<void>,
) {
  const { db, close } = await tempStore();
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const paws = orchestrator(db, clock, jobs);
  try {
    await workspace(db);
    await run({ db, clock, jobs, paws });
  } finally {
    await paws.shutdown();
    await close();
  }
}

test("the only runner's host list lacks the repository: one question names the runner, the file and the repository", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    await recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    await paws.reconcileExecution();
    await start(jobs);
    expect((await getWorkItem(db, "cli"))?.state).toBe("awaiting_input");
    const [question, ...rest] = await questions(db);
    expect(rest).toEqual([]);
    expect(question!.body).toContain("No runner can run acme/cli.");
    expect(question!.body).toContain(
      "runner-1 allows only acme/monorepo in its host config (`/etc/paws-runner/config.json`, `allowedRepositories`). Add acme/cli there, or remove `allowedRepositories` so the [runner's page]",
    );
    expect(question!.body).toContain(`${RUNNERS_URL}/runner-1`);
    const asked = await elicitations(db);
    expect(asked).toBe(1);

    clock.advance(60_000);
    await seed(db, (q) => q.orm.update(q.t.runner).set({ lastSeenAt: clock.now() }));
    await paws.reconcileExecution();
    await start(jobs);
    expect(await questions(db)).toHaveLength(1);
    expect(await elicitations(db)).toBe(asked);
    expect(await startJobs(db)).toBe(0);
  });
});

test("the runner page's list refuses: the question names the runner page", async () => {
  await withPaws(async ({ db, jobs, paws }) => {
    await setRunnerAdminRepositories(db, {
      runnerId: "runner-1",
      workspaceId: "ws",
      userId: "me",
      repositories: ["acme/monorepo"],
      now: START,
    });
    await paws.reconcileExecution();
    await start(jobs);
    const [question] = await questions(db);
    expect(question!.body).toContain(
      `runner-1 allows only acme/monorepo on its [runner's page](${RUNNERS_URL}/runner-1) in Paws. Allow acme/cli there.`,
    );
    expect(question!.body).not.toContain("config.json");
  });
});

test("a runner that allows the repository is only offline: no question, and the wait says it is offline", async () => {
  const { db, close } = await tempStore();
  try {
    await workspace(db);
    await recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    await addRunner(db, "runner-2", 0);
    await recordRunnerRepositories(db, "runner-2", ["acme/cli"], 0);
    expect(
      await db.run((q) => itemRepositoryRefusalsSteps(q, { itemId: "cli", now: START + 120_000 })),
    ).toBeNull();
    expect(
      new RunnerCapacityWait([], undefined, [
        "runner-1: repository not allowed in the runner's host config",
        "runner-2: offline",
      ]).message,
    ).toStartWith("Waiting for a paired runner to come online");
    expect(
      new RunnerCapacityWait([], undefined, [
        "runner-1: repository not allowed in the runner's host config",
      ]).message,
    ).toBe(
      "Waiting for a paired runner that can take this run (runner-1: repository not allowed in the runner's host config)",
    );
  } finally {
    await close();
  }
});

test("Retry with nothing fixed asks once more; Retry after the host list is fixed places the item", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    await recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    await paws.reconcileExecution();
    await start(jobs);
    const first = (await questions(db))[0]!;
    clock.advance(1_000);
    expect(
      await paws.answerFromPaws({
        questionId: first.id,
        answer: "Retry",
        answeredBy: "me",
        answeredByName: "me",
      }),
    ).toBe("answered");
    expect(await startJobs(db)).toBe(1);
    await start(jobs);
    expect((await getWorkItem(db, "cli"))?.state).toBe("awaiting_input");
    const [, second, ...rest] = await questions(db);
    expect(rest).toEqual([]);
    expect(second!.status).toBe("open");
    expect(second!.body).toContain("runner-1 allows only acme/monorepo in its host config");

    await seed(db, (q) =>
      q.orm
        .update(q.t.runnerRepositories)
        .set({ repositories: json(db, ["acme/monorepo", "acme/cli"]) as string })
        .where(eq(q.t.runnerRepositories.runnerId, "runner-1")),
    );
    clock.advance(1_000);
    expect(
      await paws.answerFromPaws({
        questionId: second!.id,
        answer: "Retry",
        answeredBy: "me",
        answeredByName: "me",
      }),
    ).toBe("answered");
    expect((await getWorkItem(db, "cli"))?.state).toBe("queued");
    expect(await startJobs(db)).toBe(1);
    expect(
      await db.run((q) => itemRepositoryRefusalsSteps(q, { itemId: "cli", now: clock.now() })),
    ).toBeNull();
  });
});

test("a heartbeat that now allows the repository answers the question as Retry", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    await recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    await paws.reconcileExecution();
    await start(jobs);
    clock.advance(1_000);
    await recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], clock.now());
    expect(await jobs.tick([JOB_KIND.runnerRepositoryCheck])).toBeNull();
    await recordRunnerRepositories(db, "runner-1", ["acme/monorepo", "acme/cli"], clock.now());
    while ((await jobs.tick([JOB_KIND.runnerRepositoryCheck])) !== null);
    expect((await questions(db))[0]).toMatchObject({
      status: "answered",
      answer: "Retry",
      by: "runner:runner-1",
    });
    expect((await getWorkItem(db, "cli"))?.state).toBe("queued");
    expect(await startJobs(db)).toBe(1);
  });
});

test("Stop cancels the item", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    await recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    await paws.reconcileExecution();
    await start(jobs);
    clock.advance(1_000);
    expect(
      await paws.answerFromPaws({
        questionId: (await questions(db))[0]!.id,
        answer: "Stop",
        answeredBy: "me",
        answeredByName: "me",
      }),
    ).toBe("answered");
    expect((await getWorkItem(db, "cli"))?.state).toBe("cancelled");
  });
});

test("only a runner that now allows the repository answers, and it is recorded as the answerer", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    await recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    await paws.reconcileExecution();
    await start(jobs);
    clock.advance(1_000);
    await seed(db, (q) =>
      q.orm
        .update(q.t.runner)
        .set({ revokedAt: clock.now(), status: "revoked" })
        .where(eq(q.t.runner.id, "runner-1")),
    );
    await recordRunnerRepositories(db, "runner-1", ["acme/monorepo", "acme/other"], clock.now());
    while ((await jobs.tick([JOB_KIND.runnerRepositoryCheck])) !== null);
    expect((await questions(db))[0]!.status).toBe("open");
    await addRunner(db, "runner-2", clock.now());
    await recordRunnerRepositories(db, "runner-2", ["acme/cli"], clock.now());
    while ((await jobs.tick([JOB_KIND.runnerRepositoryCheck])) !== null);
    expect((await questions(db))[0]).toMatchObject({ status: "answered", by: "runner:runner-2" });
  });
});
