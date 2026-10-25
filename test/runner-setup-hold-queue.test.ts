import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  ensureLinearSession,
  getRunnerSetupHold,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import {
  itemOwnerEligibleRunner,
  itemOwnerHasEligibleRunner,
  itemOwnerRunnerSetupNeed,
} from "../src/runner-placement";
import { tempDb, tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";

const DAY = 24 * 60 * 60 * 1000;
const START = 1_000;
const RUNNERS_URL = "https://paws.example/status/runners";

/** A workspace where `other` owns one online, free runner and `me` delegates PAS-1. */
function workspace(db: Database) {
  db.run("INSERT INTO workspace VALUES('ws','org','Workspace',0)");
  const users: Record<string, string> = {};
  for (const [name, role] of [
    ["other", "owner"],
    ["me", "member"],
  ] as const) {
    users[name] = putWorkspaceUser(db, {
      id: name,
      linearUserId: `linear-${name}`,
      name,
      email: `${name}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: "ws",
      userId: users[name]!,
      role,
      active: true,
      teamIds: ["team"],
      now: 0,
    });
  }
  addRunner(db, "theirs", users.other!, START, 1);
  const item = insertQueuedItem(db, { id: "mine", now: START, sessionKey: "session" });
  db.run("UPDATE work_item SET linear_identifier='PAS-1',owner_user_id=? WHERE id='mine'", [
    users.me!,
  ]);
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
  return users;
}

function addRunner(db: Database, id: string, ownerId: string, seenAt: number, ready: number) {
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'ws',?,?,'active',0,?)",
    [id, ownerId, id, seenAt],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,1)", [id]);
  for (const agent of ["claude", "codex"])
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,?)", [
      id,
      agent,
      ready,
    ]);
}

/** The orchestrator as `src/index.ts` wires it when work runs on runners. */
function orchestrator(db: Database, clock: FakeClock, jobs = new JobLoop(db, clock)) {
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
  });
}

function thoughts(db: Database): string[] {
  return listOutbox(db)
    .map((row) => row.payload as { kind?: string; body?: string })
    .filter((payload) => payload.kind === "thought")
    .map((payload) => payload.body ?? "");
}

function itemJobs(db: Database, itemId: string): number {
  return db
    .query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM job WHERE status IN ('pending','running') AND json_extract(payload,'$.itemId')=?",
    )
    .get(itemId)!.count;
}

test("a delegator without a runner, beside another member's free runner, is held with one thought for a day", async () => {
  const db = tempDb();
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const paws = orchestrator(db, clock, jobs);
  try {
    const users = workspace(db);
    paws.reconcileExecution();
    paws.reconcileExecution();
    expect(getRunnerSetupHold(db, "mine")).toMatchObject({
      reason: "no-runner",
      ownerUserId: users.me,
    });
    expect(thoughts(db)).toEqual([
      `You don't have a runner Paws can use yet. Create a VM or add a host here: ${RUNNERS_URL}. I'll start on my own once it's ready.`,
    ]);
    expect(itemJobs(db, "mine")).toBe(0);

    // A fake day later, with the other runner still online and free: no new write, no job, no
    // failure.
    const outbox = listOutbox(db).length;
    for (const step of [60_000, 60 * 60_000, DAY]) {
      clock.advance(step);
      db.run("UPDATE runner SET last_seen_at=?", [clock.now()]);
      paws.reconcileExecution();
    }
    expect(getWorkItem(db, "mine")?.state).toBe("queued");
    expect(listOutbox(db).length).toBe(outbox);
    expect(itemJobs(db, "mine")).toBe(0);

    // The scheduler tick alone never ends the hold. The delegator's own runner queues a check,
    // and that job ends the hold and lets the scheduler start the item.
    addRunner(db, "own", users.me!, clock.now(), 1);
    paws.reconcileExecution();
    expect(itemJobs(db, "mine")).toBe(0);
    while ((await jobs.tick([JOB_KIND.runnerSetupCheck])) !== null);
    expect(getRunnerSetupHold(db, "mine")).toBeNull();
    expect(itemJobs(db, "mine")).toBe(1);
  } finally {
    await paws.shutdown();
    db.close();
  }
});

