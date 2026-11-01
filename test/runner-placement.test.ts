import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  insertRun,
  enqueueJob,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerRepositories,
  syncWorkspaceMember,
} from "../src/db";
import {
  createRunnerPlacement,
  createRunnerPlacementBrowser,
  LOAD_HISTORY_MS,
  SESSION_GRACE_MS,
  type PlacementRequest,
} from "../src/runner-placement";
import { RunnerCapacityWait, placementWaitMs } from "../src/core";
import { saveSchedulingContext } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { probeRunnerPlacement } from "./local/runner-placement";

async function networkRequests(run: () => Promise<unknown>) {
  const real = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error("Placement must not reach the network");
  }) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  return requests;
}

async function placeItem(bindTask = true) {
  const root = mkdtempSync(join(tmpdir(), "paws-placement-owner-"));
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = Date.now();
  let clock = now;
  const owner = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const colleague = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "colleague",
    name: "Colleague",
    email: "colleague@example.invalid",
  });
  const pool = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "pool",
    name: "Pool",
    email: "pool@example.invalid",
  });
  const token = issueWorkspaceBootstrap(db, "org", now);
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: owner,
    tokenHash: workspaceTokenHash(token),
    now,
  });
  for (const userId of [colleague, pool])
    syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app-client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  if (bindTask) bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  db.run("UPDATE work_item SET owner_user_id=? WHERE id=?", [owner, item.id]);
  for (const [id, userId, sharing] of [
    ["own", owner, 0],
    ["second", owner, 0],
    ["shared", colleague, 1],
    ["api", pool, 1],
    ["unshared", pool, 0],
  ] as const) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, workspace.id, userId, id, now, now],
    );
    db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES(?,?)", [id, sharing]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',1)", [id]);
  }
  const placement = createRunnerPlacement({
    db,
    now: () => clock,
  });
  return {
    root,
    db,
    placement,
    workspaceId: workspace.id,
    owner,
    now: () => clock,
    tick(ms: number) {
      clock += ms;
      db.run("UPDATE runner SET last_seen_at=?", [clock]);
    },
    async ids(request: Partial<PlacementRequest> = {}) {
      return (
        await placement.candidates({
          itemId: item.id,
          profile: { agent: "codex", model: "implementation-model" },
          role: "implementer" as const,
          purpose: "work" as const,
          ...request,
        })
      ).map((row) => row.id);
    },
  };
}

