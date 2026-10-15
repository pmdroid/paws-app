import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bindLinearSessionTask,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import { createFakeLinearIssueLifecycle } from "../src/linear";
import { createRunnerPlacement } from "../src/runner-placement";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { probeRunnerPlacement } from "./local/runner-placement";

async function placeItem(project: boolean) {
  const root = mkdtempSync(join(tmpdir(), "paws-placement-owner-"));
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = Date.now();
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
  bindLinearSessionTask(db, "session", item.epicId, { actorId: "owner" });
  db.run(
    `INSERT INTO project_approval(id,workspace_id,project_id,actor_id,lead_user_id,generation,preview,created_at,expires_at,approved_at)
     VALUES('approval',?,'project',?,?,'placement','{}',?,?,?)`,
    [workspace.id, owner, owner, now, now, now],
  );
  db.run("UPDATE work_item SET owner_user_id=?, project_approval_id=? WHERE id=?", [
    owner,
    project ? "approval" : null,
    item.id,
  ]);
  db.run("INSERT INTO workspace_runner_policy(workspace_id,fallback_allowed) VALUES(?,1)", [
    workspace.id,
  ]);
  for (const [id, userId, sharing, fallback, host, seat] of [
    ["own", owner, 0, 0, "member", "personal"],
    ["shared", colleague, 1, 0, "member", "organization"],
    ["fallback", pool, 0, 1, "workspace", "api"],
  ] as const) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, workspace.id, userId, id, now, now],
    );
    db.run("INSERT INTO runner_policy(runner_id,host_owner,sharing,fallback) VALUES(?,?,?,?)", [
      id,
      host,
      sharing,
      fallback,
    ]);
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,seat,ready) VALUES(?,'codex',?,1)", [
      id,
      seat,
    ]);
  }
  const placement = createRunnerPlacement({
    db,
    lifecycle: createFakeLinearIssueLifecycle({
      id: item.linearIssueId,
      teamId: "team",
      assigneeId: "colleague",
      delegateId: "app",
      stateType: "started",
      projectId: "project",
    }),
    tracker: {
      async listProjectMembers() {
        return ["colleague"];
      },
    },
    now: () => now,
  });
  return {
    root,
    db,
    async ids() {
      return (
        await placement.candidates({
          itemId: item.id,
          profile: { agent: "codex", model: "implementation-model" },
          role: "implementer" as const,
          purpose: "work" as const,
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
    expect(observations).toHaveLength(16);
    expect(observations.every(Boolean)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a solo item runs on its owner's runner and not another member's shared runner", async () => {
  const placed = await placeItem(false);
  try {
    expect(await placed.ids()).toEqual(["own", "fallback"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});

test("a project item runs on another project member's shared runner", async () => {
  const placed = await placeItem(true);
  try {
    expect(await placed.ids()).toEqual(["own", "shared", "fallback"]);
  } finally {
    placed.db.close();
    rmSync(placed.root, { recursive: true, force: true });
  }
});
