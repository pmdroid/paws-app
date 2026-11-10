import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  enqueueJob,
  getJob,
  holdForRunnerSetup,
  insertRun,
  listItemHolds,
  schedulerRunnerSlots,
  getWorkItem,
  runnerHasCapacity,
  recordRunnerCapacity,
  recordRunnerRepositories,
  runnerSlotFree,
  setJournalSink,
  slotWaitRunners,
  updateRunnerStatus,
  type RunnerHostRefusal,
  sqliteDb,
  type RunnerCapacityWaitState,
} from "../src/db";
import {
  createRunnerHostRefusals,
  createRunnerPlacement,
  itemRunnerVerdicts,
  SESSION_GRACE_MS,
} from "../src/runner-placement";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerHealth } from "../src/runner-health";
import { dispatch } from "../src/scheduler";
import { workspaceAdmission } from "./fake-workspace";
import { tempDb } from "./helpers";

import { workspaceWithRunners, REPOSITORY, NOW } from "./runner-slot-fixture";

test("only as many items leave queued as the runner that allows their repository has slots", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  await pair("goldbox", 6, ["other/repo"]);
  await pair("agentbox", 2, [REPOSITORY]);
  for (const id of ["a", "b", "c", "d"]) queue(id);

  expect(await pass()).toHaveLength(2);
});

test("a held item's reason names each runner and placement's rejection", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  await pair("goldbox", 6, ["other/repo"]);
  await pair("agentbox", 1, [REPOSITORY]);
  for (const id of ["a", "b"]) queue(id);

  const admitted = await pass();
  const heldId = ["a", "b"].find((id) => !admitted.includes(id))!;

  const hold = (await listItemHolds(sqliteDb(db))).find((entry) => entry.itemId === heldId);
  expect(hold).toMatchObject({ itemId: heldId, reason: "slot" });
  expect(hold?.blockers[0]).toStartWith(`No runner can take ${REPOSITORY}: `);
  expect(hold?.blockers[0]).toContain(
    "goldbox: repository not allowed in the runner's host config",
  );
  expect(hold?.blockers[0]).toContain("agentbox: no free capacity");
});

test("every in-scope runner refusing the repository leaves the item queued", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  await pair("goldbox", 6, ["other/repo"]);
  queue("a");

  expect(await pass()).toEqual([]);
  expect((await listItemHolds(sqliteDb(db)))[0]?.blockers[0]).toContain(
    "goldbox: repository not allowed",
  );
});

test("a runner refusing every item is reported once per runner and journaled every 10 minutes", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const goldbox = await pair("goldbox", 6, ["other/repo"]);
  await pair("agentbox", 2, [REPOSITORY]);
  for (const id of ["a", "b", "c"]) queue(id);

  const reported: RunnerHostRefusal[][] = [];
  await pass(reported);
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

test("a runner that accepts some of the items is not reported", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const agentbox = await pair("agentbox", 2, [REPOSITORY]);
  queue("a");

  const reported: RunnerHostRefusal[][] = [];
  await pass(reported);

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
  const goldbox = await pair("goldbox", 6, ["other/repo"]);
  const agentbox = await pair("agentbox", 1, [REPOSITORY]);
  const occupant = insertRun(db, { itemId: (queue("busy"), "busy"), now: NOW, status: "active" });
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) SELECT ?,?,workspace_id,1,0,'busy',? FROM runner WHERE id=?",
    [occupant.id, agentbox, NOW + 60 * 60_000, agentbox],
  );
  queue("parked");
  const { jobId, runId } = parkedRun(db, "parked", [agentbox], [agentbox, goldbox]);
  const waited = () =>
    (getJob(db, jobId)!.payload as { capacityWait: RunnerCapacityWaitState }).capacityWait;
  expect(
    await runnerSlotFree(
      sqliteDb(db),
      await slotWaitRunners(sqliteDb(db), runId, waited(), NOW),
      NOW,
      runId,
    ),
  ).toBe(false);

  // This is a failover of previously placed work, not its first placement.
  const previous = await pair("previous", 1, [REPOSITORY]);
  db.run("UPDATE runner SET status='paused' WHERE id=?", [previous]);
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at,teardown_confirmed_at) SELECT ?,?,workspace_id,1,0,'previous',?,?,? FROM runner WHERE id=?",
    [runId, previous, NOW - 1, NOW - 1, NOW - 1, previous],
  );
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
    await runnerSlotFree(
      sqliteDb(db),
      await slotWaitRunners(sqliteDb(db), runId, waited(), clock.now),
      clock.now,
      runId,
    ),
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

