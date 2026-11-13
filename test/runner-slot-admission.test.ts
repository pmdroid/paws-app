import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "bun:test";
import { eq, ne } from "drizzle-orm";
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
  syncSteps,
  type RunnerCapacityWaitState,
  type Db,
  type Q,
} from "../src/db";
import {
  createRunnerHostRefusals,
  createRunnerPlacement,
  itemRunnerVerdictsSteps,
  SESSION_GRACE_MS,
} from "../src/runner-placement";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerHealth } from "../src/runner-health";
import { dispatch } from "../src/scheduler";
import { workspaceAdmission } from "./fake-workspace";
import { workspaceWithRunners, REPOSITORY, NOW } from "./runner-slot-fixture";
import { tempStore } from "./pglite";
import { json, seed } from "./dialects";

type Work = {
  runId: string;
  runnerId: string;
  workspaceId: string;
  commandId: string;
  leaseUntil: number;
  endedAt?: number;
  teardownConfirmedAt?: number;
};

function insertRunnerWork(db: Db, work: Work) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerWork).values({ generation: 1, runnerFence: 0, ...work }),
  );
}

function setCurrentRun(db: Db, itemId: string, runId: string) {
  return seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ currentRunId: runId }).where(eq(q.t.workItem.id, itemId)),
  );
}

function setJobRunAt(db: Db, jobId: number, runAt: number) {
  return seed(db, (q) => q.orm.update(q.t.job).set({ runAt }).where(eq(q.t.job.id, jobId)));
}

function setRunner(db: Db, id: string, values: { status?: string; lastSeenAt?: number }) {
  return seed(db, (q) => q.orm.update(q.t.runner).set(values).where(eq(q.t.runner.id, id)));
}

type AgentPolicy = {
  virtualFinish?: number;
  ready?: number;
  authExpired?: number;
  quotaState?: string;
};

function setAgentPolicy(db: Db, where: (q: Q) => ReturnType<typeof eq>, values: AgentPolicy) {
  return seed(db, (q) => q.orm.update(q.t.runnerAgentPolicy).set(values).where(where(q)));
}

test("only as many items leave queued as the runner that allows their repository has slots", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  await pair("goldbox", 6, ["other/repo"]);
  await pair("agentbox", 2, [REPOSITORY]);
  for (const id of ["a", "b", "c", "d"]) await queue(id);

  expect(await pass()).toHaveLength(2);
});

test("a held item's reason names each runner and placement's rejection", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  await pair("goldbox", 6, ["other/repo"]);
  await pair("agentbox", 1, [REPOSITORY]);
  for (const id of ["a", "b"]) await queue(id);

  const admitted = await pass();
  const heldId = ["a", "b"].find((id) => !admitted.includes(id))!;

  const hold = (await listItemHolds(db)).find((entry) => entry.itemId === heldId);
  expect(hold).toMatchObject({ itemId: heldId, reason: "slot" });
  expect(hold?.blockers[0]).toStartWith(`No runner can take ${REPOSITORY}: `);
  expect(hold?.blockers[0]).toContain(
    "goldbox: repository not allowed in the runner's host config",
  );
  expect(hold?.blockers[0]).toContain("agentbox: no free capacity");
});

test("every in-scope runner refusing the repository leaves the item queued", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  await pair("goldbox", 6, ["other/repo"]);
  await queue("a");

  expect(await pass()).toEqual([]);
  expect((await listItemHolds(db))[0]?.blockers[0]).toContain("goldbox: repository not allowed");
});

test("a runner refusing every item is reported once per runner and journaled every 10 minutes", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  const goldbox = await pair("goldbox", 6, ["other/repo"]);
  await pair("agentbox", 2, [REPOSITORY]);
  for (const id of ["a", "b", "c"]) await queue(id);

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
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  const agentbox = await pair("agentbox", 2, [REPOSITORY]);
  await queue("a");

  const reported: RunnerHostRefusal[][] = [];
  await pass(reported);

  expect(reported.at(-1)!.filter((entry) => entry.runnerId === agentbox)).toEqual([]);
});

