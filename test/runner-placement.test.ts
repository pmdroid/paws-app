import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  insertRun,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import {
  createRunnerPlacement,
  LOAD_HISTORY_MS,
  SESSION_GRACE_MS,
  type PlacementRequest,
} from "../src/runner-placement";
import { placementWaitMs } from "../src/core";
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

async function placeItem(project: boolean, bindTask = true) {
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
  db.run(
    `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at)
     VALUES('approval',?,'project',?,?,'placement','{}',?,?,?)`,
    [workspace.id, owner, colleague, now, now, now],
  );
  db.run("UPDATE work_item SET owner_user_id=?, project_approval_id=? WHERE id=?", [
    owner,
    project ? "approval" : null,
    item.id,
  ]);
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
    expect(observations).toHaveLength(14);
    expect(observations.every(Boolean)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a solo item runs on its owner's runners and not another member's shared runner", async () => {
  const placed = await placeItem(false);
  try {
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("runner placement resolves its item through session_key alone", async () => {
  const placed = await placeItem(false, false);
  try {
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("an item from a Paws project start never lands on another member's runner", async () => {
  const placed = await placeItem(true);
  try {
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("an item in a Linear project also runs on its lead's shared runners after the owner's", async () => {
  const placed = await placeItem(false);
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
  const placed = await placeItem(false);
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
  const placed = await placeItem(false);
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
  const placed = await placeItem(true);
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
    expect(await placed.ids(session)).toEqual(["second", "own"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a continuing task that checks back only after the grace period is offered other runners", async () => {
  const placed = await placeItem(true);
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
  const placed = await placeItem(true);
  try {
    placed.db.run("UPDATE runner SET last_seen_at=0 WHERE id='second'");
    expect(await placed.ids({ session: { runnerId: "second" } })).toEqual(["own"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a solo task lands only on its owner's runner without calling Linear", async () => {
  const placed = await placeItem(false);
  try {
    expect(
      await networkRequests(async () => expect(await placed.ids()).toEqual(["own", "second"])),
    ).toBe(0);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a stored project member's shared runner is not offered", async () => {
  const placed = await placeItem(true);
  try {
    placed.db.run(
      "INSERT INTO project_approval_member(approval_id,linear_user_id) VALUES('approval','colleague')",
    );
    expect(
      await networkRequests(async () => expect(await placed.ids()).toEqual(["own", "second"])),
    ).toBe(0);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a task waiting ten minutes for its busy session runner never calls Linear", async () => {
  const placed = await placeItem(true);
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
  const placed = await placeItem(false);
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