test("a raised capacity and a resumed runner wake parked items; an unchanged report does not", async () => {
  const db = tempDb();
  const { pair, queue, workspace, userId } = workspaceWithRunners(db);
  const agentbox = await pair("agentbox", 1, [REPOSITORY]);
  queue("parked");
  const { jobId } = parkedRun(db, "parked", [agentbox], [agentbox]);
  const runAt = () => getJob(db, jobId)!.runAt;
  const parkedUntil = NOW + 60_000;

  recordRunnerCapacity(db, agentbox, 1, undefined, undefined, NOW + 1);
  await recordRunnerRepositories(sqliteDb(db), agentbox, [REPOSITORY], NOW + 1);
  expect(runAt()).toBe(parkedUntil);

  recordRunnerCapacity(db, agentbox, 2, undefined, undefined, NOW + 2);
  expect(runAt()).toBe(NOW + 2);

  db.run("UPDATE job SET run_at=? WHERE id=?", [parkedUntil, jobId]);
  await updateRunnerStatus(sqliteDb(db), {
    runnerId: agentbox,
    workspaceId: workspace.id,
    userId,
    status: "active",
    now: NOW + 3,
  });
  expect(runAt()).toBe(NOW + 3);
});

test("an admission reserves only its chosen runner and placement honors that choice", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  await pair("owner", 1, null);
  const other = await pair("shared", 6, [REPOSITORY]);
  db.run("UPDATE runner_agent_policy SET virtual_finish=100 WHERE runner_id<>?", [other]);
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
  expect(await pass()).toEqual(["a-flexible", "b-exclusive"]);
  expect(await pass()).toEqual([]);
  expect(schedulerRunnerSlots(db, NOW).find((row) => row.itemId === "a-flexible")?.runnerId).toBe(
    other,
  );
  const placement = createRunnerPlacement({ db, now: () => NOW });
  const offered = await placement.candidates({
    itemId: "a-flexible",
    role: "implementer",
    purpose: "work",
    profile: { agent: "claude", model: null },
  });
  expect(offered.map((runner) => runner.id)).toEqual([other]);
});

test("an admin repository policy refusal is not a host-config warning", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const id = await pair("admin-limited", 2, [REPOSITORY]);
  db.run("UPDATE runner_repositories SET admin_repositories='[]' WHERE runner_id=?", [id]);
  queue("a");
  const verdict = itemRunnerVerdicts(db, { itemId: "a", agent: "claude", now: NOW })!;
  expect(verdict.runners[0]!.rejection).toContain("runner's page");
  expect(verdict.runners[0]!.hostConfig).toBeNull();
  const reported: RunnerHostRefusal[][] = [];
  await pass(reported);
  expect(reported.at(-1)).toEqual([]);
});

test("a reconnect with unchanged reports wakes parked work once, without waking on every heartbeat", async () => {
  const db = tempDb();
  const { pair, queue } = workspaceWithRunners(db);
  const id = await pair("reconnecting", 2, [REPOSITORY]);
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

test("offline runners never give admission an unlimited slot budget", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const id = await pair("offline-box", 6, [REPOSITORY]);
  db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [NOW - 60_000, id]);
  queue("a");
  expect(await pass()).toEqual([]);
  expect((await listItemHolds(sqliteDb(db)))[0]?.blockers[0]).toContain("offline-box: offline");
});