test("a delegator whose own runner needs its agent signed in hears the runner and the agent", async () => {
  const db = tempDb();
  const clock = new FakeClock(START);
  const paws = orchestrator(db, clock);
  try {
    const users = workspace(db);
    addRunner(db, "member-vm", users.me!, START, 0);
    paws.reconcileExecution();
    expect(getRunnerSetupHold(db, "mine")).toMatchObject({
      reason: "agent-not-signed-in",
      runnerId: "member-vm",
    });
    expect(thoughts(db)).toHaveLength(1);
    expect(thoughts(db)[0]).toMatch(
      /^Your runner member-vm needs (Claude|Codex) signed in\. Sign in on the \[Runners page\]\(https:\/\/paws\.example\/status\/runners\); I'll start right after\.$/,
    );
  } finally {
    await paws.shutdown();
    db.close();
  }
});

const HOLD_LINE = `You don't have a runner Paws can use yet. Create a VM or add a host here: ${RUNNERS_URL}. I'll start on my own once it's ready.`;

function checkJobs(db: Database): string[] {
  return db
    .query<{ owner: string }, [string]>(
      "SELECT json_extract(payload,'$.ownerUserId') AS owner FROM job WHERE queue=? AND status='pending' ORDER BY id",
    )
    .all(JOB_KIND.runnerSetupCheck)
    .map((row) => row.owner);
}

/** Drop the checks that setting up a fixture queued, so a test sees only its own trigger. */
function forgetChecks(db: Database) {
  db.run("DELETE FROM job WHERE queue=?", [JOB_KIND.runnerSetupCheck]);
}

/**
 * `me` holds PAS-1 for runner setup with the state `prepare` leaves, and no check is pending.
 * Returns the harness to fire one trigger and run the jobs it queued, once each.
 */
async function held(prepare: (db: Database, users: Record<string, string>, now: number) => void) {
  const db = tempDb();
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const paws = orchestrator(db, clock, jobs);
  const users = workspace(db);
  paws.reconcileExecution();
  expect(getRunnerSetupHold(db, "mine")).not.toBeNull();
  prepare(db, users, clock.now());
  while ((await jobs.tick([JOB_KIND.runnerSetupCheck])) !== null);
  // The prepared state alone is not enough, or the fixture would have resumed already.
  expect(getRunnerSetupHold(db, "mine")).not.toBeNull();
  forgetChecks(db);
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
      db.close();
    },
  };
}

const TRIGGERS: {
  name: string;
  prepare: (db: Database, users: Record<string, string>, now: number) => void;
  fire: (db: Database, users: Record<string, string>, now: number) => void;
  runner: string;
}[] = [
  {
    name: "a runner they own enrolls",
    prepare() {},
    fire(db, users, now) {
      addRunner(db, "own", users.me!, now, 1);
    },
    runner: "own",
  },
  {
    name: "their member VM reaches ready",
    prepare(db, users, now) {
      // The runner is up, but placement only reaches it once the VM job finishes. Its own writes
      // are dropped here, so only the VM step queues a check.
      addRunner(db, "vm", users.me!, now, 0);
      db.run(
        `INSERT INTO member_vm(id,workspace_id,user_id,vm_name,step,runner_id,step_started_at,created_at,updated_at)
         VALUES('vm','ws',?,'paws-me','health','vm',?,?,?)`,
        [users.me!, now, now, now],
      );
    },
    fire(db, _users, now) {
      db.run("UPDATE runner_agent_policy SET ready=1 WHERE runner_id='vm'");
      db.run("DELETE FROM job WHERE queue=?", [JOB_KIND.runnerSetupCheck]);
      db.run("UPDATE member_vm SET step='ready',updated_at=? WHERE id='vm'", [now]);
    },
    runner: "vm",
  },
  {
    name: "their runner heartbeats back online",
    prepare(db, users, now) {
      addRunner(db, "own", users.me!, now - 10 * 60_000, 1);
    },
    fire(db, _users, now) {
      db.run("UPDATE runner SET last_seen_at=? WHERE id='own'", [now]);
    },
    runner: "own",
  },
  {
    name: "an agent becomes ready on their runner",
    prepare(db, users, now) {
      addRunner(db, "own", users.me!, now, 0);
    },
    fire(db) {
      db.run("UPDATE runner_agent_policy SET ready=1 WHERE runner_id='own'");
    },
    runner: "own",
  },
  {
    name: "the project lead turns on sharing",
    prepare(db) {
      db.run(
        "INSERT INTO work_item_scheduling(item_id,project_id,project_known,project_lead_id) VALUES('mine','project',1,'linear-other')",
      );
      db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES('theirs',0)");
    },
    fire(db) {
      db.run("UPDATE runner_policy SET sharing=1 WHERE runner_id='theirs'");
    },
    runner: "theirs",
  },
];

