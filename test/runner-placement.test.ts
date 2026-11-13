import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import {
  bindLinearSessionTask,
  bindWorkItemRepository,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  insertRun,
  enqueueJob,
  putWorkspaceUser,
  recordLinearInstallation,
  recordRunnerRepositories,
  syncWorkspaceMember,
  syncSteps,
  type Db,
  type Q,
} from "../src/db";
import {
  createRunnerPlacement,
  createRunnerPlacementBrowser,
  LOAD_HISTORY_MS,
  SESSION_GRACE_MS,
  type PlacementRequest,
} from "../src/runner-placement";
import { RunnerCapacityWait, placementWaitMs } from "../src/core";
import { saveSchedulingContextSteps } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { probeRunnerPlacement } from "./local/runner-placement";
import { tempStore } from "./pglite";
import { seed } from "./dialects";

type Runner = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  createdAt: number;
  lastSeenAt: number;
  agent?: "codex" | "claude";
  sharing?: number;
  capacity?: number;
};

/** An active runner with a ready agent, plus its sharing policy and capacity when given. */
function insertRunner(db: Db, { agent = "codex", sharing, capacity, ...runner }: Runner) {
  return seed(
    db,
    (q) => q.orm.insert(q.t.runner).values({ name: runner.id, status: "active", ...runner }),
    ...(sharing === undefined
      ? []
      : [(q: Q) => q.orm.insert(q.t.runnerPolicy).values({ runnerId: runner.id, sharing })]),
    (q) => q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: runner.id, agent, ready: 1 }),
    ...(capacity === undefined
      ? []
      : [(q: Q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: runner.id, capacity })]),
  );
}

type Work = {
  runId: string;
  runnerId: string;
  workspaceId: string;
  commandId: string;
  leaseUntil: number;
  generation?: number;
  endedAt?: number | null;
};

function insertRunnerWork(db: Db, work: Work) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerWork).values({ generation: 1, runnerFence: 0, ...work }),
  );
}

function updateRunnerWork(
  db: Db,
  values: { teardownConfirmedAt?: number; endedAt?: number | null; leaseUntil?: number },
  where?: (q: Q) => SQL | undefined,
) {
  return seed(db, (q) => q.orm.update(q.t.runnerWork).set(values).where(where?.(q)));
}

type RunnerValues = { status?: string; lastSeenAt?: number; revokedAt?: number };

/** Updates one runner, or every runner when `id` is undefined. */
function setRunner(db: Db, id: string | undefined, values: RunnerValues) {
  return seed(db, (q) =>
    q.orm
      .update(q.t.runner)
      .set(values)
      .where(id === undefined ? undefined : eq(q.t.runner.id, id)),
  );
}

type AgentPolicy = {
  ready?: number;
  authExpired?: number;
  quotaState?: string;
  extraUsage?: number;
  cooldownUntil?: number;
  virtualFinish?: number;
  resolvedModel?: string;
};

/** Updates the agent policy of the given runners, or of every runner when none are given. */
function setAgentPolicy(db: Db, runnerIds: string[] | string | undefined, values: AgentPolicy) {
  const ids = typeof runnerIds === "string" ? [runnerIds] : runnerIds;
  return seed(db, (q) =>
    q.orm
      .update(q.t.runnerAgentPolicy)
      .set(values)
      .where(ids === undefined ? undefined : inArray(q.t.runnerAgentPolicy.runnerId, ids)),
  );
}

function setSharing(db: Db, runnerId: string, sharing: number) {
  return seed(db, (q) =>
    q.orm.update(q.t.runnerPolicy).set({ sharing }).where(eq(q.t.runnerPolicy.runnerId, runnerId)),
  );
}

function setCurrentRun(db: Db, itemId: string, runId: string) {
  return seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ currentRunId: runId }).where(eq(q.t.workItem.id, itemId)),
  );
}

function endRun(db: Db, runId: string) {
  return seed(db, (q) =>
    q.orm.update(q.t.run).set({ status: "ended" }).where(eq(q.t.run.id, runId)),
  );
}

