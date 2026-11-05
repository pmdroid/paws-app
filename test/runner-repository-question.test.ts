import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
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
} from "../src/db";
import { Orchestrator } from "../src/loop";
import {
  itemOwnerEligibleRunner,
  itemOwnerHasEligibleRunner,
  itemOwnerRunnerSetupNeed,
  itemRepositoryAllowedOn,
  itemRepositoryRefusals,
} from "../src/runner-placement";
import { tempDb, tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";

const START = 1_000;
const RUNNERS_URL = "https://paws.example/dashboard/runners";

function workspace(db: Database) {
  db.run("INSERT INTO workspace VALUES('ws','org','Workspace',0)");
  putWorkspaceUser(db, {
    id: "me",
    linearUserId: "linear-me",
    name: "me",
    email: "me@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId: "me",
    role: "admin",
    active: true,
    teamIds: ["team"],
    now: 0,
  });
  addRunner(db, "runner-1", START);
  const item = insertQueuedItem(db, { id: "cli", now: START, sessionKey: "session" });
  db.run("UPDATE work_item SET linear_identifier='DEP-12',owner_user_id='me' WHERE id='cli'");
  ensureLinearSession(db, {
    sessionId: "session",
    issueId: item.linearIssueId,
    organizationId: "org",
    creatorId: "linear-me",
    now: START,
  });
  recordLinearInstallation(db, {
    sessionId: "session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: 0,
  });
  bindLinearSessionTask(db, "session", item.delegationId);
  bindWorkItemRepository(db, "cli", {
    owner: "acme",
    repo: "cli",
    remoteUrl: "https://github.com/acme/cli.git",
  });
}

function addRunner(db: Database, id: string, seenAt: number) {
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'ws','me',?,'active',0,?)",
    [id, id, seenAt],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,1)", [id]);
  for (const agent of ["claude", "codex"])
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,1)", [id, agent]);
}

function orchestrator(db: Database, clock: FakeClock, jobs: JobLoop) {
  return new Orchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: () => ({}),
    runnersUrl: RUNNERS_URL,
    ownerHasRunner: (itemId, agent, now) => itemOwnerHasEligibleRunner(db, { itemId, agent, now }),
    runnerSetupNeed: (itemId, agent, now) => itemOwnerRunnerSetupNeed(db, { itemId, agent, now }),
    eligibleRunner: (itemId, agent, now) => itemOwnerEligibleRunner(db, { itemId, agent, now }),
    repositoryRefusals: (itemId, now) => itemRepositoryRefusals(db, { itemId, now }),
    repositoryAllowedOn: (itemId, runnerId, now) =>
      itemRepositoryAllowedOn(db, { itemId, runnerId, now }),
  });
}

function questions(db: Database) {
  return db
    .query<
      { id: string; body: string; status: string; answer: string | null; by: string | null },
      []
    >(
      "SELECT id,body,status,answer,answered_by AS by FROM question WHERE kind='runner-repository' ORDER BY rowid",
    )
    .all();
}

function elicitations(db: Database): number {
  return listOutbox(db).filter((row) => row.op === "elicitation").length;
}

async function start(jobs: JobLoop) {
  while ((await jobs.tick([JOB_KIND.start, JOB_KIND.resume])) !== null);
}

function startJobs(db: Database): number {
  return db
    .query<{ count: number }, [string, string]>(
      `SELECT count(*) AS count FROM job WHERE queue IN (?,?) AND status IN ('pending','running')
       AND json_extract(payload,'$.itemId')='cli'`,
    )
    .get(JOB_KIND.start, JOB_KIND.resume)!.count;
}

async function withPaws(
  run: (input: {
    db: Database;
    clock: FakeClock;
    jobs: JobLoop;
    paws: Orchestrator;
  }) => Promise<void>,
) {
  const db = tempDb();
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const paws = orchestrator(db, clock, jobs);
  try {
    workspace(db);
    await run({ db, clock, jobs, paws });
  } finally {
    await paws.shutdown();
    db.close();
  }
}

test("the only runner's host list lacks the repository: one question names the runner, the file and the repository", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    paws.reconcileExecution();
    await start(jobs);
    expect(getWorkItem(db, "cli")?.state).toBe("awaiting_input");
    const [question, ...rest] = questions(db);
    expect(rest).toEqual([]);
    expect(question!.body).toContain("No runner can run acme/cli.");
    expect(question!.body).toContain(
      "runner-1 allows only acme/monorepo in its host config (`/etc/paws-runner/config.json`, `allowedRepositories`). Add acme/cli there and restart `paws-runner.service`",
    );
    expect(question!.body).toContain(`${RUNNERS_URL}/runner-1`);
    const asked = elicitations(db);
    expect(asked).toBe(1);

    clock.advance(60_000);
    db.run("UPDATE runner SET last_seen_at=?", [clock.now()]);
    paws.reconcileExecution();
    await start(jobs);
    expect(questions(db)).toHaveLength(1);
    expect(elicitations(db)).toBe(asked);
    expect(startJobs(db)).toBe(0);
  });
});

