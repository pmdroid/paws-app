import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createRunnerHelpers } from "../src/runner-helpers";
import { createFindingGroupHelper } from "../src/runner-backend";
import {
  recordLinearInstallation,
  putWorkspaceUser,
  syncWorkspaceMember,
  recordRunnerHostStatus,
} from "../src/db";
import { tempDb } from "./helpers";

function seed() {
  const db = tempDb();
  const now = Date.now();
  db.run("INSERT INTO workspace VALUES('ws','org','Workspace',1)");
  putWorkspaceUser(db, {
    id: "admin",
    linearUserId: "linear-admin",
    name: "Admin",
    email: "admin@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId: "admin",
    role: "admin",
    active: true,
    teamIds: [],
    now,
  });
  recordLinearInstallation(db, {
    sessionId: "reporting-session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: now,
  });
  // Reporting sessions are often already stopped when the daily job runs.
  db.run("UPDATE linear_session SET stopped_at=?", [now - 1000]);
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner','ws','admin','Runner','active',?,?)",
    [now, now],
  );
  db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES('runner','codex',1)");
  recordRunnerHostStatus(db, "runner", { runnerVersion: "0.1.51" }, now);
  const { privateKey } = generateKeyPairSync("ed25519");
  const helpers = createRunnerHelpers({ db, keyId: "key", privateKey, now: () => now });
  return { db, now, helpers };
}

test("daily helper uses an admin runner, accepts a stopped reporting session, and fences role changes", async () => {
  const f = seed();
  try {
    let dispatches = 0;
    const helper = createFindingGroupHelper({
      db: f.db,
      profile: () => ({ agent: "codex", model: null }),
      helpers: async () => ({
        ...f.helpers,
        dispatch(input) {
          dispatches++;
          const result = f.helpers.dispatch(input);
          f.helpers.submit("runner", {
            commandId: result.command.id,
            executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            role: "implementer",
            stopReason: "end_turn",
            timedOut: false,
            cancelled: false,
            authRequired: false,
            agentExited: true,
            text: '{"groups":[]}',
            tokens: 456,
          });
          return result;
        },
      }),
    });
    expect(
      await helper({
        workspaceId: "ws",
        sessionId: "reporting-session",
        prompt: "Group JSON findings",
        signal: new AbortController().signal,
      }),
    ).toEqual({ text: '{"groups":[]}', tokens: 456 });
    expect(dispatches).toBe(1);
    expect(
      f.db.query("SELECT 1 FROM runner_helper WHERE ended_at IS NOT NULL").get(),
    ).not.toBeNull();
    const input = {
      runnerId: "runner",
      sessionId: "reporting-session",
      purpose: "finding_groups" as const,
      profile: { agent: "codex" as const, model: null },
      prompt: "Group findings",
    };
    const dispatched = f.helpers.dispatch(input);
    f.db.run("UPDATE workspace_member SET role='member'");
    expect(() => f.helpers.current(dispatched.command.id)).toThrow("authority changed");
    f.helpers.finish(dispatched.command.id);
    expect(() => f.helpers.dispatch(input)).toThrow("authority changed");
  } finally {
    f.db.close();
  }
});

test("daily helper refuses older runners and cannot read a session from another workspace", async () => {
  const f = seed();
  try {
    recordRunnerHostStatus(f.db, "runner", { runnerVersion: "0.1.50" }, f.now);
    const helper = createFindingGroupHelper({
      db: f.db,
      profile: () => ({ agent: "codex", model: null }),
      helpers: async () => f.helpers,
    });
    await expect(
      helper({
        workspaceId: "ws",
        sessionId: "reporting-session",
        prompt: "Group",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("supports finding grouping");
    expect(f.db.query("SELECT 1 FROM runner_helper").get()).toBeNull();
    recordLinearInstallation(f.db, {
      sessionId: "other-session",
      organizationId: "other-org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: f.now,
    });
    expect(() =>
      f.helpers.dispatch({
        runnerId: "runner",
        sessionId: "other-session",
        purpose: "finding_groups",
        profile: { agent: "codex", model: null },
        prompt: "Group",
      }),
    ).toThrow("authority changed");
  } finally {
    f.db.close();
  }
});