for (const trigger of TRIGGERS)
  test(`${trigger.name} resumes the held item in one job run`, async () => {
    const fixture = await held(trigger.prepare);
    try {
      const { db, users, clock } = fixture;
      expect(checkJobs(db)).toEqual([]);
      trigger.fire(db, users, clock.now());
      expect(checkJobs(db)).toEqual([users.me!]);
      expect(await fixture.runChecks()).toBe(1);
      expect(getRunnerSetupHold(db, "mine")).toBeNull();
      expect(thoughts(db)).toEqual([HOLD_LINE, `Starting PAS-1 on ${trigger.runner}.`]);
      expect(itemJobs(db, "mine")).toBe(1);
    } finally {
      await fixture.close();
    }
  });

test("a runner that becomes usable for another member leaves this member's hold alone", async () => {
  const fixture = await held((db) => {
    db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES('theirs',0)");
  });
  try {
    const { db, users, clock } = fixture;
    // Their own runner, not shared, queues no check for this member.
    addRunner(db, "third", users.other!, clock.now(), 1);
    db.run("UPDATE runner SET last_seen_at=? WHERE id='theirs'", [clock.now() + 120_000]);
    expect(checkJobs(db)).toEqual([]);
    // A shared runner wakes every holder, and the check finds it is not this member's to use:
    // its owner leads no project of this item.
    db.run("UPDATE runner_policy SET sharing=1 WHERE runner_id='theirs'");
    expect(checkJobs(db)).toEqual([users.me!]);
    await fixture.runChecks();
    expect(getRunnerSetupHold(db, "mine")).not.toBeNull();
    expect(thoughts(db)).toEqual([HOLD_LINE]);
    expect(itemJobs(db, "mine")).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("a runner write without a held item queues no check", () => {
  const db = tempDb();
  try {
    const users = workspace(db);
    addRunner(db, "own", users.me!, START, 0);
    db.run("UPDATE runner SET last_seen_at=? WHERE id='own'", [START + 10 * 60_000]);
    db.run("UPDATE runner_agent_policy SET ready=1 WHERE runner_id='own'");
    db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES('own',1)");
    expect(checkJobs(db)).toEqual([]);
  } finally {
    db.close();
  }
});

test("two triggers at once resume the item once", async () => {
  const fixture = await held((db, users, now) => {
    addRunner(db, "own", users.me!, now - 10 * 60_000, 0);
  });
  try {
    const { db, users, clock } = fixture;
    // Two writes that each make the runner usable queue one pending check.
    db.run("UPDATE runner SET last_seen_at=? WHERE id='own'", [clock.now()]);
    db.run("UPDATE runner_agent_policy SET ready=1 WHERE runner_id='own'");
    expect(checkJobs(db)).toEqual([users.me!]);
    // Two checks running at the same time still resume it once.
    db.run(
      "INSERT INTO job(queue,payload,run_at,created_at) VALUES(?,json_object('ownerUserId',?),0,0)",
      [JOB_KIND.runnerSetupCheck, users.me!],
    );
    await Promise.all([
      fixture.jobs.tick([JOB_KIND.runnerSetupCheck]),
      fixture.jobs.tick([JOB_KIND.runnerSetupCheck]),
    ]);
    expect(checkJobs(db)).toEqual([]);
    expect(getRunnerSetupHold(db, "mine")).toBeNull();
    expect(thoughts(db)).toEqual([HOLD_LINE, "Starting PAS-1 on own."]);
    expect(itemJobs(db, "mine")).toBe(1);
  } finally {
    await fixture.close();
  }
});