type Usage = {
  commandId: string;
  runnerId: string;
  ownerUserId: string;
  role: string;
  startedAt: number;
  endedAt: number;
  itemId?: string;
  runId?: string;
  resolvedModel?: string;
};

function insertUsage(db: Db, usage: Usage) {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.runnerExecutionUsage)
      .values({ agent: "codex", purpose: "work", outcome: "success", ...usage }),
  );
}

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
  const store = await tempStore();
  const { db } = store;
  const now = Date.now();
  let clock = now;
  const owner = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const colleague = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "colleague",
    name: "Colleague",
    email: "colleague@example.invalid",
  });
  const pool = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "pool",
    name: "Pool",
    email: "pool@example.invalid",
  });
  const token = await issueWorkspaceBootstrap(db, "org", now);
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: owner,
    tokenHash: workspaceTokenHash(token),
    now,
  });
  for (const userId of [colleague, pool])
    await syncWorkspaceMember(db, {
      workspaceId: workspace.id,
      userId,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  const item = await insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  await recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "app-client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  if (bindTask) await bindLinearSessionTask(db, "session", item.delegationId, { actorId: "owner" });
  await seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ ownerUserId: owner }).where(eq(q.t.workItem.id, item.id)),
  );
  for (const [id, userId, sharing] of [
    ["own", owner, 0],
    ["second", owner, 0],
    ["shared", colleague, 1],
    ["api", pool, 1],
    ["unshared", pool, 0],
  ] as const)
    await insertRunner(db, {
      id,
      workspaceId: workspace.id,
      ownerUserId: userId,
      createdAt: now,
      lastSeenAt: now,
      sharing,
    });
  const placement = createRunnerPlacement({
    store: db,
    now: () => clock,
  });
  return {
    db,
    close: store.close,
    delegationId: item.delegationId,
    placement,
    workspaceId: workspace.id,
    owner,
    colleague,
    pool,
    now: () => clock,
    async tick(ms: number) {
      clock += ms;
      await setRunner(db, undefined, { lastSeenAt: clock });
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
    await placed.close();
  }
});

test("a preflight never goes to a paused runner", async () => {
  const placed = await placeItem();
  try {
    await setRunner(placed.db, "own", { status: "paused" });
    for (const role of ["implementer", "reviewer"] as const)
      expect(await placed.ids({ role, purpose: "prepare" })).toEqual(["second"]);
  } finally {
    await placed.close();
  }
});

test("a preflight skips a runner whose agent is signed out while another is signed in", async () => {
  const placed = await placeItem();
  try {
    await setAgentPolicy(placed.db, "own", { ready: 0, authExpired: 1 });
    const prepare = { role: "reviewer", purpose: "prepare" } as const;
    expect(await placed.ids(prepare)).toEqual(["second"]);
    await setAgentPolicy(placed.db, "second", { ready: 0, authExpired: 1 });
    expect((await placed.ids(prepare)).toSorted()).toEqual(["own", "second"]);
  } finally {
    await placed.close();
  }
});

test("work goes only to runners whose reported repositories include the item's repository", async () => {
  const placed = await placeItem();
  try {
    await bindWorkItemRepository(placed.db, "item", {
      owner: "Acme",
      repo: "Looky",
      remoteUrl: "https://github.com/Acme/Looky.git",
    });
    await seed(placed.db, (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: placed.workspaceId, repository: "acme/looky", teamId: "team" }),
    );
    const now = placed.now();
    await recordRunnerRepositories(placed.db, "own", ["acme/paws-app"], now);
    const rejected: [string, string][] = [];
    expect(await placed.ids({ onRejected: (id, reason) => rejected.push([id, reason]) })).toEqual([
      "second",
    ]);
    expect(rejected).toContainEqual(["own", "repository not allowed in the runner's host config"]);
    await recordRunnerRepositories(placed.db, "own", ["ACME/looky"], now);
    await recordRunnerRepositories(placed.db, "second", null, now);
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    await placed.close();
  }
});