async function parkedRun(db: Db, id: string, runnerIds: string[], online: string[]) {
  await applyWorkItemEvent(db, id, "dispatched");
  const run = await insertRun(db, { itemId: id, now: NOW, status: "provisioning" });
  await setCurrentRun(db, id, run.id);
  const jobId = await enqueueJob(db, {
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
  const db = (await tempStore()).db;
  const { pair, queue, workspace } = await workspaceWithRunners(db);
  const goldbox = await pair("goldbox", 6, ["other/repo"]);
  const agentbox = await pair("agentbox", 1, [REPOSITORY]);
  const occupant = await insertRun(db, {
    itemId: (await queue("busy"), "busy"),
    now: NOW,
    status: "active",
  });
  await insertRunnerWork(db, {
    runId: occupant.id,
    runnerId: agentbox,
    workspaceId: workspace.id,
    commandId: "busy",
    leaseUntil: NOW + 60 * 60_000,
  });
  await queue("parked");
  const { jobId, runId } = await parkedRun(db, "parked", [agentbox], [agentbox, goldbox]);
  const waited = async () =>
    ((await getJob(db, jobId))!.payload as { capacityWait: RunnerCapacityWaitState }).capacityWait;
  expect(
    await runnerSlotFree(db, await slotWaitRunners(db, runId, await waited(), NOW), NOW, runId),
  ).toBe(false);

  // This is a failover of previously placed work, not its first placement.
  const previous = await pair("previous", 1, [REPOSITORY]);
  await setRunner(db, previous, { status: "paused" });
  await insertRunnerWork(db, {
    runId,
    runnerId: previous,
    workspaceId: workspace.id,
    commandId: "previous",
    leaseUntil: NOW - 1,
    endedAt: NOW - 1,
    teardownConfirmedAt: NOW - 1,
  });
  const clock = { now: NOW + 1_000 };
  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => clock.now,
  });
  await work.heartbeat(goldbox, 6, {}, undefined, undefined, undefined, undefined, undefined, [
    "other/repo",
    REPOSITORY,
  ]);

  expect((await getJob(db, jobId))!.runAt).toBe(clock.now);
  expect((await waited()).online).toEqual([agentbox]);
  expect(
    await runnerSlotFree(
      db,
      await slotWaitRunners(db, runId, await waited(), clock.now),
      clock.now,
      runId,
    ),
  ).toBe(true);
  const placement = createRunnerPlacement({ store: db, now: () => clock.now });
  const candidates = await placement.candidates({
    itemId: "parked",
    role: "implementer",
    purpose: "work",
    profile: { agent: "claude", model: null },
  });
  expect(candidates[0]?.id).toBe(goldbox);
});

test("a raised capacity and a resumed runner wake parked items; an unchanged report does not", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, workspace, userId } = await workspaceWithRunners(db);
  const agentbox = await pair("agentbox", 1, [REPOSITORY]);
  await queue("parked");
  const { jobId } = await parkedRun(db, "parked", [agentbox], [agentbox]);
  const runAt = async () => (await getJob(db, jobId))!.runAt;
  const parkedUntil = NOW + 60_000;

  await recordRunnerCapacity(db, agentbox, 1, undefined, undefined, NOW + 1);
  await recordRunnerRepositories(db, agentbox, [REPOSITORY], NOW + 1);
  expect(await runAt()).toBe(parkedUntil);

  await recordRunnerCapacity(db, agentbox, 2, undefined, undefined, NOW + 2);
  expect(await runAt()).toBe(NOW + 2);

  await setJobRunAt(db, jobId, parkedUntil);
  await updateRunnerStatus(db, {
    runnerId: agentbox,
    workspaceId: workspace.id,
    userId,
    status: "active",
    now: NOW + 3,
  });
  expect(await runAt()).toBe(NOW + 3);
});

