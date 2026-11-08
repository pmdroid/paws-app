import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  enqueueJob,
  getJob,
  insertRun,
  listItemHolds,
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
import { createRunnerHealth } from "../src/runner-health";
import { tempDb } from "./helpers";

import { workspaceWithRunners, REPOSITORY, NOW } from "./runner-slot-fixture";

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

  const hold = listItemHolds(db).find((entry) => entry.itemId === heldId);
  expect(hold).toMatchObject({ itemId: heldId, reason: "slot" });
  expect(hold?.blockers[0]).toStartWith(`No runner can take ${REPOSITORY}: `);
  expect(hold?.blockers[0]).toContain(
    "goldbox: repository not allowed in the runner's host config",
  );
  expect(hold?.blockers[0]).toContain("agentbox: no free capacity");
});

test("every in-scope runner refusing the repository leaves the item queued", () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  pair("goldbox", 6, ["other/repo"]);
  queue("a");

  expect(pass()).toEqual([]);
  expect(listItemHolds(db)[0]?.blockers[0]).toContain("goldbox: repository not allowed");
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

test("unplaced flexible work cannot hide the slot placement may take from exclusive work", () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  pair("owner", 1, null);
  const other = pair("shared", 6, [REPOSITORY]);
  queue("a-flexible");
  queue("b-exclusive");
  db.run("UPDATE work_item_repository SET repo='exclusive' WHERE item_id='b-exclusive'");
  db.run(
    "INSERT INTO workspace_repository SELECT workspace_id,'pmdroid/exclusive',team_id FROM workspace_repository LIMIT 1",
  );
  expect(
    itemRunnerVerdicts(db, { itemId: "a-flexible", agent: "claude", now: NOW })!.runners.filter(
      (r) => r.rejection === null,
    ),
  ).toHaveLength(2);
  expect(
    itemRunnerVerdicts(db, { itemId: "b-exclusive", agent: "claude", now: NOW })!.runners.find(
      (r) => r.id === other,
    )!.rejection,
  ).not.toBeNull();
  expect(pass()).toEqual(["a-flexible"]);
  expect(pass()).toEqual([]);
});

test("an admin repository policy refusal is not a host-config warning", () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const id = pair("admin-limited", 2, [REPOSITORY]);
  db.run("UPDATE runner_repositories SET admin_repositories='[]' WHERE runner_id=?", [id]);
  queue("a");
  const verdict = itemRunnerVerdicts(db, { itemId: "a", agent: "claude", now: NOW })!;
  expect(verdict.runners[0]!.rejection).toContain("runner's page");
  expect(verdict.runners[0]!.hostConfig).toBeNull();
  const reported: RunnerHostRefusal[][] = [];
  pass(reported);
  expect(reported.at(-1)).toEqual([]);
});

test("a reconnect with unchanged reports wakes parked work once, without waking on every heartbeat", () => {
  const db = tempDb();
  const { pair, queue } = workspaceWithRunners(db);
  const id = pair("reconnecting", 2, [REPOSITORY]);
  queue("parked");
  const { jobId } = parkedRun(db, "parked", [id], [id]);
  const now = NOW + 60_000;
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  work.heartbeat(id, 2, {}, undefined, undefined, undefined, undefined, undefined, [REPOSITORY]);
  expect(getJob(db, jobId)!.runAt).toBe(now);
  db.run("UPDATE job SET run_at=? WHERE id=?", [now + 60_000, jobId]);
  work.heartbeat(id, 2, {}, undefined, undefined, undefined, undefined, undefined, [REPOSITORY]);
  expect(getJob(db, jobId)!.runAt).toBe(now + 60_000);
});

test("offline runners never give admission an unlimited slot budget", () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const id = pair("offline-box", 6, [REPOSITORY]);
  db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [NOW - 60_000, id]);
  queue("a");
  expect(pass()).toEqual([]);
  expect(listItemHolds(db)[0]?.blockers[0]).toContain("offline-box: offline");
});

test("a successful background sign-in check wakes parked work", () => {
  const db = tempDb();
  const { pair, queue } = workspaceWithRunners(db);
  const id = pair("agentbox", 1, [REPOSITORY]);
  db.run("UPDATE runner_agent_policy SET ready=0,auth_expired=1 WHERE runner_id=?", [id]);
  queue("parked");
  const { jobId } = parkedRun(db, "parked", [id], [id]);
  const at = NOW + 1;
  const work = createRunnerWork({
    db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => at,
  });
  const health = createRunnerHealth({ db, work, now: () => at });
  expect(health.afterSignIn(id, "claude")).toBe(true);
  const envelope = work.commands(id)[0]!;
  const command = JSON.parse(Buffer.from(envelope.payload, "base64url").toString()) as {
    id: string;
  };
  health.submit(id, {
    executionId: "01J00000000000000000000001",
    commandId: command.id,
    role: "implementer",
    stopReason: "end_turn",
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    login: { agent: "claude", authenticated: true, method: "subscription" },
  });
  expect(getJob(db, jobId)!.runAt).toBe(at);
  expect(
    itemRunnerVerdicts(db, { itemId: "parked", agent: "claude", now: at })!.runners[0]!.rejection,
  ).toBeNull();
});