test("runner placement resolves its item through session_key alone", async () => {
  const placed = await placeItem(false);
  try {
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    await placed.close();
  }
});

test("an item in a Linear project also runs on its lead's shared runners after the owner's", async () => {
  const placed = await placeItem();
  try {
    await placed.db.run((q) =>
      saveSchedulingContextSteps(q, {
        itemId: "item",
        projectId: "project",
        projectLeadId: "colleague",
      }),
    );
    expect(await placed.ids()).toEqual(["own", "second", "shared"]);
    await setSharing(placed.db, "shared", 0);
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    await placed.close();
  }
});

test("a delegation spanning projects with several leads uses all of their shared runners", async () => {
  const placed = await placeItem();
  try {
    await seed(placed.db, (q) =>
      q.orm.insert(q.t.workItem).values({
        id: "sibling",
        delegationId: placed.delegationId,
        linearIssueId: "lin-sibling",
        linearIdentifier: "sibling",
        title: "Sibling",
        state: "queued",
        branchName: "paws/sibling",
        position: 1,
        createdAt: placed.now(),
      }),
    );
    await placed.db.run((q) =>
      saveSchedulingContextSteps(q, {
        itemId: "item",
        projectId: "one",
        projectLeadId: "colleague",
      }),
    );
    await placed.db.run((q) =>
      saveSchedulingContextSteps(q, {
        itemId: "sibling",
        projectId: "two",
        projectLeadId: "pool",
      }),
    );
    expect((await placed.ids()).toSorted()).toEqual(["api", "own", "second", "shared"]);
  } finally {
    await placed.close();
  }
});

test("a lead leaving the project stops lending runners, and an unknown lead keeps the saved one", async () => {
  const placed = await placeItem();
  try {
    await placed.db.run((q) =>
      saveSchedulingContextSteps(q, {
        itemId: "item",
        projectId: "project",
        projectLeadId: "colleague",
      }),
    );
    await placed.db.run((q) =>
      saveSchedulingContextSteps(q, { itemId: "item", projectId: "project", priority: 2 }),
    );
    expect(await placed.ids()).toEqual(["own", "second", "shared"]);
    await placed.db.run((q) => saveSchedulingContextSteps(q, { itemId: "item", projectId: null }));
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    await placed.close();
  }
});

test("a continuing task lands on the runner of its last session, or elsewhere after the grace period", async () => {
  const placed = await placeItem();
  try {
    const session = { session: { runnerId: "second" } };
    expect(await placed.ids()).toEqual(["own", "second"]);
    expect(await placed.ids(session)).toEqual(["second", "own"]);

    const run = await insertRun(placed.db, {
      itemId: "item",
      now: Date.now(),
      status: "active",
    });
    await insertRunnerWork(placed.db, {
      runId: run.id,
      runnerId: "second",
      workspaceId: placed.workspaceId,
      commandId: "busy",
      leaseUntil: Date.now() + 60 * 60_000,
    });
    expect(await placed.ids(session)).toEqual(["second"]);
    for (let waited = 0; waited < SESSION_GRACE_MS; waited += 30_000) {
      expect(await placed.ids(session)).toEqual(["second"]);
      await placed.tick(30_000);
    }
    expect(await placed.ids(session)).toEqual(["own", "second"]);

    await updateRunnerWork(placed.db, { teardownConfirmedAt: 1, endedAt: Date.now() }, (q) =>
      eq(q.t.runnerWork.runId, run.id),
    );
    // An active run retains its slot between commands until its lifetime ends.
    expect(await placed.ids(session)).toEqual(["own", "second"]);
    await endRun(placed.db, run.id);
    expect(await placed.ids(session)).toEqual(["second", "own"]);
  } finally {
    await placed.close();
  }
});