test("the runner page's list refuses: the question names the runner page", async () => {
  await withPaws(async ({ db, jobs, paws }) => {
    setRunnerAdminRepositories(db, {
      runnerId: "runner-1",
      workspaceId: "ws",
      userId: "me",
      repositories: ["acme/monorepo"],
      now: START,
    });
    paws.reconcileExecution();
    await start(jobs);
    const [question] = questions(db);
    expect(question!.body).toContain(
      `runner-1 allows only acme/monorepo on its [runner's page](${RUNNERS_URL}/runner-1) in Paws. Allow acme/cli there.`,
    );
    expect(question!.body).not.toContain("config.json");
  });
});

test("a runner that allows the repository is only offline: no question, and the wait says it is offline", () => {
  const db = tempDb();
  try {
    workspace(db);
    recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    addRunner(db, "runner-2", 0);
    recordRunnerRepositories(db, "runner-2", ["acme/cli"], 0);
    expect(itemRepositoryRefusals(db, { itemId: "cli", now: START + 120_000 })).toBeNull();
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
    db.close();
  }
});

test("Retry with nothing fixed asks once more; Retry after the host list is fixed places the item", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    paws.reconcileExecution();
    await start(jobs);
    const first = questions(db)[0]!;
    clock.advance(1_000);
    expect(
      await paws.answerFromPaws({
        questionId: first.id,
        answer: "Retry",
        answeredBy: "me",
        answeredByName: "me",
      }),
    ).toBe("answered");
    expect(startJobs(db)).toBe(1);
    await start(jobs);
    expect(getWorkItem(db, "cli")?.state).toBe("awaiting_input");
    const [, second, ...rest] = questions(db);
    expect(rest).toEqual([]);
    expect(second!.status).toBe("open");
    expect(second!.body).toContain("runner-1 allows only acme/monorepo in its host config");

    db.run("UPDATE runner_repositories SET repositories=? WHERE runner_id='runner-1'", [
      JSON.stringify(["acme/monorepo", "acme/cli"]),
    ]);
    clock.advance(1_000);
    expect(
      await paws.answerFromPaws({
        questionId: second!.id,
        answer: "Retry",
        answeredBy: "me",
        answeredByName: "me",
      }),
    ).toBe("answered");
    expect(getWorkItem(db, "cli")?.state).toBe("queued");
    expect(startJobs(db)).toBe(1);
    expect(itemRepositoryRefusals(db, { itemId: "cli", now: clock.now() })).toBeNull();
  });
});

test("a heartbeat that now allows the repository answers the question as Retry", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    paws.reconcileExecution();
    await start(jobs);
    clock.advance(1_000);
    recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], clock.now());
    expect(await jobs.tick([JOB_KIND.runnerRepositoryCheck])).toBeNull();
    recordRunnerRepositories(db, "runner-1", ["acme/monorepo", "acme/cli"], clock.now());
    while ((await jobs.tick([JOB_KIND.runnerRepositoryCheck])) !== null);
    expect(questions(db)[0]).toMatchObject({
      status: "answered",
      answer: "Retry",
      by: "runner:runner-1",
    });
    expect(getWorkItem(db, "cli")?.state).toBe("queued");
    expect(startJobs(db)).toBe(1);
  });
});

test("Stop cancels the item", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    paws.reconcileExecution();
    await start(jobs);
    clock.advance(1_000);
    expect(
      await paws.answerFromPaws({
        questionId: questions(db)[0]!.id,
        answer: "Stop",
        answeredBy: "me",
        answeredByName: "me",
      }),
    ).toBe("answered");
    expect(getWorkItem(db, "cli")?.state).toBe("cancelled");
  });
});

test("only a runner that now allows the repository answers, and it is recorded as the answerer", async () => {
  await withPaws(async ({ db, clock, jobs, paws }) => {
    recordRunnerRepositories(db, "runner-1", ["acme/monorepo"], START);
    paws.reconcileExecution();
    await start(jobs);
    clock.advance(1_000);
    db.run("UPDATE runner SET revoked_at=?,status='revoked' WHERE id='runner-1'", [clock.now()]);
    recordRunnerRepositories(db, "runner-1", ["acme/monorepo", "acme/other"], clock.now());
    while ((await jobs.tick([JOB_KIND.runnerRepositoryCheck])) !== null);
    expect(questions(db)[0]!.status).toBe("open");
    addRunner(db, "runner-2", clock.now());
    recordRunnerRepositories(db, "runner-2", ["acme/cli"], clock.now());
    while ((await jobs.tick([JOB_KIND.runnerRepositoryCheck])) !== null);
    expect(questions(db)[0]).toMatchObject({ status: "answered", by: "runner:runner-2" });
  });
});