test("a successful background sign-in check wakes parked work", async () => {
  const db = tempDb();
  const { pair, queue } = workspaceWithRunners(db);
  const id = await pair("agentbox", 1, [REPOSITORY]);
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
  await health.submit(id, {
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

test("admission includes teardown occupancy that placement still considers full", async () => {
  const db = tempDb();
  const { pair, queue, pass, workspace } = workspaceWithRunners(db);
  const id = await pair("agentbox", 1, [REPOSITORY]);
  queue("old");
  const run = insertRun(db, { itemId: "old", now: NOW, status: "ended" });
  db.run("UPDATE work_item SET state='completed' WHERE id='old'");
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at) VALUES(?,?,?,1,0,'old',?,?)",
    [run.id, id, workspace.id, NOW - 1, NOW - 1],
  );
  queue("next");
  expect(runnerHasCapacity(db, id, NOW)).toBe(false);
  expect(await pass()).toEqual([]);
  db.run("UPDATE runner_work SET teardown_confirmed_at=? WHERE run_id=?", [NOW, run.id]);
  expect(runnerHasCapacity(db, id, NOW)).toBe(true);
  expect(await pass()).toEqual(["next"]);
});

test("an enabled but unavailable placement scope stays queued while disabled checks allow legacy dispatch", async () => {
  const db = tempDb();
  const { pair, queue } = workspaceWithRunners(db);
  await pair("agentbox", 1, [REPOSITORY]);
  queue("unknown");
  const options = { now: NOW, admission: workspaceAdmission(db) };
  expect(await dispatch(db, { ...options, itemRunners: () => null })).toEqual([]);
  expect(getWorkItem(db, "unknown")?.state).toBe("queued");
  expect((await listItemHolds(sqliteDb(db)))[0]?.blockers[0]).toContain("placement scope");
  expect(await dispatch(db, options)).toEqual(["unknown"]);
});

test("two flexible slow starts reserve different runner slots", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  await pair("one", 1, [REPOSITORY]);
  await pair("two", 1, [REPOSITORY]);
  queue("a");
  queue("b");
  expect(await pass()).toEqual(["a", "b"]);
  const slots = schedulerRunnerSlots(db, NOW);
  expect(new Set(slots.map((row) => row.runnerId)).size).toBe(2);
  expect(await pass()).toEqual([]);
  const placement = createRunnerPlacement({ db, now: () => NOW });
  for (const itemId of ["a", "b"]) {
    const offered = await placement.candidates({
      itemId,
      role: "implementer",
      purpose: "work",
      profile: { agent: "claude", model: null },
    });
    expect(offered.map((runner) => runner.id)).toEqual([
      slots.find((slot) => slot.itemId === itemId)!.runnerId!,
    ]);
  }
});

for (const failure of ["offline", "repository", "excluded"] as const)
  test(`an unusable admission choice permits failover: ${failure}`, async () => {
    const db = tempDb();
    const { pair, queue, pass } = workspaceWithRunners(db);
    const first = await pair("first", 1, [REPOSITORY]);
    const second = await pair("second", 1, [REPOSITORY]);
    db.run("UPDATE runner_agent_policy SET virtual_finish=100 WHERE runner_id=?", [second]);
    queue("item");
    expect(await pass()).toEqual(["item"]);
    expect(schedulerRunnerSlots(db, NOW)[0]!.runnerId).toBe(first);
    if (failure === "offline") db.run("UPDATE runner SET status='paused' WHERE id=?", [first]);
    if (failure === "repository")
      await recordRunnerRepositories(sqliteDb(db), first, ["other/repo"], NOW);
    const offered = await createRunnerPlacement({ db, now: () => NOW }).candidates({
      itemId: "item",
      role: "implementer",
      purpose: "work",
      profile: { agent: "claude" },
      ...(failure === "excluded" ? { excludeRunnerIds: [first] } : {}),
    });
    expect(offered.map((r) => r.id)).toEqual([second]);
    expect(schedulerRunnerSlots(db, NOW)[0]!.runnerId).toBe(second);
  });

test("admission preserves placement quota ranking over free slot count", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const normal = await pair("normal", 1, [REPOSITORY]);
  const extra = await pair("extra", 6, [REPOSITORY]);
  db.run("UPDATE runner_agent_policy SET quota_state='spent_extra' WHERE runner_id=?", [extra]);
  queue("item");
  expect(await pass()).toEqual(["item"]);
  expect(schedulerRunnerSlots(db, NOW)[0]!.runnerId).toBe(normal);
});

test("a queued resume keeps its online pin and reservation past historical ended work", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  const pinned = await pair("pinned", 1, [REPOSITORY]);
  await pair("other", 6, [REPOSITORY]);
  queue("resume");
  const run = insertRun(db, { itemId: "resume", now: NOW, status: "active" });
  db.run("UPDATE work_item SET current_run_id=? WHERE id=?", [run.id, "resume"]);
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at,teardown_confirmed_at) SELECT ?,id,workspace_id,1,0,'ended',?,?,? FROM runner WHERE id=?",
    [run.id, NOW - 1, NOW - 1, NOW - 1, pinned],
  );
  // An ended implementation run has no live occupancy, but the next turn retains its pin.
  db.run("UPDATE run SET status='ended' WHERE id=?", [run.id]);
  expect(await pass()).toEqual(["resume"]);
  expect(schedulerRunnerSlots(db, NOW)[0]!.runnerId).toBe(pinned);
  applyWorkItemEvent(db, "resume", "dispatched");
  expect(schedulerRunnerSlots(db, NOW)[0]!.runnerId).toBe(pinned);
  const offered = await createRunnerPlacement({ db, now: () => NOW }).candidates({
    itemId: "resume",
    role: "implementer",
    purpose: "work",
    profile: { agent: "claude" },
    pinnedRunnerId: pinned,
  });
  expect(offered.map((r) => r.id)).toEqual([pinned]);
});

test("unavailable session authority holds only its item and does not abort unrelated admission", async () => {
  const db = tempDb();
  const { pair, queue, pass } = workspaceWithRunners(db);
  await pair("agentbox", 2, [REPOSITORY]);
  queue("a-stopped");
  queue("b-ready");
  db.run("UPDATE linear_session SET stopped_at=? WHERE session_id=?", [NOW, "session-a-stopped"]);
  expect(itemRunnerVerdicts(db, { itemId: "a-stopped", agent: "claude", now: NOW })).toBeNull();
  expect(await pass()).toEqual(["b-ready"]);
  expect(getWorkItem(db, "a-stopped")?.state).toBe("queued");
});

