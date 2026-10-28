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
  let now = Date.now();
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
  recordRunnerHostStatus(db, "runner", { runnerVersion: "0.1.52" }, now);
  const { privateKey } = generateKeyPairSync("ed25519");
  const helpers = createRunnerHelpers({ db, keyId: "key", privateKey, now: () => now });
  return {
    db,
    now,
    helpers,
    advance: (ms: number) => {
      now += ms;
    },
  };
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
    ).rejects.toThrow("No paired runner");
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

test("grouping accepts a result after one minute, records usage, and rejects error results", async () => {
  for (const failed of [false, true]) {
    const f = seed();
    try {
      const helper = createFindingGroupHelper({
        db: f.db,
        profile: () => ({ agent: "codex", model: null }),
        helpers: async () => ({
          ...f.helpers,
          dispatch(input) {
            const dispatched = f.helpers.dispatch(input);
            expect(dispatched.command.expiresAt - dispatched.command.issuedAt).toBe(600000);
            f.advance(90000);
            f.helpers.submit("runner", {
              commandId: dispatched.command.id,
              executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
              role: "implementer",
              stopReason: "end_turn",
              timedOut: false,
              cancelled: false,
              authRequired: failed,
              agentExited: true,
              text: '{"groups":[]}',
              ...(failed ? { errorMessage: "Agent sign-in required" } : {}),
              tokens: 456,
            });
            return dispatched;
          },
        }),
      });
      const result = helper({
        workspaceId: "ws",
        sessionId: "reporting-session",
        prompt: "Group",
        signal: new AbortController().signal,
      });
      if (failed) await expect(result).rejects.toThrow();
      else expect(await result).toMatchObject({ text: '{"groups":[]}', tokens: 456 });
      const usage = f.db
        .query<{ ended: number | null }, []>("SELECT ended_at AS ended FROM runner_execution_usage")
        .get();
      expect(usage?.ended).not.toBeNull();
      if (failed)
        expect(
          f.db
            .query<{ expired: number }, []>(
              "SELECT auth_expired AS expired FROM runner_agent_policy",
            )
            .get()?.expired,
        ).toBe(1);
    } finally {
      f.db.close();
    }
  }
});

test("pre-dispatch refusals try the next admin runner without issuing a second helper", async () => {
  const f = seed();
  try {
    f.db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) SELECT 'runner2',workspace_id,owner_user_id,'Second','active',created_at,last_seen_at FROM runner WHERE id='runner'",
    );
    f.db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES('runner2','codex',1)");
    recordRunnerHostStatus(f.db, "runner2", { runnerVersion: "0.1.52" }, f.now);
    let attempts = 0;
    const helper = createFindingGroupHelper({
      db: f.db,
      profile: () => ({ agent: "codex", model: null }),
      helpers: async () => ({
        ...f.helpers,
        dispatch(input) {
          attempts++;
          if (attempts === 1) throw new Error("Runner cancellation teardown is still pending");
          const result = f.helpers.dispatch(input);
          f.helpers.submit(input.runnerId, {
            commandId: result.command.id,
            executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            role: "implementer",
            stopReason: "end_turn",
            timedOut: false,
            cancelled: false,
            authRequired: false,
            agentExited: true,
            text: '{"groups":[]}',
          });
          return result;
        },
      }),
    });
    await helper({
      workspaceId: "ws",
      sessionId: "reporting-session",
      prompt: "Group",
      signal: new AbortController().signal,
    });
    expect(attempts).toBe(2);
    expect(
      f.db.query<{ count: number }, []>("SELECT count(*) AS count FROM runner_helper").get()?.count,
    ).toBe(1);
  } finally {
    f.db.close();
  }
});

test("one-runner foreground placement preempts grouping and fences its old lease", async () => {
  const { createRunnerPlacement } = await import("../src/runner-placement");
  const f = seed();
  try {
    const profile = { agent: "codex" as const, model: null };
    const placement = createRunnerPlacement({ db: f.db, now: () => f.now });
    await placement.candidates({
      sessionId: "reporting-session",
      findingGroups: true,
      profile,
      role: "implementer",
      purpose: "helper",
    });
    const maintenance = f.helpers.dispatch({
      runnerId: "runner",
      sessionId: "reporting-session",
      purpose: "finding_groups",
      profile,
      prompt: "Group findings",
    });
    placement.started({
      commandId: maintenance.command.id,
      runnerId: "runner",
      sessionId: "reporting-session",
      profile,
      role: "implementer",
      purpose: "helper",
      startedAt: f.now,
    });
    recordLinearInstallation(f.db, {
      sessionId: "interactive",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: f.now,
    });
    f.db.run(
      "UPDATE linear_session SET creator_id='linear-admin',issue_id='issue' WHERE session_id='interactive'",
    );
    const candidates = await placement.candidates({
      sessionId: "interactive",
      profile,
      role: "implementer",
      purpose: "helper",
    });
    expect(candidates.map((row) => row.id)).toContain("runner");
    expect(() => f.helpers.current(maintenance.command.id)).toThrow("unavailable");
    const foreground = f.helpers.dispatch({
      runnerId: "runner",
      sessionId: "interactive",
      purpose: "classify",
      profile,
      prompt: "Classify",
    });
    expect(foreground.command.purpose).toBe("classify");
    expect(
      f.db
        .query<{ outcome: string }, [string]>(
          "SELECT outcome FROM runner_execution_usage WHERE command_id=?",
        )
        .get(maintenance.command.id)?.outcome,
    ).toBe("preempted");
  } finally {
    f.db.close();
  }
});

test("cleanup accounting cannot replace a local abort and reports cancellation instead of heartbeat loss", async () => {
  const { createRemoteSessionAgentRunner } = await import("../src/runner-backend");
  const f = seed();
  try {
    f.db.run("UPDATE linear_session SET stopped_at=NULL");
    const abort = new AbortController();
    const original = new Error("Original stop");
    const outcomes: string[] = [];
    const runner = createRemoteSessionAgentRunner({
      db: f.db,
      helpers: {
        ...f.helpers,
        dispatch(input) {
          const issued = f.helpers.dispatch(input);
          abort.abort(original);
          return issued;
        },
      },
      placement: {
        async candidates() {
          return [{ id: "runner", workspaceId: "ws" }];
        },
        started() {},
        finished(input) {
          outcomes.push(input.failure ?? "result");
          throw new Error("Receipt cleanup failed");
        },
      },
    });
    await expect(
      runner.forSession(
        "reporting-session",
        "classify",
      )({
        role: "implementer",
        profile: { agent: "codex", model: null },
        itemId: "",
        runId: "",
        worktreePath: "",
        pawsRoot: "",
        readOnly: true,
        prompt: "Classify",
        signal: abort.signal,
      }),
    ).rejects.toBe(original);
    expect(outcomes).toEqual(["cancelled"]);
    expect(
      f.db.query<{ ended: number | null }, []>("SELECT ended_at AS ended FROM runner_helper").get()
        ?.ended,
    ).not.toBeNull();
  } finally {
    f.db.close();
  }
});
