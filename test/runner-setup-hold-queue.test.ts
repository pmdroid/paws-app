import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { FakeClock } from "../src/core";
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
import { itemOwnerHasEligibleRunner, itemOwnerRunnerSetupNeed } from "../src/runner-placement";
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
function orchestrator(db: Database, clock: FakeClock) {
  return new Orchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: () => ({}),
    runnersUrl: RUNNERS_URL,
    ownerHasRunner: (itemId, agent, now) => itemOwnerHasEligibleRunner(db, { itemId, agent, now }),
    runnerSetupNeed: (itemId, agent, now) => itemOwnerRunnerSetupNeed(db, { itemId, agent, now }),
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
  const paws = orchestrator(db, clock);
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

    // The delegator's own runner ends the hold and the scheduler starts the item.
    addRunner(db, "own", users.me!, clock.now(), 1);
    paws.reconcileExecution();
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
