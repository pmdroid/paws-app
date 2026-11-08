import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  enqueueJob,
  getJob,
  getWorkItem,
  insertQueuedItem,
  insertRun,
  listItemHolds,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerCapacity,
  recordRunnerRepositories,
  runnerSlotFree,
  setJournalSink,
  slotWaitRunners,
  updateRunnerStatus,
  type RunnerHostRefusal,
} from "../src/db";
import {
  createRunnerHostRefusals,
  createRunnerPlacement,
  itemRunnerVerdicts,
} from "../src/runner-placement";
import { createRunnerWork } from "../src/runner-work";
import { dispatch } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { workspaceAdmission } from "./fake-workspace";
import { tempDb } from "./helpers";

const REPOSITORY = "pmdroid/paws-app";
const NOW = 1_800_000_000_000;

function workspaceWithRunners(db: Database) {
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
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", NOW)),
    now: NOW,
  });
  db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [workspace.id, REPOSITORY, "team"]);
  const pair = (name: string, slots: number, repositories: string[] | null) => {
    const id = workspaceId();
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, workspace.id, userId, name, NOW, NOW],
    );
    db.run("INSERT INTO runner_policy(runner_id) VALUES(?)", [id]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [id]);
    recordRunnerCapacity(db, id, slots, undefined, undefined, NOW);
    recordRunnerRepositories(db, id, repositories, NOW);
    return id;
  };
  const queue = (id: string) => {
    const [owner, repo] = REPOSITORY.split("/") as [string, string];
    const sessionKey = `session-${id}`;
    insertQueuedItem(db, { id, now: NOW, sessionKey });
    bindWorkItemRepository(db, id, {
      owner,
      repo,
      remoteUrl: `https://github.com/${REPOSITORY}.git`,
    });
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "app",
      appUserId: "app-user",
      sessionId: sessionKey,
      teamId: "team",
      observedAtMs: NOW,
    });
    const delegationId = getWorkItem(db, id)!.delegationId;
    bindLinearSessionTask(db, sessionKey, delegationId, { actorId: "owner" });
    db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [userId, id]);
  };
  const pass = (reported: RunnerHostRefusal[][] = []) =>
    dispatch(db, {
      now: NOW,
      admission: workspaceAdmission(db),
      itemRunners: (itemId) => itemRunnerVerdicts(db, { itemId, agent: "claude", now: NOW }),
      onRunnerHostRefusals: (refusals) => reported.push([...refusals]),
    });
  return { pair, queue, pass, workspace, userId };
}

test("only as many items leave queued as the runner that allows their repository has slots", () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  pair("goldbox", 6, ["other/repo"]);
  pair("agentbox", 2, [REPOSITORY]);
  for (const id of ["a", "b", "c", "d"]) queue(id);

  expect(pass()).toHaveLength(2);
});

test("a held item's reason names each runner and placement's rejection", () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  pair("goldbox", 6, ["other/repo"]);
  pair("agentbox", 1, [REPOSITORY]);
  for (const id of ["a", "b"]) queue(id);

  const admitted = pass();
  const heldId = ["a", "b"].find((id) => !admitted.includes(id))!;

  expect(listItemHolds(db).find((hold) => hold.itemId === heldId)).toEqual({
    itemId: heldId,
    reason: "slot",
    blockers: [
      `No runner can take ${REPOSITORY}: goldbox: repository not allowed in the runner's host config; agentbox: no free capacity`,
    ],
  });
});

test("every in-scope runner refusing the repository still reaches the question path", () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  pair("goldbox", 6, ["other/repo"]);
  queue("a");

  expect(pass()).toEqual(["a"]);
});

test("a runner refusing every item is reported once per runner and journaled every 10 minutes", () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const goldbox = pair("goldbox", 6, ["other/repo"]);
  pair("agentbox", 2, [REPOSITORY]);
  for (const id of ["a", "b", "c"]) queue(id);

  const reported: RunnerHostRefusal[][] = [];
  pass(reported);
  expect(reported.at(-1)).toEqual([
    {
      runnerId: goldbox,
      runnerName: "goldbox",
      repository: REPOSITORY,
      kind: "repository",
      agent: "claude",
    },
  ]);

  const refusals = createRunnerHostRefusals();
  const journaled: string[] = [];
  const restore = setJournalSink((line) => journaled.push(line));
  try {
    refusals.report(reported.at(-1)!, NOW);
    refusals.report(reported.at(-1)!, NOW + 9 * 60_000);
    refusals.report(reported.at(-1)!, NOW + 10 * 60_000);
  } finally {
    restore();
  }
  const line = `goldbox can't take ${REPOSITORY} (not in its allowed repositories)`;
  expect(journaled.filter((entry) => entry.includes(line))).toHaveLength(2);
  expect(refusals.lines(goldbox)).toEqual([line]);
});

