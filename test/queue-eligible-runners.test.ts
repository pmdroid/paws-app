import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
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
  syncWorkspaceMember,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import { itemOwnerHasEligibleRunner } from "../src/runner-placement";
import { tempDb, tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";

const DAY = 24 * 60 * 60 * 1000;
const START = 1_000;

/** A workspace where `other` owns one busy single-slot runner and `me` owns none. */
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
  addRunner(db, "theirs", users.other!, START);
  // An item with no delegator. It takes the only slot.
  insertQueuedItem(db, { id: "busy", now: -1, sessionKey: "busy-session" });
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

function addRunner(db: Database, id: string, ownerId: string, seenAt: number): void {
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'ws',?,?,'active',0,?)",
    [id, ownerId, id, seenAt],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,1)", [id]);
  for (const agent of ["claude", "codex"])
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,1)", [id, agent]);
}

function orchestrator(db: Database, clock: FakeClock) {
  return new Orchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: () => ({}),
    ownerHasRunner: (itemId, agent, now) => itemOwnerHasEligibleRunner(db, { itemId, agent, now }),
  });
}

function bodies(db: Database, kind: string): string[] {
  return listOutbox(db)
    .map((row) => row.payload as { kind?: string; body?: string })
    .filter((payload) => payload.kind === kind)
    .map((payload) => payload.body ?? "");
}

function startJobs(db: Database, itemId: string): number {
  return db
    .query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM job WHERE queue='item.start' AND status='pending' AND json_extract(payload,'$.itemId')=?",
    )
    .get(itemId)!.count;
}

test("a delegator with no runner they may use is not queued behind busy slots and never times out", async () => {
  const db = tempDb();
  const clock = new FakeClock(START);
  const paws = orchestrator(db, clock);
  try {
    const users = workspace(db);
    paws.reconcileExecution();
    paws.reconcileExecution();
    expect(startJobs(db, "busy")).toBe(1);
    expect(bodies(db, "thought").filter((body) => body.startsWith("Queued"))).toEqual([]);
    expect(bodies(db, "thought").filter((body) => body.includes("runner you can use"))).toEqual([
      "PAS-1 waits for a runner you can use. Add one on the Runners page and sign in to its agent, or ask your project lead to share theirs. Paws starts PAS-1 on its own once a runner is ready.",
    ]);

    // Well past the start timeout, with the other runner still online and busy.
    clock.advance(2 * DAY);
    db.run("UPDATE runner SET last_seen_at=?", [clock.now()]);
    paws.reconcileExecution();
    expect(getWorkItem(db, "mine")?.state).toBe("queued");
    expect(bodies(db, "error")).toEqual([]);
    expect(
      bodies(db, "thought").filter((body) => body.includes("runner you can use")),
    ).toHaveLength(1);
    expect(bodies(db, "thought").filter((body) => body.startsWith("Queued"))).toEqual([]);

    // Once the delegator pairs a runner with a free slot, the scheduler starts the item.
    addRunner(db, "own", users.me!, clock.now());
    paws.reconcileExecution();
    expect(startJobs(db, "mine")).toBe(1);
  } finally {
    await paws.shutdown();
    db.close();
  }
});

test("a delegator whose only runner is busy still gets the queue notice with the position", async () => {
  const db = tempDb();
  const clock = new FakeClock(START);
  const paws = orchestrator(db, clock);
  try {
    const users = workspace(db);
    // The delegator's runner is the only active one, and the other item takes its slot.
    db.run("UPDATE runner SET status='paused' WHERE id='theirs'");
    addRunner(db, "own", users.me!, START);
    paws.reconcileExecution();
    expect(startJobs(db, "busy")).toBe(1);
    expect(startJobs(db, "mine")).toBe(0);
    expect(bodies(db, "response")).toContain(
      "Queued, 1st in line. 1 of 1 runner slot is busy. I'll start when one frees up.",
    );
    expect(bodies(db, "thought").filter((body) => body.includes("runner you can use"))).toEqual([]);
  } finally {
    await paws.shutdown();
    db.close();
  }
});