test("session affinity waits for other runs' held slots and unassigned reservations", async () => {
  const placed = await placeItem();
  try {
    const { db } = placed;
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerCapacity).values({ runnerId: "second", capacity: 2 }),
    );
    const own = await insertRun(db, {
      itemId: "item",
      now: placed.now(),
      status: "active",
    });
    await setCurrentRun(db, "item", own.id);
    const other = await insertRun(db, {
      itemId: "item",
      now: placed.now(),
      status: "active",
    });
    for (const [runId, ended] of [
      [own.id, null],
      [other.id, placed.now()],
    ] as const)
      await insertRunnerWork(db, {
        runId,
        runnerId: "second",
        workspaceId: placed.workspaceId,
        commandId: `work-${runId}`,
        leaseUntil: placed.now() + 3_600_000,
        endedAt: ended,
      });
    await updateRunnerWork(db, { teardownConfirmedAt: 1 }, (q) =>
      isNotNull(q.t.runnerWork.endedAt),
    );
    const session = { session: { runnerId: "second" } };
    // One held slot and one in-flight reservation fill the holder, excluding our own work.
    expect(await placed.ids({ ...session, reserved: new Map([["second", 1]]) })).toEqual([
      "second",
    ]);
    await insertQueuedItem(db, { id: "pinned", now: placed.now() });
    const pin = await enqueueJob(db, {
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
    await seed(db, (q) =>
      q.orm.update(q.t.job).set({ status: "cancelled" }).where(eq(q.t.job.id, pin)),
    );
    // The held slot alone leaves room for this run to keep its session.
    expect(await placed.ids(session)).toEqual(["second", "own"]);
    await endRun(db, other.id);
    expect(await placed.ids({ ...session, reserved: new Map([["second", 1]]) })).toEqual([
      "second",
      "own",
    ]);
  } finally {
    await placed.close();
  }
});

test("a continuing task that checks back only after the grace period is offered other runners", async () => {
  const placed = await placeItem();
  try {
    const session = { session: { runnerId: "second" } };
    const run = await insertRun(placed.db, {
      itemId: "item",
      now: Date.now(),
      status: "active",
    });
    await insertRunnerWork(placed.db, {
      runId: run.id,
      runnerId: "second",
      workspaceId: placed.workspaceId,
      commandId: "busy",
      leaseUntil: Date.now() + 60 * 60_000,
    });
    expect(await placed.ids(session)).toEqual(["second"]);
    await placed.tick(SESSION_GRACE_MS + placementWaitMs(3));
    expect(await placed.ids(session)).toEqual(["own", "second"]);
  } finally {
    await placed.close();
  }
});

test("a continuing task does not wait for an offline session runner", async () => {
  const placed = await placeItem();
  try {
    await setRunner(placed.db, "second", { lastSeenAt: 0 });
    expect(await placed.ids({ session: { runnerId: "second" } })).toEqual(["own"]);
  } finally {
    await placed.close();
  }
});

test("a solo task lands only on its owner's runner without calling Linear", async () => {
  const placed = await placeItem();
  try {
    expect(
      await networkRequests(async () => expect(await placed.ids()).toEqual(["own", "second"])),
    ).toBe(0);
  } finally {
    await placed.close();
  }
});