test("a runner that accepts some of the items is not reported", () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const agentbox = pair("agentbox", 2, [REPOSITORY]);
  queue("a");

  const reported: RunnerHostRefusal[][] = [];
  pass(reported);

  expect(reported.at(-1)!.filter((entry) => entry.runnerId === agentbox)).toEqual([]);
});

function parkedRun(db: Database, id: string, runnerIds: string[], online: string[]) {
  applyWorkItemEvent(db, id, "dispatched");
  const run = insertRun(db, { itemId: id, now: NOW, status: "provisioning" });
  db.run("UPDATE work_item SET current_run_id=? WHERE id=?", [run.id, id]);
  const jobId = enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: {
      itemId: id,
      capacityWait: { since: NOW - 60_000, attempt: 3, runnerIds, online },
    },
    now: NOW + 60_000,
  });
  return { jobId, runId: run.id };
}

test("a parked item is placed on a runner as soon as it reports the repository allowed", async () => {
  const db = tempDb();
  const { pair, queue } = workspaceWithRunners(db);
  const goldbox = pair("goldbox", 6, ["other/repo"]);
  const agentbox = pair("agentbox", 1, [REPOSITORY]);
  const occupant = insertRun(db, { itemId: (queue("busy"), "busy"), now: NOW, status: "active" });
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) SELECT ?,?,workspace_id,1,0,'busy',? FROM runner WHERE id=?",
    [occupant.id, agentbox, NOW + 60 * 60_000, agentbox],
  );
  queue("parked");
  const { jobId, runId } = parkedRun(db, "parked", [agentbox], [agentbox, goldbox]);
  const waited = () =>
    (getJob(db, jobId)!.payload as { capacityWait: Parameters<typeof slotWaitRunners>[2] })
      .capacityWait;
  expect(runnerSlotFree(db, slotWaitRunners(db, runId, waited(), NOW), NOW, runId)).toBe(false);

  const clock = { now: NOW + 1_000 };
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => clock.now,
  });
  work.heartbeat(goldbox, 6, {}, undefined, undefined, undefined, undefined, undefined, [
    "other/repo",
    REPOSITORY,
  ]);

  expect(getJob(db, jobId)!.runAt).toBe(clock.now);
  expect(waited().online).toEqual([agentbox]);
  expect(
    runnerSlotFree(db, slotWaitRunners(db, runId, waited(), clock.now), clock.now, runId),
  ).toBe(true);
  const placement = createRunnerPlacement({ db, now: () => clock.now });
  const candidates = await placement.candidates({
    itemId: "parked",
    role: "implementer",
    purpose: "work",
    profile: { agent: "claude", model: null },
  });
  expect(candidates[0]?.id).toBe(goldbox);
});

test("a raised capacity and a resumed runner wake parked items; an unchanged report does not", () => {
  const db = tempDb();
  const { pair, queue, workspace, userId } = workspaceWithRunners(db);
  const agentbox = pair("agentbox", 1, [REPOSITORY]);
  queue("parked");
  const { jobId } = parkedRun(db, "parked", [agentbox], [agentbox]);
  const runAt = () => getJob(db, jobId)!.runAt;
  const parkedUntil = NOW + 60_000;

  recordRunnerCapacity(db, agentbox, 1, undefined, undefined, NOW + 1);
  recordRunnerRepositories(db, agentbox, [REPOSITORY], NOW + 1);
  expect(runAt()).toBe(parkedUntil);

  recordRunnerCapacity(db, agentbox, 2, undefined, undefined, NOW + 2);
  expect(runAt()).toBe(NOW + 2);

  db.run("UPDATE job SET run_at=? WHERE id=?", [parkedUntil, jobId]);
  updateRunnerStatus(db, {
    runnerId: agentbox,
    workspaceId: workspace.id,
    userId,
    status: "active",
    now: NOW + 3,
  });
  expect(runAt()).toBe(NOW + 3);
});
