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
  SESSION_GRACE_MS,
  type PlacementRequest,
} from "../src/runner-placement";
import { placementWaitMs } from "../src/core";
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

test("a solo item runs on its owner's runner and not another member's shared runner", async () => {
  const placed = await placeItem(false);
  try {
    expect(await placed.ids()).toEqual(["own"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("runner placement resolves its item through session_key alone", async () => {
  const placed = await placeItem(false, false);
  try {
    expect(await placed.ids()).toEqual(["own"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a project item runs on another project member's shared runner", async () => {
  const placed = await placeItem(true);
  try {
    expect(await placed.ids()).toEqual(["own", "shared"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a continuing task lands on the runner of its last session, or elsewhere after the grace period", async () => {
  const placed = await placeItem(true);
  try {
    const session = { session: { runnerId: "shared" } };
    expect(await placed.ids()).toEqual(["own", "shared"]);
    expect(await placed.ids(session)).toEqual(["shared", "own"]);

    const run = insertRun(placed.db, { itemId: "item", now: Date.now(), status: "active" });
    placed.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,'shared',?,1,0,'busy',?,0)",
      [run.id, placed.workspaceId, Date.now() + 60 * 60_000],
    );
    expect(await placed.ids(session)).toEqual(["shared"]);
    for (let waited = 0; waited < SESSION_GRACE_MS; waited += 30_000) {
      expect(await placed.ids(session)).toEqual(["shared"]);
      placed.tick(30_000);
    }
    expect(await placed.ids(session)).toEqual(["own", "shared"]);

    placed.db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [Date.now(), run.id]);
    expect(await placed.ids(session)).toEqual(["shared", "own"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a continuing task that checks back only after the grace period is offered other runners", async () => {
  const placed = await placeItem(true);
  try {
    const session = { session: { runnerId: "shared" } };
    const run = insertRun(placed.db, { itemId: "item", now: Date.now(), status: "active" });
    placed.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,'shared',?,1,0,'busy',?,0)",
      [run.id, placed.workspaceId, Date.now() + 60 * 60_000],
    );
    expect(await placed.ids(session)).toEqual(["shared"]);
    placed.tick(SESSION_GRACE_MS + placementWaitMs(3));
    expect(await placed.ids(session)).toEqual(["own", "shared"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a continuing task does not wait for an offline session runner", async () => {
  const placed = await placeItem(true);
  try {
    placed.db.run("UPDATE runner SET last_seen_at=0 WHERE id='shared'");
    expect(await placed.ids({ session: { runnerId: "shared" } })).toEqual(["own"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a solo task lands only on its owner's runner without calling Linear", async () => {
  const placed = await placeItem(false);
  try {
    expect(await networkRequests(async () => expect(await placed.ids()).toEqual(["own"]))).toBe(0);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a project task lands on a project member's shared runner without calling Linear", async () => {
  const placed = await placeItem(true);
  try {
    expect(
      await networkRequests(async () => expect(await placed.ids()).toEqual(["own", "shared"])),
    ).toBe(0);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a project task lands on the shared runner of a stored member who is neither actor nor lead without calling Linear", async () => {
  const placed = await placeItem(true);
  try {
    placed.db.run("UPDATE project_approval SET lead_user_id=actor_id WHERE id='approval'");
    expect(await placed.ids()).toEqual(["own"]);
    placed.db.run(
      "INSERT INTO project_approval_member(approval_id,linear_user_id) VALUES('approval','colleague')",
    );
    expect(
      await networkRequests(async () => expect(await placed.ids()).toEqual(["own", "shared"])),
    ).toBe(0);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a task waiting ten minutes for its busy session runner never calls Linear", async () => {
  const placed = await placeItem(true);
  try {
    const session = { session: { runnerId: "shared" } };
    const run = insertRun(placed.db, { itemId: "item", now: Date.now(), status: "active" });
    placed.db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,'shared',?,1,0,'busy',?,0)",
      [run.id, placed.workspaceId, Date.now() + 60 * 60_000],
    );
    const offers: string[][] = [];
    const requests = await networkRequests(async () => {
      for (let attempt = 0; attempt < 13; attempt++) {
        offers.push(await placed.ids(session));
        placed.tick(placementWaitMs(attempt));
      }
    });
    expect(offers.slice(0, 5)).toEqual(Array(5).fill(["shared"]));
    expect(offers.slice(5)).toEqual(Array(8).fill(["own", "shared"]));
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