test("a queued restart reuses its active run's held slot without admitting unrelated work", async () => {
  const db = tempDb();
  const { pair, queue, pass, workspace } = workspaceWithRunners(db);
  const pinned = await pair("pinned", 1, [REPOSITORY]);
  queue("a-unrelated");
  queue("b-resume");
  const run = insertRun(db, { itemId: "b-resume", now: NOW, status: "active" });
  db.run("UPDATE work_item SET current_run_id=? WHERE id=?", [run.id, "b-resume"]);
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at,teardown_confirmed_at) VALUES(?,?,?,1,0,'ended',?,?,?)",
    [run.id, pinned, workspace.id, NOW - 1, NOW - 1, NOW - 1],
  );
  expect(await pass()).toEqual(["b-resume"]);
  expect(getWorkItem(db, "a-unrelated")?.state).toBe("queued");
  expect(schedulerRunnerSlots(db, NOW).find((row) => row.itemId === "b-resume")?.runnerId).toBe(
    pinned,
  );
  const offered = await createRunnerPlacement({ db, now: () => NOW }).candidates({
    itemId: "b-resume",
    role: "implementer",
    purpose: "work",
    profile: { agent: "claude" },
    pinnedRunnerId: pinned,
  });
  expect(offered.map((row) => row.id)).toEqual([pinned]);
});

test("sign-in host warnings persist while queued work is held for runner setup", async () => {
  const db = tempDb();
  const { pair, queue, pass, userId } = workspaceWithRunners(db);
  const runnerId = await pair("unsigned", 1, [REPOSITORY]);
  db.run("UPDATE runner_agent_policy SET ready=0 WHERE runner_id=?", [runnerId]);
  queue("held");
  const reports: RunnerHostRefusal[][] = [];
  await pass(reports);
  expect(reports.at(-1)).toHaveLength(1);
  holdForRunnerSetup(db, {
    itemId: "held",
    ownerUserId: userId,
    reason: "agent-not-signed-in",
    runnerId,
    agent: "claude",
    now: NOW,
  });
  const refusals = createRunnerHostRefusals();
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await pass(reports)).toEqual([]);
    refusals.report(reports.at(-1)!, NOW);
    expect(refusals.lines(runnerId)).toHaveLength(1);
  }
});

test("admission fails over from a busy session runner once session grace ends", async () => {
  const db = tempDb();
  const { pair, queue, workspace } = workspaceWithRunners(db);
  const holder = await pair("holder", 1, [REPOSITORY]);
  const other = await pair("other", 1, [REPOSITORY]);
  queue("busy");
  applyWorkItemEvent(db, "busy", "dispatched");
  const occupant = insertRun(db, { itemId: "busy", now: NOW, status: "active" });
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,1,0,'busy',?)",
    [occupant.id, holder, workspace.id, NOW + 60 * 60_000],
  );
  queue("resumes");
  const earlier = insertRun(db, { itemId: "resumes", now: NOW, status: "ended" });
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at,teardown_confirmed_at) VALUES(?,?,?,1,0,'earlier',?,?,?)",
    [earlier.id, holder, workspace.id, NOW, NOW, NOW],
  );
  const payload = Buffer.from(
    JSON.stringify({ runnerId: holder, runId: earlier.id, profile: { agent: "claude" } }),
  ).toString("base64url");
  db.run(
    "INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at) VALUES('earlier',?,?,1,'run',?,?)",
    [holder, earlier.id, JSON.stringify({ payload }), NOW + 60 * 60_000],
  );
  db.run(
    "INSERT INTO runner_result(run_id,generation,command_id,payload,received_at) VALUES(?,1,'earlier',?,?)",
    [earlier.id, JSON.stringify({ stopReason: "end_turn", sessionId: "held-session" }), NOW],
  );
  // Each pass asks placement afresh, as the scheduler does on its 30 second tick.
  const pass = (now: number) => {
    db.run("UPDATE runner SET last_seen_at=?", [now]);
    return dispatch(db, {
      now,
      admission: workspaceAdmission(db),
      itemRunners: (itemId) => itemRunnerVerdicts(db, { itemId, agent: "claude", now }),
    });
  };

  for (let waited = 0; waited < SESSION_GRACE_MS; waited += 30_000)
    expect(await pass(NOW + waited)).toEqual([]);

  expect(await pass(NOW + SESSION_GRACE_MS)).toEqual(["resumes"]);
  expect(schedulerRunnerSlots(db, NOW + SESSION_GRACE_MS)).toContainEqual(
    expect.objectContaining({ itemId: "resumes", runnerId: other }),
  );
});