test("an admission reserves only its chosen runner and placement honors that choice", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass, workspace } = await workspaceWithRunners(db);
  await pair("owner", 1, null);
  const other = await pair("shared", 6, [REPOSITORY]);
  await setAgentPolicy(db, (q) => ne(q.t.runnerAgentPolicy.runnerId, other), {
    virtualFinish: 100,
  });
  await queue("a-flexible");
  await queue("b-exclusive");
  await seed(
    db,
    (q) =>
      q.orm
        .update(q.t.workItemRepository)
        .set({ repo: "exclusive" })
        .where(eq(q.t.workItemRepository.itemId, "b-exclusive")),
    (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: workspace.id, repository: "pmdroid/exclusive", teamId: "team" }),
  );
  expect(
    (await db.run((q) =>
      itemRunnerVerdictsSteps(q, db, { itemId: "a-flexible", agent: "claude", now: NOW }),
    ))!.runners.filter((r) => r.rejection === null),
  ).toHaveLength(2);
  expect(
    (await db.run((q) =>
      itemRunnerVerdictsSteps(q, db, {
        itemId: "b-exclusive",
        agent: "claude",
        now: NOW,
      }),
    ))!.runners.find((r) => r.id === other)!.rejection,
  ).not.toBeNull();
  expect(await pass()).toEqual(["a-flexible", "b-exclusive"]);
  expect(await pass()).toEqual([]);
  expect(
    (await schedulerRunnerSlots(db, NOW)).find((row) => row.itemId === "a-flexible")?.runnerId,
  ).toBe(other);
  const placement = createRunnerPlacement({ store: db, now: () => NOW });
  const offered = await placement.candidates({
    itemId: "a-flexible",
    role: "implementer",
    purpose: "work",
    profile: { agent: "claude", model: null },
  });
  expect(offered.map((runner) => runner.id)).toEqual([other]);
});

test("an admin repository policy refusal is not a host-config warning", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  const id = await pair("admin-limited", 2, [REPOSITORY]);
  await seed(db, (q) =>
    q.orm
      .update(q.t.runnerRepositories)
      .set({ adminRepositories: json(db, []) as string })
      .where(eq(q.t.runnerRepositories.runnerId, id)),
  );
  await queue("a");
  const verdict = (await db.run((q) =>
    itemRunnerVerdictsSteps(q, db, { itemId: "a", agent: "claude", now: NOW }),
  ))!;
  expect(verdict.runners[0]!.rejection).toContain("runner's page");
  expect(verdict.runners[0]!.hostConfig).toBeNull();
  const reported: RunnerHostRefusal[][] = [];
  await pass(reported);
  expect(reported.at(-1)).toEqual([]);
});

test("a reconnect with unchanged reports wakes parked work once, without waking on every heartbeat", async () => {
  const db = (await tempStore()).db;
  const { pair, queue } = await workspaceWithRunners(db);
  const id = await pair("reconnecting", 2, [REPOSITORY]);
  await queue("parked");
  const { jobId } = await parkedRun(db, "parked", [id], [id]);
  const now = NOW + 60_000;
  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => now,
  });
  await work.heartbeat(id, 2, {}, undefined, undefined, undefined, undefined, undefined, [
    REPOSITORY,
  ]);
  expect((await getJob(db, jobId))!.runAt).toBe(now);
  await setJobRunAt(db, jobId, now + 60_000);
  await work.heartbeat(id, 2, {}, undefined, undefined, undefined, undefined, undefined, [
    REPOSITORY,
  ]);
  expect((await getJob(db, jobId))!.runAt).toBe(now + 60_000);
});

test("offline runners never give admission an unlimited slot budget", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  const id = await pair("offline-box", 6, [REPOSITORY]);
  await setRunner(db, id, { lastSeenAt: NOW - 60_000 });
  await queue("a");
  expect(await pass()).toEqual([]);
  expect((await listItemHolds(db))[0]?.blockers[0]).toContain("offline-box: offline");
});