test("a task waiting ten minutes for its busy session runner never calls Linear", async () => {
  const placed = await placeItem();
  try {
    const session = { session: { runnerId: "second" } };
    const run = await insertRun(placed.db, {
      itemId: "item",
      now: Date.now(),
      status: "active",
    });
    await insertRunnerWork(placed.db, {
      runId: run.id,
      runnerId: "second",
      workspaceId: placed.workspaceId,
      commandId: "busy",
      leaseUntil: Date.now() + 60 * 60_000,
    });
    const offers: string[][] = [];
    const requests = await networkRequests(async () => {
      for (let attempt = 0; attempt < 13; attempt++) {
        offers.push(await placed.ids(session));
        await placed.tick(placementWaitMs(attempt));
      }
    });
    expect(offers.slice(0, 5)).toEqual(Array(5).fill(["second"]));
    expect(offers.slice(5)).toEqual(Array(8).fill(["own", "second"]));
    expect(requests).toBe(0);
  } finally {
    await placed.close();
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
  await setRunner(db, undefined, { status: "revoked", revokedAt: placed.now() });
  for (const [id, capacity] of Object.entries(capacities))
    await insertRunner(db, {
      id,
      workspaceId: placed.workspaceId,
      ownerUserId: placed.owner,
      createdAt: placed.now(),
      lastSeenAt: placed.now(),
      sharing: 0,
      capacity,
    });
  let commands = 0;
  return {
    ...placed,
    /** Leases one slot on the runner for the next hour. */
    async occupy(runnerId: string) {
      const run = await insertRun(db, {
        itemId: "item",
        now: placed.now(),
        status: "active",
      });
      await insertRunnerWork(db, {
        runId: run.id,
        runnerId,
        workspaceId: placed.workspaceId,
        commandId: `work-${++commands}`,
        leaseUntil: placed.now() + 60 * 60_000,
      });
    },
    /** Records a finished execution that kept the runner busy from `startedAt` to `endedAt`. */
    worked(runnerId: string, startedAt: number, endedAt: number) {
      return insertUsage(db, {
        commandId: `usage-${++commands}`,
        runnerId,
        ownerUserId: placed.owner,
        role: "implementer",
        startedAt,
        endedAt,
      });
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
    await pool.close();
  }
}

test("simultaneous tasks spread across runners instead of filling one runner first", () =>
  withPool(async (pool) => {
    const placedOn: string[] = [];
    for (let task = 0; task < 6; task++) {
      const [first] = await pool.ids();
      placedOn.push(first!);
      await pool.occupy(first!);
    }
    expect(placedOn.slice(0, 3).toSorted()).toEqual(["a", "b", "c"]);
    expect(placedOn.slice(3).toSorted()).toEqual(["a", "b", "c"]);
  }));

test("current load is a share of each runner's slots", () =>
  withPool(
    async (pool) => {
      await pool.occupy("big");
      await pool.occupy("small");
      // big holds 1 of 4 slots and small 1 of 2.
      expect(await pool.ids()).toEqual(["big", "small"]);
      await pool.occupy("big");
      await pool.occupy("big");
      expect(await pool.ids()).toEqual(["small", "big"]);
    },
    { big: 4, small: 2 },
  ));

test("a runner that just finished long work yields to one that stayed idle", () =>
  withPool(async (pool) => {
    const at = pool.now();
    await pool.worked("a", at - 90 * 60_000, at - 60_000);
    await pool.worked("b", at - 10 * 60_000, at - 5 * 60_000);
    expect(await pool.ids()).toEqual(["c", "b", "a"]);
  }));

test("recent load decays, so old work counts less than fresh work", () =>
  withPool(async (pool) => {
    const at = pool.now();
    // Two hours of work that ended five hours ago weighs less than 20 minutes ending now.
    await pool.worked("a", at - 7 * 60 * 60_000, at - 5 * 60 * 60_000);
    await pool.worked("b", at - 20 * 60_000, at);
    await pool.worked("c", at - LOAD_HISTORY_MS - 60 * 60_000, at - LOAD_HISTORY_MS - 1);
    expect(await pool.ids()).toEqual(["c", "a", "b"]);
  }));

test("an idle runner with history still precedes a busy runner without history", () =>
  withPool(
    async (pool) => {
      const at = pool.now();
      await pool.worked("old", at - 3 * 60 * 60_000, at - 60_000);
      // A newly paired runner used to win every placement on its empty virtual_finish counter.
      await setAgentPolicy(pool.db, "old", { virtualFinish: 100 });
      await pool.occupy("new");
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
    await pool.worked("b", at - 30 * 60_000, at);
    await setAgentPolicy(pool.db, "a", { quotaState: "low" });
    expect(await pool.ids()).toEqual(["c", "b", "a"]);
    await pool.occupy("c");
    await pool.occupy("b");
    expect(await pool.ids()).toEqual(["a", "c", "b"]);
  }));

test("a runner with quota left goes before one running on extra usage, which names it", () =>
  withPool(
    async (pool) => {
      await setAgentPolicy(pool.db, "a", { quotaState: "spent_extra", extraUsage: 1 });
      await pool.worked("b", pool.now() - 30 * 60_000, pool.now());
      expect(await pool.ids()).toEqual(["b", "a"]);
      // b is busy and no other runner is free: a, still last, is the only one with a slot.
      await pool.occupy("b");
      expect(await pool.ids()).toEqual(["b", "a"]);
      const profile = { agent: "codex" as const, model: "implementation-model" };
      await pool.db.transaction((q) =>
        pool.placement.startedSteps(q, {
          commandId: "command-a",
          runnerId: "a",
          itemId: "item",
          profile,
          role: "implementer",
          purpose: "work",
          startedAt: pool.now(),
        }),
      );
      const response = await createRunnerPlacementBrowser({ store: pool.db })(
        new Request("http://127.0.0.1/api/runners/usage"),
        {
          workspaceId: pool.workspaceId,
          userId: pool.owner,
          role: "admin",
          authenticatedAt: pool.now(),
          teamIds: [],
        },
      );
      const body = (await response!.json()) as {
        usage: Array<{ commandId: string; preferredBecause: string | null }>;
      };
      expect(body.usage.find((row) => row.commandId === "command-a")!.preferredBecause).toBe(
        "runs on extra usage: no runner with quota was free",
      );
    },
    { a: 1, b: 1 },
  ));

test("a runner the item's owner can't use is never offered, even with quota left", async () => {
  const placed = await placeItem();
  try {
    await setAgentPolicy(placed.db, ["own", "second"], {
      quotaState: "spent_extra",
      extraUsage: 1,
    });
    expect(await placed.ids()).toEqual(["own", "second"]);
  } finally {
    await placed.close();
  }
});

test("the runner's owner and admins switch extra usage per agent, others get 403", async () => {
  const placed = await placeItem();
  try {
    const runnerId = workspaceId();
    await insertRunner(placed.db, {
      id: runnerId,
      workspaceId: placed.workspaceId,
      ownerUserId: placed.colleague,
      createdAt: 0,
      lastSeenAt: 0,
      agent: "claude",
    });
    const browser = createRunnerPlacementBrowser({ store: placed.db, now: placed.now });
    const as = (userId: string, role: "admin" | "member") => ({
      workspaceId: placed.workspaceId,
      userId,
      role,
      authenticatedAt: placed.now(),
      teamIds: ["team"],
    });
    const toggle = async (userId: string, role: "admin" | "member", extraUsage: boolean) =>
      (await browser(
        new Request(`http://127.0.0.1/api/runners/${runnerId}/agents/claude/extra-usage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ extraUsage }),
        }),
        as(userId, role),
      ))!.status;
    const read = async () =>
      (
        (await (await browser(
          new Request(`http://127.0.0.1/api/runners/${runnerId}/policy`),
          as(placed.pool, "member"),
        ))!.json()) as { agents: { agent: string; extraUsage: boolean }[] }
      ).agents.map(({ agent, extraUsage }) => ({ agent, extraUsage }));
    expect(await read()).toEqual([{ agent: "claude", extraUsage: false }]);
    expect(await toggle(placed.colleague, "member", true)).toBe(200);
    expect(await read()).toEqual([{ agent: "claude", extraUsage: true }]);
    expect(await toggle(placed.pool, "member", false)).toBe(403);
    expect(await read()).toEqual([{ agent: "claude", extraUsage: true }]);
    expect(await toggle(placed.owner, "admin", false)).toBe(200);
    expect(await read()).toEqual([{ agent: "claude", extraUsage: false }]);
    const quota = () =>
      placed.db.run((q) =>
        q.one(
          q.orm
            .select({
              state: q.t.runnerAgentPolicy.quotaState,
              until: q.t.runnerAgentPolicy.cooldownUntil,
            })
            .from(q.t.runnerAgentPolicy)
            .where(eq(q.t.runnerAgentPolicy.runnerId, runnerId)),
        ),
      );
    await setAgentPolicy(placed.db, runnerId, {
      quotaState: "exhausted",
      cooldownUntil: placed.now() + 60_000,
    });
    expect(await toggle(placed.colleague, "member", true)).toBe(200);
    expect(await quota()).toEqual({ state: "spent_extra", until: 0 });
    expect(await toggle(placed.colleague, "member", false)).toBe(200);
    expect(await quota()).toEqual({ state: "exhausted", until: placed.now() + 900_000 });
    expect(await toggle(placed.colleague, "member", false)).toBe(200);
    expect(await quota()).toEqual({ state: "exhausted", until: placed.now() + 900_000 });
  } finally {
    await placed.close();
  }
});

test("run pins apply to every role and never expire while the host is online", async () => {
  const placed = await placeItem();
  try {
    const pinnedRunnerId = "second";
    const run = await insertRun(placed.db, {
      itemId: "item",
      now: placed.now(),
      status: "active",
    });
    await insertRunnerWork(placed.db, {
      runId: run.id,
      runnerId: "second",
      workspaceId: placed.workspaceId,
      commandId: "held",
      leaseUntil: placed.now(),
      endedAt: placed.now(),
    });
    for (const role of ["implementer", "reviewer", "implementer"] as const) {
      expect(await placed.ids({ pinnedRunnerId, role })).toEqual(["second"]);
      await placed.tick(3 * SESSION_GRACE_MS);
    }
    // Even occupied capacity cannot make placement abandon an online run's pin.
    await updateRunnerWork(placed.db, { endedAt: null, leaseUntil: placed.now() + 60_000 });
    expect(await placed.ids({ pinnedRunnerId })).toEqual(["second"]);
    expect(await placed.ids({ pinnedRunnerId, excludeRunnerIds: ["second"] })).toEqual(["second"]);
    // Exclusions still apply to new runs and unavailable pins.
    expect(await placed.ids({ excludeRunnerIds: ["second"] })).toEqual(["own"]);
    await setAgentPolicy(placed.db, "second", { cooldownUntil: placed.now() + 60_000 });
    expect(await placed.ids({ pinnedRunnerId })).toEqual([]);
    expect(await placed.ids({ pinnedRunnerId, excludeRunnerIds: ["second"] })).toEqual([]);
  } finally {
    await placed.close();
  }
});

for (const revoked of [false, true]) {
  test(`reviewer preparation ignores historical model evidence after ${revoked ? "revocation" : "a moved review and ejection"}`, async () => {
    const placed = await placeItem();
    try {
      const at = placed.now();
      const run = await insertRun(placed.db, {
        itemId: "item",
        now: at,
        status: "active",
      });
      // Implementation on own, review on second, with the run still pointing at its last host.
      await insertRunnerWork(placed.db, {
        runId: run.id,
        runnerId: "second",
        workspaceId: placed.workspaceId,
        generation: 2,
        commandId: "review",
        leaseUntil: at,
        endedAt: at,
      });
      for (const [commandId, runnerId, role, resolvedModel] of [
        ["implement", "own", "implementer", "implementation-model"],
        ["review", "second", "reviewer", "review-model"],
      ] as const)
        await insertUsage(placed.db, {
          commandId,
          runnerId,
          ownerUserId: placed.owner,
          itemId: "item",
          runId: run.id,
          role,
          startedAt: at - 100,
          endedAt: at,
          resolvedModel,
        });
      if (revoked) await setRunner(placed.db, "second", { revokedAt: at, status: "revoked" });
      // A cached default model is historical evidence, not the result of the upcoming probe.
      await setAgentPolicy(placed.db, undefined, { resolvedModel: "implementation-model" });
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
      await placed.close();
    }
  });
}

test("placement reports every rejected runner and capacity waits include their reasons", async () => {
  const placed = await placeItem();
  try {
    await setRunner(placed.db, "second", { revokedAt: placed.now() });
    await setAgentPolicy(placed.db, "own", { cooldownUntil: placed.now() + 60_000 });
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
    await placed.close();
  }
});

/** A run pinned to `gone`, an owner's runner that went offline, so the run must move. */
async function movingRun() {
  const placed = await placeItem();
  await insertRunner(placed.db, {
    id: "gone",
    workspaceId: placed.workspaceId,
    ownerUserId: placed.owner,
    createdAt: 0,
    lastSeenAt: 0,
  });
  const run = await insertRun(placed.db, {
    itemId: "item",
    now: placed.now(),
    status: "active",
  });
  await setCurrentRun(placed.db, "item", run.id);
  const asked: string[] = [];
  /** A fake restore check: the listed runners may restore, `same` with the snapshot's version. */
  const restore = (eligible: Record<string, "same" | "other">) => (_q: Q, runnerId: string) =>
    syncSteps((): { sameVersion: boolean } | null => {
      asked.push(runnerId);
      return eligible[runnerId] ? { sameVersion: eligible[runnerId] === "same" } : null;
    });
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
      await placed.db.transaction((q) =>
        placed.placement.startedSteps(q, {
          commandId: `command-${runnerId}`,
          runnerId,
          itemId: "item",
          runId: placed.run.id,
          profile,
          role: "implementer",
          purpose: "work",
          startedAt: placed.now(),
        }),
      );
    const response = await createRunnerPlacementBrowser({ store: placed.db })(
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
    await placed.close();
  }
});

test("a moved run whose restoring runner is busy goes to another runner at once", async () => {
  const placed = await movingRun();
  try {
    const { pinnedRunnerId } = placed;
    const other = await insertRun(placed.db, {
      itemId: "item",
      now: placed.now(),
      status: "active",
    });
    await insertRunnerWork(placed.db, {
      runId: other.id,
      runnerId: "second",
      workspaceId: placed.workspaceId,
      commandId: "busy",
      leaseUntil: placed.now() + 60 * 60_000,
    });
    const restore = placed.restore({ second: "same" });
    // No wait for the busy runner, now or after the old session grace period.
    expect(await placed.ids({ pinnedRunnerId, restore })).toEqual(["own", "second"]);
    await placed.tick(SESSION_GRACE_MS);
    await setRunner(placed.db, "gone", { lastSeenAt: 0 });
    expect(await placed.ids({ pinnedRunnerId, restore })).toEqual(["own", "second"]);
    // Once it is free it goes first again; slots the caller reserved count as busy.
    await seed(placed.db, (q) =>
      q.orm.delete(q.t.runnerWork).where(eq(q.t.runnerWork.runId, other.id)),
    );
    expect(await placed.ids({ pinnedRunnerId, restore })).toEqual(["second", "own"]);
    expect(
      await placed.ids({ pinnedRunnerId, restore, reserved: new Map([["second", 1]]) }),
    ).toEqual(["own", "second"]);
  } finally {
    await placed.close();
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
    await placed.close();
  }
});

test("fresh admission previews share the session grace period with execution", async () => {
  const placed = await placeItem();
  try {
    const run = await insertRun(placed.db, {
      itemId: "item",
      now: placed.now(),
      status: "active",
    });
    await insertRunnerWork(placed.db, {
      runId: run.id,
      runnerId: "second",
      workspaceId: placed.workspaceId,
      commandId: "busy",
      leaseUntil: placed.now() + 60 * 60_000,
    });
    const preview = async () =>
      (
        await placed.db.run((q) =>
          createRunnerPlacement({ store: placed.db, now: placed.now }).previewSteps!(q, {
            itemId: "item",
            profile: { agent: "codex", model: "implementation-model" },
            role: "implementer",
            purpose: "work",
            session: { runnerId: "second" },
          }),
        )
      ).map((row) => row.id);
    for (let waited = 0; waited < SESSION_GRACE_MS; waited += 30_000) {
      expect(await preview()).toEqual(["second"]);
      await placed.tick(30_000);
    }
    expect(await preview()).toEqual(["own", "second"]);
    expect(await placed.ids({ session: { runnerId: "second" } })).toEqual(["own", "second"]);
  } finally {
    await placed.close();
  }
});