test("Runner placement uses actual ownership, explicit sharing, provider evidence and independent review", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-placement-"));
  try {
    const observations: boolean[] = [];
    await probeRunnerPlacement(root, (_name, passed) => observations.push(passed));
    expect(observations).toHaveLength(13);
    expect(observations.every(Boolean)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a solo item runs on its owner's runners and not another member's shared runner", async () => {
  const placed = await placeItem();
  try {
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("work goes only to runners whose reported repositories include the item's repository", async () => {
  const placed = await placeItem();
  try {
    bindWorkItemRepository(placed.db, "item", {
      owner: "Acme",
      repo: "Looky",
      remoteUrl: "https://github.com/Acme/Looky.git",
    });
    placed.db.run("INSERT INTO workspace_repository VALUES(?,?,?)", [
      placed.workspaceId,
      "acme/looky",
      "team",
    ]);
    const now = placed.now();
    recordRunnerRepositories(placed.db, "own", ["acme/paws-app"], now);
    const rejected: [string, string][] = [];
    expect(await placed.ids({ onRejected: (id, reason) => rejected.push([id, reason]) })).toEqual([
      "second",
    ]);
    expect(rejected).toContainEqual(["own", "repository not allowed on this runner"]);
    recordRunnerRepositories(placed.db, "own", ["ACME/looky"], now);
    recordRunnerRepositories(placed.db, "second", null, now);
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("runner placement resolves its item through session_key alone", async () => {
  const placed = await placeItem(false);
  try {
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("an item in a Linear project also runs on its lead's shared runners after the owner's", async () => {
  const placed = await placeItem();
  try {
    saveSchedulingContext(placed.db, {
      itemId: "item",
      projectId: "project",
      projectLeadId: "colleague",
    });
    expect(await placed.ids()).toEqual(["own", "second", "shared"]);
    placed.db.run("UPDATE runner_policy SET sharing=0 WHERE runner_id='shared'");
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a delegation spanning projects with several leads uses all of their shared runners", async () => {
  const placed = await placeItem();
  try {
    placed.db.run(
      `INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at)
       SELECT 'sibling',delegation_id,'lin-sibling','sibling','Sibling','queued','paws/sibling',1,created_at FROM work_item WHERE id='item'`,
    );
    saveSchedulingContext(placed.db, {
      itemId: "item",
      projectId: "one",
      projectLeadId: "colleague",
    });
    saveSchedulingContext(placed.db, {
      itemId: "sibling",
      projectId: "two",
      projectLeadId: "pool",
    });
    expect((await placed.ids()).toSorted()).toEqual(["api", "own", "second", "shared"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a lead leaving the project stops lending runners, and an unknown lead keeps the saved one", async () => {
  const placed = await placeItem();
  try {
    saveSchedulingContext(placed.db, {
      itemId: "item",
      projectId: "project",
      projectLeadId: "colleague",
    });
    saveSchedulingContext(placed.db, { itemId: "item", projectId: "project", priority: 2 });
    expect(await placed.ids()).toEqual(["own", "second", "shared"]);
    saveSchedulingContext(placed.db, { itemId: "item", projectId: null });
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a continuing task lands on the runner of its last session, or elsewhere after the grace period", async () => {
  const placed = await placeItem();
  try {
    const session = { session: { runnerId: "second" } };
    expect(await placed.ids()).toEqual(["own", "second"]);
    expect(await placed.ids(session)).toEqual(["second", "own"]);

    const run = insertRun(placed.db, { itemId: "item", now: Date.now(), status: "active" });
    placed.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,'second',?,1,0,'busy',?,0)",
      [run.id, placed.workspaceId, Date.now() + 60 * 60_000],
    );
    expect(await placed.ids(session)).toEqual(["second"]);
    for (let waited = 0; waited < SESSION_GRACE_MS; waited += 30_000) {
      expect(await placed.ids(session)).toEqual(["second"]);
      placed.tick(30_000);
    }
    expect(await placed.ids(session)).toEqual(["own", "second"]);

    placed.db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [Date.now(), run.id]);
    // An active run retains its slot between commands until its lifetime ends.
    expect(await placed.ids(session)).toEqual(["own", "second"]);
    placed.db.run("UPDATE run SET status='ended' WHERE id=?", [run.id]);
    expect(await placed.ids(session)).toEqual(["second", "own"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("session affinity waits for other runs' held slots and unassigned reservations", async () => {
  const placed = await placeItem();
  try {
    const { db } = placed;
    db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES('second',2)");
    const own = insertRun(db, { itemId: "item", now: placed.now(), status: "active" });
    db.run("UPDATE work_item SET current_run_id=? WHERE id='item'", [own.id]);
    const other = insertRun(db, { itemId: "item", now: placed.now(), status: "active" });
    for (const [runId, ended] of [
      [own.id, null],
      [other.id, placed.now()],
    ] as const)
      db.run(
        "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence,ended_at) VALUES(?,'second',?,1,0,?,?,0,?)",
        [runId, placed.workspaceId, `work-${runId}`, placed.now() + 3_600_000, ended],
      );
    const session = { session: { runnerId: "second" } };
    // One held slot and one in-flight reservation fill the holder, excluding our own work.
    expect(await placed.ids({ ...session, reserved: new Map([["second", 1]]) })).toEqual([
      "second",
    ]);
    insertQueuedItem(db, { id: "pinned", now: placed.now() });
    const pin = enqueueJob(db, {
      queue: "run.resume",
      now: placed.now(),
      payload: {
        itemId: "pinned",
        pinnedSlot: { runnerId: "second", order: 0 },
      },
    });
    expect(await placed.ids(session)).toEqual(["second"]);
    // A post-preparation authority recheck must not restart session selection or grace.
    expect(await placed.ids({ session: undefined })).toEqual(["own", "second"]);
    db.run("UPDATE job SET status='cancelled' WHERE id=?", [pin]);
    // The held slot alone leaves room for this run to keep its session.
    expect(await placed.ids(session)).toEqual(["second", "own"]);
    db.run("UPDATE run SET status='ended' WHERE id=?", [other.id]);
    expect(await placed.ids({ ...session, reserved: new Map([["second", 1]]) })).toEqual([
      "second",
      "own",
    ]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a continuing task that checks back only after the grace period is offered other runners", async () => {
  const placed = await placeItem();
  try {
    const session = { session: { runnerId: "second" } };
    const run = insertRun(placed.db, { itemId: "item", now: Date.now(), status: "active" });
    placed.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,'second',?,1,0,'busy',?,0)",
      [run.id, placed.workspaceId, Date.now() + 60 * 60_000],
    );
    expect(await placed.ids(session)).toEqual(["second"]);
    placed.tick(SESSION_GRACE_MS + placementWaitMs(3));
    expect(await placed.ids(session)).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a continuing task does not wait for an offline session runner", async () => {
  const placed = await placeItem();
  try {
    placed.db.run("UPDATE runner SET last_seen_at=0 WHERE id='second'");
    expect(await placed.ids({ session: { runnerId: "second" } })).toEqual(["own"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a solo task lands only on its owner's runner without calling Linear", async () => {
  const placed = await placeItem();
  try {
    expect(
      await networkRequests(async () => expect(await placed.ids()).toEqual(["own", "second"])),
    ).toBe(0);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a task waiting ten minutes for its busy session runner never calls Linear", async () => {
  const placed = await placeItem();
  try {
    const session = { session: { runnerId: "second" } };
    const run = insertRun(placed.db, { itemId: "item", now: Date.now(), status: "active" });
    placed.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,'second',?,1,0,'busy',?,0)",
      [run.id, placed.workspaceId, Date.now() + 60 * 60_000],
    );
    const offers: string[][] = [];
    const requests = await networkRequests(async () => {
      for (let attempt = 0; attempt < 13; attempt++) {
        offers.push(await placed.ids(session));
        placed.tick(placementWaitMs(attempt));
      }
    });
    expect(offers.slice(0, 5)).toEqual(Array(5).fill(["second"]));
    expect(offers.slice(5)).toEqual(Array(8).fill(["own", "second"]));
    expect(requests).toBe(0);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a task waiting for a runner retries after 5 s, 15 s, 30 s, then every minute", () => {
  expect(Array.from({ length: 6 }, (_, attempt) => placementWaitMs(attempt))).toEqual([
    5_000, 15_000, 30_000, 60_000, 60_000, 60_000,
  ]);
});

/** Three runners of the item owner, so placement chooses among equals on load alone. */
async function ownerPool(capacities: Record<string, number> = { a: 2, b: 2, c: 2 }) {
  const placed = await placeItem();
  const { db } = placed;
  db.run("UPDATE runner SET status='revoked',revoked_at=?", [placed.now()]);
  for (const [id, capacity] of Object.entries(capacities)) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, placed.workspaceId, placed.owner, id, placed.now(), placed.now()],
    );
    db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES(?,0)", [id]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',1)", [id]);
    db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,?)", [id, capacity]);
  }
  let commands = 0;
  return {
    ...placed,
    /** Leases one slot on the runner for the next hour. */
    occupy(runnerId: string) {
      const run = insertRun(db, { itemId: "item", now: placed.now(), status: "active" });
      db.run(
        "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,?,?,1,0,?,?,0)",
        [run.id, runnerId, placed.workspaceId, `work-${++commands}`, placed.now() + 60 * 60_000],
      );
    },
    /** Records a finished execution that kept the runner busy from `startedAt` to `endedAt`. */
    worked(runnerId: string, startedAt: number, endedAt: number) {
      db.run(
        `INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,agent,role,purpose,started_at,ended_at,outcome)
         VALUES(?,?,?,'codex','implementer','work',?,?,'success')`,
        [`usage-${++commands}`, runnerId, placed.owner, startedAt, endedAt],
      );
    },
  };
}

async function withPool(
  run: (pool: Awaited<ReturnType<typeof ownerPool>>) => Promise<void>,
  capacities?: Record<string, number>,
) {
  const pool = await ownerPool(capacities);
  try {
    await run(pool);
  } finally {
    pool.db.close();
    rmSync(pool.root, { recursive: true, force: true });
  }
}

test("simultaneous tasks spread across runners instead of filling one runner first", () =>
  withPool(async (pool) => {
    const placedOn: string[] = [];
    for (let task = 0; task < 6; task++) {
      const [first] = await pool.ids();
      placedOn.push(first!);
      pool.occupy(first!);
    }
    expect(placedOn.slice(0, 3).toSorted()).toEqual(["a", "b", "c"]);
    expect(placedOn.slice(3).toSorted()).toEqual(["a", "b", "c"]);
  }));

test("current load is a share of each runner's slots", () =>
  withPool(
    async (pool) => {
      pool.occupy("big");
      pool.occupy("small");
      // big holds 1 of 4 slots and small 1 of 2.
      expect(await pool.ids()).toEqual(["big", "small"]);
      pool.occupy("big");
      pool.occupy("big");
      expect(await pool.ids()).toEqual(["small", "big"]);
    },
    { big: 4, small: 2 },
  ));

test("a runner that just finished long work yields to one that stayed idle", () =>
  withPool(async (pool) => {
    const at = pool.now();
    pool.worked("a", at - 90 * 60_000, at - 60_000);
    pool.worked("b", at - 10 * 60_000, at - 5 * 60_000);
    expect(await pool.ids()).toEqual(["c", "b", "a"]);
  }));

test("recent load decays, so old work counts less than fresh work", () =>
  withPool(async (pool) => {
    const at = pool.now();
    // Two hours of work that ended five hours ago weighs less than 20 minutes ending now.
    pool.worked("a", at - 7 * 60 * 60_000, at - 5 * 60 * 60_000);
    pool.worked("b", at - 20 * 60_000, at);
    pool.worked("c", at - LOAD_HISTORY_MS - 60 * 60_000, at - LOAD_HISTORY_MS - 1);
    expect(await pool.ids()).toEqual(["c", "a", "b"]);
  }));

test("an idle runner with history still precedes a busy runner without history", () =>
  withPool(
    async (pool) => {
      const at = pool.now();
      pool.worked("old", at - 3 * 60 * 60_000, at - 60_000);
      // A newly paired runner used to win every placement on its empty virtual_finish counter.
      pool.db.run("UPDATE runner_agent_policy SET virtual_finish=100 WHERE runner_id='old'");
      pool.occupy("new");
      expect(await pool.ids()).toEqual(["old", "new"]);
    },
    { old: 2, new: 2 },
  ));

test("slots the caller reserved but has not assigned count as current load", () =>
  withPool(async (pool) => {
    expect(await pool.ids({ reserved: new Map([["a", 1]]) })).toEqual(["b", "c", "a"]);
    expect(
      await pool.ids({
        reserved: new Map([
          ["a", 1],
          ["b", 2],
        ]),
      }),
    ).toEqual(["c", "a", "b"]);
  }));

test("a runner low on quota follows equally loaded runners", () =>
  withPool(async (pool) => {
    const at = pool.now();
    pool.worked("b", at - 30 * 60_000, at);
    pool.db.run("UPDATE runner_agent_policy SET quota_state='low' WHERE runner_id='a'");
    expect(await pool.ids()).toEqual(["c", "b", "a"]);
    pool.occupy("c");
    pool.occupy("b");
    expect(await pool.ids()).toEqual(["a", "c", "b"]);
  }));

test("run pins apply to every role and never expire while the host is online", async () => {
  const placed = await placeItem();
  try {
    const pinnedRunnerId = "second";
    const run = insertRun(placed.db, { itemId: "item", now: placed.now(), status: "active" });
    placed.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence,ended_at) VALUES(?,'second',?,1,0,'held',?,0,?)",
      [run.id, placed.workspaceId, placed.now(), placed.now()],
    );
    for (const role of ["implementer", "reviewer", "implementer"] as const) {
      expect(await placed.ids({ pinnedRunnerId, role })).toEqual(["second"]);
      placed.tick(3 * SESSION_GRACE_MS);
    }
    // Even occupied capacity cannot make placement abandon an online run's pin.
    placed.db.run("UPDATE runner_work SET ended_at=NULL,lease_until=?", [placed.now() + 60_000]);
    expect(await placed.ids({ pinnedRunnerId })).toEqual(["second"]);
    expect(await placed.ids({ pinnedRunnerId, excludeRunnerIds: ["second"] })).toEqual(["second"]);
    // Exclusions still apply to new runs and unavailable pins.
    expect(await placed.ids({ excludeRunnerIds: ["second"] })).toEqual(["own"]);
    placed.db.run("UPDATE runner_agent_policy SET cooldown_until=? WHERE runner_id='second'", [
      placed.now() + 60_000,
    ]);
    expect(await placed.ids({ pinnedRunnerId })).toEqual([]);
    expect(await placed.ids({ pinnedRunnerId, excludeRunnerIds: ["second"] })).toEqual([]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

for (const revoked of [false, true]) {
  test(`reviewer preparation ignores historical model evidence after ${revoked ? "revocation" : "a moved review and ejection"}`, async () => {
    const placed = await placeItem();
    try {
      const at = placed.now();
      const run = insertRun(placed.db, { itemId: "item", now: at, status: "active" });
      // Implementation on own, review on second, with the run still pointing at its last host.
      placed.db.run(
        "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence,ended_at) VALUES(?,'second',?,2,0,'review',?,0,?)",
        [run.id, placed.workspaceId, at, at],
      );
      for (const [command, runner, role, model] of [
        ["implement", "own", "implementer", "implementation-model"],
        ["review", "second", "reviewer", "review-model"],
      ])
        placed.db.run(
          "INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,item_id,run_id,agent,role,purpose,started_at,ended_at,outcome,resolved_model) VALUES(?,?,?,'item',?,'codex',?,'work',?,?,'success',?)",
          [command!, runner!, placed.owner, run.id, role!, at - 100, at, model!],
        );
      if (revoked)
        placed.db.run("UPDATE runner SET revoked_at=?,status='revoked' WHERE id='second'", [at]);
      // A cached default model is historical evidence, not the result of the upcoming probe.
      placed.db.run("UPDATE runner_agent_policy SET resolved_model='implementation-model'");
      const request = {
        role: "reviewer" as const,
        profile: { agent: "codex" as const },
        pinnedRunnerId: "second",
      };
      expect(await placed.ids({ ...request, purpose: "work" })).toEqual([]);
      expect(await placed.ids({ ...request, purpose: "prepare" })).toContain("own");
      // Even an explicitly matching profile must be probed so preflight can explain the policy failure.
      expect(
        await placed.ids({
          ...request,
          purpose: "prepare",
          profile: { agent: "codex", model: "implementation-model" },
        }),
      ).toContain("own");
    } finally {
      placed.db.close();
      rmSync(placed.root, { recursive: true, force: true });
    }
  });
}

test("placement reports every rejected runner and capacity waits include their reasons", async () => {
  const placed = await placeItem();
  try {
    placed.db.run("UPDATE runner SET revoked_at=? WHERE id='second'", [placed.now()]);
    placed.db.run("UPDATE runner_agent_policy SET cooldown_until=? WHERE runner_id='own'", [
      placed.now() + 60_000,
    ]);
    const rejected: string[] = [];
    expect(
      await placed.ids({
        role: "reviewer",
        purpose: "prepare",
        onRejected: (id, reason) => rejected.push(`${id}: ${reason}`),
      }),
    ).toEqual([]);
    expect(rejected.toSorted()).toEqual([
      "api: no-project-lead",
      "own: agent quota cooldown",
      "second: revoked",
      "shared: no-project-lead",
      "unshared: not-yours",
    ]);
    const error = new RunnerCapacityWait([], undefined, rejected);
    expect(error.message).toContain("own: agent quota cooldown");
    expect(error.message).toContain("second: revoked");
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

/** A run pinned to `gone`, an owner's runner that went offline, so the run must move. */
async function movingRun() {
  const placed = await placeItem();
  placed.db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('gone',?,?,'gone','active',0,0)",
    [placed.workspaceId, placed.owner],
  );
  placed.db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES('gone','codex',1)");
  const run = insertRun(placed.db, { itemId: "item", now: placed.now(), status: "active" });
  placed.db.run("UPDATE work_item SET current_run_id=? WHERE id='item'", [run.id]);
  const asked: string[] = [];
  /** A fake restore check: the listed runners may restore, `same` with the snapshot's version. */
  const restore =
    (eligible: Record<string, "same" | "other">) =>
    (runnerId: string): { sameVersion: boolean } | null => {
      asked.push(runnerId);
      return eligible[runnerId] ? { sameVersion: eligible[runnerId] === "same" } : null;
    };
  return { ...placed, run, asked, restore, pinnedRunnerId: "gone" };
}

test("a moved run goes to the idle runner that can continue its agent session", async () => {
  const placed = await movingRun();
  try {
    const { pinnedRunnerId } = placed;
    expect(await placed.ids({ pinnedRunnerId })).toEqual(["own", "second"]);
    const restore = placed.restore({ second: "same" });
    expect(await placed.ids({ pinnedRunnerId, restore })).toEqual(["second", "own"]);
    expect(placed.asked.toSorted()).toEqual(["own", "second"]);
    // Both may restore: the runner on the snapshot's agent version goes first.
    expect(
      await placed.ids({
        pinnedRunnerId,
        restore: placed.restore({ own: "other", second: "same" }),
      }),
    ).toEqual(["second", "own"]);
    expect(
      await placed.ids({
        pinnedRunnerId,
        restore: placed.restore({ own: "same", second: "same" }),
      }),
    ).toEqual(["own", "second"]);

    // The usage receipt and the runner history say why the runner was preferred.
    const profile = { agent: "codex" as const, model: "implementation-model" };
    await placed.placement.candidates({
      itemId: "item",
      profile,
      role: "implementer",
      purpose: "work",
      pinnedRunnerId,
      restore,
    });
    for (const runnerId of ["second", "own"])
      placed.placement.started({
        commandId: `command-${runnerId}`,
        runnerId,
        itemId: "item",
        runId: placed.run.id,
        profile,
        role: "implementer",
        purpose: "work",
        startedAt: placed.now(),
      });
    const response = await createRunnerPlacementBrowser({ db: placed.db })(
      new Request("http://127.0.0.1/api/runners/usage"),
      {
        workspaceId: placed.workspaceId,
        userId: placed.owner,
        role: "admin",
        authenticatedAt: placed.now(),
        teamIds: [],
      },
    );
    const body = (await response!.json()) as {
      usage: Array<{ runnerId: string; preferredBecause: string | null }>;
    };
    expect(
      body.usage
        .map(({ runnerId, preferredBecause }) => ({ runnerId, preferredBecause }))
        .toSorted((a, b) => a.runnerId.localeCompare(b.runnerId)),
    ).toEqual([
      { runnerId: "own", preferredBecause: null },
      { runnerId: "second", preferredBecause: "can continue the agent's session" },
    ]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a moved run whose restoring runner is busy goes to another runner at once", async () => {
  const placed = await movingRun();
  try {
    const { pinnedRunnerId } = placed;
    const other = insertRun(placed.db, { itemId: "item", now: placed.now(), status: "active" });
    placed.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,'second',?,1,0,'busy',?,0)",
      [other.id, placed.workspaceId, placed.now() + 60 * 60_000],
    );
    const restore = placed.restore({ second: "same" });
    // No wait for the busy runner, now or after the old session grace period.
    expect(await placed.ids({ pinnedRunnerId, restore })).toEqual(["own", "second"]);
    placed.tick(SESSION_GRACE_MS);
    placed.db.run("UPDATE runner SET last_seen_at=0 WHERE id='gone'");
    expect(await placed.ids({ pinnedRunnerId, restore })).toEqual(["own", "second"]);
    // Once it is free it goes first again; slots the caller reserved count as busy.
    placed.db.run("DELETE FROM runner_work WHERE run_id=?", [other.id]);
    expect(await placed.ids({ pinnedRunnerId, restore })).toEqual(["second", "own"]);
    expect(
      await placed.ids({ pinnedRunnerId, restore, reserved: new Map([["second", 1]]) }),
    ).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("new runs, runs on their online pin and reviews rank as before a session restore", async () => {
  const placed = await movingRun();
  try {
    const restore = placed.restore({ second: "same" });
    // A new run has no pin to move from.
    expect(await placed.ids({ restore })).toEqual(["own", "second"]);
    // A run whose pinned runner is online stays there.
    expect(await placed.ids({ pinnedRunnerId: "own", restore })).toEqual(["own"]);
    // Only implementer work restores a session.
    expect(await placed.ids({ pinnedRunnerId: "gone", restore, role: "reviewer" })).toEqual([
      "own",
      "second",
    ]);
    expect(await placed.ids({ pinnedRunnerId: "gone", restore, purpose: "prepare" })).toEqual([
      "own",
      "second",
    ]);
    expect(placed.asked).toEqual([]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});