test("a successful background sign-in check wakes parked work", async () => {
  const db = (await tempStore()).db;
  const { pair, queue } = await workspaceWithRunners(db);
  const id = await pair("agentbox", 1, [REPOSITORY]);
  await setAgentPolicy(db, (q) => eq(q.t.runnerAgentPolicy.runnerId, id), {
    ready: 0,
    authExpired: 1,
  });
  await queue("parked");
  const { jobId } = await parkedRun(db, "parked", [id], [id]);
  const at = NOW + 1;
  const work = createRunnerWork({
    store: db,
    keyId: "fixture",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    eventKey: Buffer.alloc(32, 7),
    now: () => at,
  });
  const health = createRunnerHealth({ store: db, work, now: () => at });
  expect(await health.afterSignIn(id, "claude")).toBe(true);
  const envelope = (await work.commands(id))[0]!;
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
  expect((await getJob(db, jobId))!.runAt).toBe(at);
  expect(
    (await db.run((q) =>
      itemRunnerVerdictsSteps(q, db, { itemId: "parked", agent: "claude", now: at }),
    ))!.runners[0]!.rejection,
  ).toBeNull();
});

test("admission includes teardown occupancy that placement still considers full", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass, workspace } = await workspaceWithRunners(db);
  const id = await pair("agentbox", 1, [REPOSITORY]);
  await queue("old");
  const run = await insertRun(db, { itemId: "old", now: NOW, status: "ended" });
  await seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ state: "completed" }).where(eq(q.t.workItem.id, "old")),
  );
  await insertRunnerWork(db, {
    runId: run.id,
    runnerId: id,
    workspaceId: workspace.id,
    commandId: "old",
    leaseUntil: NOW - 1,
    endedAt: NOW - 1,
  });
  await queue("next");
  expect(await runnerHasCapacity(db, id, NOW)).toBe(false);
  expect(await pass()).toEqual([]);
  await seed(db, (q) =>
    q.orm
      .update(q.t.runnerWork)
      .set({ teardownConfirmedAt: NOW })
      .where(eq(q.t.runnerWork.runId, run.id)),
  );
  expect(await runnerHasCapacity(db, id, NOW)).toBe(true);
  expect(await pass()).toEqual(["next"]);
});

test("an enabled but unavailable placement scope stays queued while disabled checks allow legacy dispatch", async () => {
  const db = (await tempStore()).db;
  const { pair, queue } = await workspaceWithRunners(db);
  await pair("agentbox", 1, [REPOSITORY]);
  await queue("unknown");
  const options = { now: NOW, admission: workspaceAdmission(db) };
  expect(await dispatch(db, { ...options, itemRunners: () => syncSteps(() => null) })).toEqual([]);
  expect((await getWorkItem(db, "unknown"))?.state).toBe("queued");
  expect((await listItemHolds(db))[0]?.blockers[0]).toContain("placement scope");
  expect(await dispatch(db, options)).toEqual(["unknown"]);
});

test("two flexible slow starts reserve different runner slots", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  await pair("one", 1, [REPOSITORY]);
  await pair("two", 1, [REPOSITORY]);
  await queue("a");
  await queue("b");
  expect(await pass()).toEqual(["a", "b"]);
  const slots = await schedulerRunnerSlots(db, NOW);
  expect(new Set(slots.map((row) => row.runnerId)).size).toBe(2);
  expect(await pass()).toEqual([]);
  const placement = createRunnerPlacement({ store: db, now: () => NOW });
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
    const db = (await tempStore()).db;
    const { pair, queue, pass } = await workspaceWithRunners(db);
    const first = await pair("first", 1, [REPOSITORY]);
    const second = await pair("second", 1, [REPOSITORY]);
    await setAgentPolicy(db, (q) => eq(q.t.runnerAgentPolicy.runnerId, second), {
      virtualFinish: 100,
    });
    await queue("item");
    expect(await pass()).toEqual(["item"]);
    expect((await schedulerRunnerSlots(db, NOW))[0]!.runnerId).toBe(first);
    if (failure === "offline") await setRunner(db, first, { status: "paused" });
    if (failure === "repository") await recordRunnerRepositories(db, first, ["other/repo"], NOW);
    const offered = await createRunnerPlacement({ store: db, now: () => NOW }).candidates({
      itemId: "item",
      role: "implementer",
      purpose: "work",
      profile: { agent: "claude" },
      ...(failure === "excluded" ? { excludeRunnerIds: [first] } : {}),
    });
    expect(offered.map((r) => r.id)).toEqual([second]);
    expect((await schedulerRunnerSlots(db, NOW))[0]!.runnerId).toBe(second);
  });

