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
import { createFakeLinearIssueLifecycle, type LinearIssueOwnership } from "../src/linear";
import {
  createRunnerPlacement,
  SESSION_GRACE_MS,
  type PlacementRequest,
} from "../src/runner-placement";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { probeRunnerPlacement } from "./local/runner-placement";

async function placeItem(
  project: boolean,
  bindTask = true,
  duringSelection?: (issue: LinearIssueOwnership) => void,
) {
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
  const lifecycle = createFakeLinearIssueLifecycle({
    id: item.linearIssueId,
    teamId: "team",
    assigneeId: "colleague",
    delegateId: "app",
    stateType: "started",
    projectId: "project",
  });
  let memberReads = 0;
  const placement = createRunnerPlacement({
    db,
    lifecycle,
    tracker: {
      async listProjectMembers() {
        memberReads++;
        duringSelection?.(lifecycle.issue);
        return ["colleague", "pool"];
      },
    },
    now: () => clock,
  });
  return {
    root,
    db,
    workspaceId: workspace.id,
    linearReads: () => lifecycle.inspected.length + memberReads,
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
    expect(observations).toHaveLength(15);
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
    expect(await placed.ids()).toEqual(["own", "api", "shared"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a state change during selection keeps the issue's runners", async () => {
  const placed = await placeItem(true, true, (issue) => {
    issue.stateType = "unstarted";
  });
  try {
    expect(await placed.ids()).toEqual(["own", "api", "shared"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a new delegate during selection still stops placement", async () => {
  const placed = await placeItem(true, true, (issue) => {
    issue.delegateId = "other-app";
  });
  try {
    await expect(placed.ids()).rejects.toThrow("Runner issue ownership changed during selection");
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a continuing task lands on the runner of its last session, or elsewhere after the grace period", async () => {
  const placed = await placeItem(true);
  try {
    const session = { session: { runnerId: "shared" } };
    expect(await placed.ids()).toEqual(["own", "api", "shared"]);
    expect(await placed.ids(session)).toEqual(["shared", "own", "api"]);

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
    expect(await placed.ids(session)).toEqual(["own", "api", "shared"]);

    placed.db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [Date.now(), run.id]);
    expect(await placed.ids(session)).toEqual(["shared", "own", "api"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a continuing task does not wait for an offline session runner", async () => {
  const placed = await placeItem(true);
  try {
    placed.db.run("UPDATE runner SET last_seen_at=0 WHERE id='shared'");
    expect(await placed.ids({ session: { runnerId: "shared" } })).toEqual(["own", "api"]);
    expect(await placed.ids({ session: { runnerId: "api" } })).toEqual(["api", "own"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a solo task lands only on its owner's runner without calling Linear", async () => {
  const placed = await placeItem(false);
  try {
    expect(await placed.ids()).toEqual(["own"]);
    expect(placed.linearReads()).toBe(0);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a project task lands on a project member's shared runner without calling Linear", async () => {
  const placed = await placeItem(true);
  try {
    expect(await placed.ids()).toEqual(["own", "shared"]);
    expect(placed.linearReads()).toBe(0);
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
    for (const wait of [5_000, 15_000, 30_000, ...Array<number>(10).fill(60_000)]) {
      offers.push(await placed.ids(session));
      placed.tick(wait);
    }
    expect(offers.slice(0, 4)).toEqual([["shared"], ["shared"], ["shared"], ["shared"]]);
    expect(offers.slice(4)).toEqual(Array(9).fill(["own", "shared"]));
    expect(placed.linearReads()).toBe(0);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});