test("admission preserves placement quota ranking over free slot count", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  const normal = await pair("normal", 1, [REPOSITORY]);
  const extra = await pair("extra", 6, [REPOSITORY]);
  await setAgentPolicy(db, (q) => eq(q.t.runnerAgentPolicy.runnerId, extra), {
    quotaState: "spent_extra",
  });
  await queue("item");
  expect(await pass()).toEqual(["item"]);
  expect((await schedulerRunnerSlots(db, NOW))[0]!.runnerId).toBe(normal);
});

test("a queued resume keeps its online pin and reservation past historical ended work", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass, workspace } = await workspaceWithRunners(db);
  const pinned = await pair("pinned", 1, [REPOSITORY]);
  await pair("other", 6, [REPOSITORY]);
  await queue("resume");
  const run = await insertRun(db, { itemId: "resume", now: NOW, status: "active" });
  await setCurrentRun(db, "resume", run.id);
  await insertRunnerWork(db, {
    runId: run.id,
    runnerId: pinned,
    workspaceId: workspace.id,
    commandId: "ended",
    leaseUntil: NOW - 1,
    endedAt: NOW - 1,
    teardownConfirmedAt: NOW - 1,
  });
  // An ended implementation run has no live occupancy, but the next turn retains its pin.
  await seed(db, (q) =>
    q.orm.update(q.t.run).set({ status: "ended" }).where(eq(q.t.run.id, run.id)),
  );
  expect(await pass()).toEqual(["resume"]);
  expect((await schedulerRunnerSlots(db, NOW))[0]!.runnerId).toBe(pinned);
  await applyWorkItemEvent(db, "resume", "dispatched");
  expect((await schedulerRunnerSlots(db, NOW))[0]!.runnerId).toBe(pinned);
  const offered = await createRunnerPlacement({ store: db, now: () => NOW }).candidates({
    itemId: "resume",
    role: "implementer",
    purpose: "work",
    profile: { agent: "claude" },
    pinnedRunnerId: pinned,
  });
  expect(offered.map((r) => r.id)).toEqual([pinned]);
});

test("unavailable session authority holds only its item and does not abort unrelated admission", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass } = await workspaceWithRunners(db);
  await pair("agentbox", 2, [REPOSITORY]);
  await queue("a-stopped");
  await queue("b-ready");
  await seed(db, (q) =>
    q.orm
      .update(q.t.linearSession)
      .set({ stoppedAt: NOW })
      .where(eq(q.t.linearSession.sessionId, "session-a-stopped")),
  );
  expect(
    await db.run((q) =>
      itemRunnerVerdictsSteps(q, db, { itemId: "a-stopped", agent: "claude", now: NOW }),
    ),
  ).toBeNull();
  expect(await pass()).toEqual(["b-ready"]);
  expect((await getWorkItem(db, "a-stopped"))?.state).toBe("queued");
});

test("a queued restart reuses its active run's held slot without admitting unrelated work", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass, workspace } = await workspaceWithRunners(db);
  const pinned = await pair("pinned", 1, [REPOSITORY]);
  await queue("a-unrelated");
  await queue("b-resume");
  const run = await insertRun(db, { itemId: "b-resume", now: NOW, status: "active" });
  await setCurrentRun(db, "b-resume", run.id);
  await insertRunnerWork(db, {
    runId: run.id,
    runnerId: pinned,
    workspaceId: workspace.id,
    commandId: "ended",
    leaseUntil: NOW - 1,
    endedAt: NOW - 1,
    teardownConfirmedAt: NOW - 1,
  });
  expect(await pass()).toEqual(["b-resume"]);
  expect((await getWorkItem(db, "a-unrelated"))?.state).toBe("queued");
  expect(
    (await schedulerRunnerSlots(db, NOW)).find((row) => row.itemId === "b-resume")?.runnerId,
  ).toBe(pinned);
  const offered = await createRunnerPlacement({ store: db, now: () => NOW }).candidates({
    itemId: "b-resume",
    role: "implementer",
    purpose: "work",
    profile: { agent: "claude" },
    pinnedRunnerId: pinned,
  });
  expect(offered.map((row) => row.id)).toEqual([pinned]);
});

test("sign-in host warnings persist while queued work is held for runner setup", async () => {
  const db = (await tempStore()).db;
  const { pair, queue, pass, userId } = await workspaceWithRunners(db);
  const runnerId = await pair("unsigned", 1, [REPOSITORY]);
  await setAgentPolicy(db, (q) => eq(q.t.runnerAgentPolicy.runnerId, runnerId), { ready: 0 });
  await queue("held");
  const reports: RunnerHostRefusal[][] = [];
  await pass(reports);
  expect(reports.at(-1)).toHaveLength(1);
  await holdForRunnerSetup(db, {
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
  const db = (await tempStore()).db;
  const { pair, queue, workspace } = await workspaceWithRunners(db);
  const holder = await pair("holder", 1, [REPOSITORY]);
  const other = await pair("other", 1, [REPOSITORY]);
  await queue("busy");
  await applyWorkItemEvent(db, "busy", "dispatched");
  const occupant = await insertRun(db, { itemId: "busy", now: NOW, status: "active" });
  await insertRunnerWork(db, {
    runId: occupant.id,
    runnerId: holder,
    workspaceId: workspace.id,
    commandId: "busy",
    leaseUntil: NOW + 60 * 60_000,
  });
  await queue("resumes");
  const earlier = await insertRun(db, { itemId: "resumes", now: NOW, status: "ended" });
  await insertRunnerWork(db, {
    runId: earlier.id,
    runnerId: holder,
    workspaceId: workspace.id,
    commandId: "earlier",
    leaseUntil: NOW,
    endedAt: NOW,
    teardownConfirmedAt: NOW,
  });
  const payload = Buffer.from(
    JSON.stringify({ runnerId: holder, runId: earlier.id, profile: { agent: "claude" } }),
  ).toString("base64url");
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runnerCommand).values({
        id: "earlier",
        runnerId: holder,
        runId: earlier.id,
        generation: 1,
        kind: "run",
        envelope: json(db, { payload }) as string,
        expiresAt: NOW + 60 * 60_000,
      }),
    (q) =>
      q.orm.insert(q.t.runnerResult).values({
        runId: earlier.id,
        generation: 1,
        commandId: "earlier",
        payload: json(db, { stopReason: "end_turn", sessionId: "held-session" }) as string,
        receivedAt: NOW,
      }),
  );
  // Each pass asks placement afresh, as the scheduler does on its 30 second tick.
  const pass = async (now: number) => {
    await seed(db, (q) => q.orm.update(q.t.runner).set({ lastSeenAt: now }));
    return await dispatch(db, {
      now,
      admission: workspaceAdmission(db),
      itemRunners: (q, itemId) => itemRunnerVerdictsSteps(q, db, { itemId, agent: "claude", now }),
    });
  };

  for (let waited = 0; waited < SESSION_GRACE_MS; waited += 30_000)
    expect(await pass(NOW + waited)).toEqual([]);

  expect(await pass(NOW + SESSION_GRACE_MS)).toEqual(["resumes"]);
  expect(await schedulerRunnerSlots(db, NOW + SESSION_GRACE_MS)).toContainEqual(
    expect.objectContaining({ itemId: "resumes", runnerId: other }),
  );
});
