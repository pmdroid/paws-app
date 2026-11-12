import { expect, test } from "bun:test";
import { sql, type SQL } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import { createRunnerHelpers } from "../src/runner-helpers";
import { createFindingGroupHelper } from "../src/runner-backend";
import {
  insertQueuedItem,
  recordLinearInstallation,
  putWorkspaceUser,
  syncWorkspaceMember,
  recordRunnerHostStatus,
  syncSteps,
  type Db,
  type PgDb,
} from "../src/db";
import { tempStore } from "./pglite";

const exec = (db: Db, query: SQL) => (db as PgDb).orm.execute(query);
type Rows = Record<string, unknown>[];
const one = async (db: Db, query: SQL) => {
  const result = (await exec(db, query)) as Rows | { rows: Rows };
  return (Array.isArray(result) ? result : result.rows)[0];
};

async function seed() {
  const { db, close } = await tempStore();
  let now = Date.now();
  await exec(
    db,
    sql`INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Workspace',1)`,
  );
  await putWorkspaceUser(db, {
    id: "admin",
    linearUserId: "linear-admin",
    name: "Admin",
    email: "admin@example.invalid",
  });
  await syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId: "admin",
    role: "admin",
    active: true,
    teamIds: [],
    now,
  });
  await recordLinearInstallation(db, {
    sessionId: "reporting-session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: now,
  });
  // Reporting sessions are often already stopped when the daily job runs.
  await exec(db, sql`UPDATE linear_session SET stopped_at=${now - 1000}`);
  await exec(
    db,
    sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner','ws','admin','Runner','active',${now},${now})`,
  );
  await exec(
    db,
    sql`INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES('runner','codex',1)`,
  );
  await recordRunnerHostStatus(db, "runner", { runnerVersion: "0.1.53" }, now);
  const { privateKey } = generateKeyPairSync("ed25519");
  const helpers = createRunnerHelpers({
    store: db,
    keyId: "key",
    privateKey,
    now: () => now,
  });
  return {
    db,
    close,
    now,
    helpers,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("daily helper uses an admin runner, accepts a stopped reporting session, and fences role changes", async () => {
  const f = await seed();
  try {
    let dispatches = 0;
    const helper = createFindingGroupHelper({
      store: f.db,
      profile: () => ({ agent: "codex", model: null }),
      helpers: async () => ({
        ...f.helpers,
        *dispatchSteps(q, input) {
          dispatches++;
          const result = yield* f.helpers.dispatchSteps(q, input);
          void f.helpers.submit("runner", {
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
      await one(f.db, sql`SELECT 1 FROM runner_helper WHERE ended_at IS NOT NULL`),
    ).not.toBeNull();
    const input = {
      runnerId: "runner",
      sessionId: "reporting-session",
      purpose: "finding_groups" as const,
      profile: { agent: "codex" as const, model: null },
      prompt: "Group findings",
    };
    const dispatched = await f.helpers.dispatch(input);
    await exec(f.db, sql`UPDATE workspace_member SET role='member'`);
    await expect(f.helpers.current(dispatched.command.id)).rejects.toThrow("authority changed");
    await f.helpers.finish(dispatched.command.id);
    await expect(f.helpers.dispatch(input)).rejects.toThrow("authority changed");
  } finally {
    await f.close();
  }
});

test("daily helper refuses older runners and cannot read a session from another workspace", async () => {
  const f = await seed();
  try {
    await recordRunnerHostStatus(f.db, "runner", { runnerVersion: "0.1.50" }, f.now);
    const helper = createFindingGroupHelper({
      store: f.db,
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
    expect(await one(f.db, sql`SELECT 1 FROM runner_helper`)).toBeUndefined();
    await recordLinearInstallation(f.db, {
      sessionId: "other-session",
      organizationId: "other-org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: f.now,
    });
    await expect(
      f.helpers.dispatch({
        runnerId: "runner",
        sessionId: "other-session",
        purpose: "finding_groups",
        profile: { agent: "codex", model: null },
        prompt: "Group",
      }),
    ).rejects.toThrow("authority changed");
  } finally {
    await f.close();
  }
});

test("grouping accepts a result after one minute, records usage, and rejects error results", async () => {
  for (const failed of [false, true]) {
    const f = await seed();
    try {
      const helper = createFindingGroupHelper({
        store: f.db,
        profile: () => ({ agent: "codex", model: null }),
        helpers: async () => ({
          ...f.helpers,
          *dispatchSteps(q, input) {
            const dispatched = yield* f.helpers.dispatchSteps(q, input);
            expect(dispatched.command.expiresAt - dispatched.command.issuedAt).toBe(600000);
            f.advance(90000);
            void f.helpers.submit("runner", {
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
      const usage = await one(f.db, sql`SELECT ended_at AS ended FROM runner_execution_usage`);
      expect(usage?.ended).not.toBeNull();
      if (failed)
        expect(
          (await one(f.db, sql`SELECT auth_expired AS expired FROM runner_agent_policy`))?.expired,
        ).toBe(1);
    } finally {
      await f.close();
    }
  }
});

test("pre-dispatch refusals try the next admin runner without issuing a second helper", async () => {
  const f = await seed();
  try {
    await exec(
      f.db,
      sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) SELECT 'runner2',workspace_id,owner_user_id,'Second','active',created_at,last_seen_at FROM runner WHERE id='runner'`,
    );
    await exec(
      f.db,
      sql`INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES('runner2','codex',1)`,
    );
    await recordRunnerHostStatus(f.db, "runner2", { runnerVersion: "0.1.53" }, f.now);
    let attempts = 0;
    const helper = createFindingGroupHelper({
      store: f.db,
      profile: () => ({ agent: "codex", model: null }),
      helpers: async () => ({
        ...f.helpers,
        *dispatchSteps(q, input) {
          attempts++;
          if (attempts === 1) throw new Error("Runner cancellation teardown is still pending");
          const result = yield* f.helpers.dispatchSteps(q, input);
          void f.helpers.submit(input.runnerId, {
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
    expect((await one(f.db, sql`SELECT count(*)::int AS count FROM runner_helper`))?.count).toBe(1);
  } finally {
    await f.close();
  }
});

test("one-runner foreground placement preempts grouping and fences its old lease", async () => {
  const { createRunnerPlacement } = await import("../src/runner-placement");
  const f = await seed();
  try {
    const profile = { agent: "codex" as const, model: null };
    const placement = createRunnerPlacement({ store: f.db, now: () => f.now });
    await placement.candidates({
      sessionId: "reporting-session",
      findingGroups: true,
      profile,
      role: "implementer",
      purpose: "helper",
    });
    const maintenance = await f.helpers.dispatch({
      runnerId: "runner",
      sessionId: "reporting-session",
      purpose: "finding_groups",
      profile,
      prompt: "Group findings",
    });
    await f.db.transaction((q) =>
      placement.startedSteps(q, {
        commandId: maintenance.command.id,
        runnerId: "runner",
        sessionId: "reporting-session",
        profile,
        role: "implementer",
        purpose: "helper",
        startedAt: f.now,
      }),
    );
    await recordLinearInstallation(f.db, {
      sessionId: "interactive",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: f.now,
    });
    await exec(
      f.db,
      sql`UPDATE linear_session SET creator_id='linear-admin',issue_id='issue' WHERE session_id='interactive'`,
    );
    const candidates = await placement.candidates({
      sessionId: "interactive",
      profile,
      role: "implementer",
      purpose: "helper",
    });
    expect(candidates.map((row) => row.id)).toContain("runner");
    expect((await f.helpers.current(maintenance.command.id)).command.purpose).toBe(
      "finding_groups",
    );
    // Invalid dispatch must not fence maintenance either.
    await expect(
      f.helpers.dispatch({
        runnerId: "runner",
        sessionId: "interactive",
        purpose: "classify",
        profile,
        prompt: "x".repeat(65537),
      }),
    ).rejects.toThrow();
    expect((await f.helpers.current(maintenance.command.id)).command.purpose).toBe(
      "finding_groups",
    );
    // A failure after fencing must roll back the fence and usage changes as well.
    await exec(
      f.db,
      sql`CREATE FUNCTION refuse_helper() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Admission failed'; END $$ LANGUAGE plpgsql`,
    );
    await exec(
      f.db,
      sql`CREATE TRIGGER refuse_helper BEFORE INSERT ON runner_helper FOR EACH ROW EXECUTE FUNCTION refuse_helper()`,
    );
    const refused = (await f.helpers
      .dispatch({
        runnerId: "runner",
        sessionId: "interactive",
        purpose: "classify",
        profile,
        prompt: "Classify",
      })
      .catch((error: unknown) => error)) as Error;
    expect(String(refused.cause)).toContain("Admission failed");
    expect((await f.helpers.current(maintenance.command.id)).command.purpose).toBe(
      "finding_groups",
    );
    await exec(f.db, sql`DROP TRIGGER refuse_helper ON runner_helper`);
    const foreground = await f.helpers.dispatch({
      runnerId: "runner",
      sessionId: "interactive",
      purpose: "classify",
      profile,
      prompt: "Classify",
    });
    expect(foreground.command.purpose).toBe("classify");
    await expect(f.helpers.current(maintenance.command.id)).rejects.toThrow("unavailable");
    expect(
      (
        await one(
          f.db,
          sql`SELECT outcome FROM runner_execution_usage WHERE command_id=${maintenance.command.id}`,
        )
      )?.outcome,
    ).toBe("preempted");
  } finally {
    await f.close();
  }
});

test("cleanup accounting cannot replace a local abort and reports cancellation instead of heartbeat loss", async () => {
  const { createRemoteSessionAgentRunner } = await import("../src/runner-backend");
  const f = await seed();
  try {
    await exec(f.db, sql`UPDATE linear_session SET stopped_at=NULL`);
    const abort = new AbortController();
    const original = new Error("Original stop");
    const outcomes: string[] = [];
    const runner = createRemoteSessionAgentRunner({
      store: f.db,
      helpers: {
        ...f.helpers,
        *dispatchSteps(q, input) {
          const issued = yield* f.helpers.dispatchSteps(q, input);
          abort.abort(original);
          return issued;
        },
      },
      placement: {
        async candidates() {
          return [{ id: "runner", workspaceId: "ws" }];
        },
        startedSteps: () => syncSteps(() => {}),
        finishedSteps: (_q, input) =>
          syncSteps(() => {
            outcomes.push(input.failure ?? "result");
            throw new Error("Receipt cleanup failed");
          }),
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
      (await one(f.db, sql`SELECT ended_at AS ended FROM runner_helper`))?.ended,
    ).not.toBeNull();
  } finally {
    await f.close();
  }
});

test("ranking idle and excluded runners never fences maintenance on another runner", async () => {
  const { createRunnerPlacement } = await import("../src/runner-placement");
  const f = await seed();
  try {
    await exec(
      f.db,
      sql`UPDATE linear_session SET stopped_at=NULL,creator_id='linear-admin',issue_id='issue'`,
    );
    await exec(
      f.db,
      sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) SELECT 'idle',workspace_id,owner_user_id,'Idle','active',created_at,last_seen_at FROM runner WHERE id='runner'`,
    );
    await exec(
      f.db,
      sql`INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES('idle','codex',1)`,
    );
    const profile = { agent: "codex" as const, model: null };
    const maintenance = await f.helpers.dispatch({
      runnerId: "runner",
      sessionId: "reporting-session",
      purpose: "finding_groups",
      profile,
      prompt: "Group",
    });
    const placement = createRunnerPlacement({ store: f.db, now: () => f.now });
    const request = {
      sessionId: "reporting-session",
      profile,
      role: "implementer" as const,
      purpose: "helper" as const,
    };
    const candidates = await placement.candidates(request);
    expect(candidates[0]!.id).toBe("idle");
    await f.helpers.dispatch({
      runnerId: candidates[0]!.id,
      sessionId: "reporting-session",
      purpose: "classify",
      profile,
      prompt: "Classify",
    });
    expect((await f.helpers.current(maintenance.command.id)).command.purpose).toBe(
      "finding_groups",
    );
    expect(
      await placement.candidates({ ...request, excludeRunnerIds: ["runner", "idle"] }),
    ).toEqual([]);
    expect((await f.helpers.current(maintenance.command.id)).command.purpose).toBe(
      "finding_groups",
    );
  } finally {
    await f.close();
  }
});

test("a failed receipt completion is retried by cleanup before the original error propagates", async () => {
  const { createRunnerPlacement } = await import("../src/runner-placement");
  const f = await seed();
  try {
    const placement = createRunnerPlacement({ store: f.db });
    const original = new Error("Transient receipt failure");
    let attempts = 0;
    const helper = createFindingGroupHelper({
      store: f.db,
      profile: () => ({ agent: "codex", model: null }),
      placement: {
        ...placement,
        *finishedSteps(q, input) {
          if (++attempts === 1) throw original;
          return yield* placement.finishedSteps(q, input);
        },
      },
      helpers: async () => ({
        ...f.helpers,
        *dispatchSteps(q, input) {
          const issued = yield* f.helpers.dispatchSteps(q, input);
          void f.helpers.submit("runner", {
            commandId: issued.command.id,
            executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            role: "implementer",
            stopReason: "end_turn",
            timedOut: false,
            cancelled: false,
            authRequired: false,
            agentExited: true,
            text: '{"groups":[]}',
          });
          return issued;
        },
      }),
    });
    await expect(
      helper({
        workspaceId: "ws",
        sessionId: "reporting-session",
        prompt: "Group",
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(original);
    expect(attempts).toBe(2);
    expect(
      (await one(f.db, sql`SELECT ended_at AS ended FROM runner_execution_usage`))?.ended,
    ).not.toBeNull();
  } finally {
    await f.close();
  }
});

test("grouping runs on a later admin's runner when the earlier admin has none", async () => {
  const f = await seed();
  try {
    await putWorkspaceUser(f.db, {
      id: "aaa",
      linearUserId: "linear-aaa",
      name: "Aaa",
      email: "aaa@example.invalid",
    });
    await syncWorkspaceMember(f.db, {
      workspaceId: "ws",
      userId: "aaa",
      role: "admin",
      active: true,
      teamIds: [],
      now: f.now,
    });
    let runnerId = "";
    const helper = createFindingGroupHelper({
      store: f.db,
      profile: () => ({ agent: "codex", model: null }),
      helpers: async () => ({
        ...f.helpers,
        *dispatchSteps(q, input) {
          runnerId = input.runnerId;
          const issued = yield* f.helpers.dispatchSteps(q, input);
          void f.helpers.submit(input.runnerId, {
            commandId: issued.command.id,
            executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            role: "implementer",
            stopReason: "end_turn",
            timedOut: false,
            cancelled: false,
            authRequired: false,
            agentExited: true,
            text: '{"groups":[]}',
          });
          return issued;
        },
      }),
    });
    await helper({
      workspaceId: "ws",
      sessionId: "reporting-session",
      prompt: "Group",
      signal: new AbortController().signal,
    });
    expect(runnerId).toBe("runner");
    expect((await one(f.db, sql`SELECT owner_user_id AS "userId" FROM runner`))?.userId).toBe(
      "admin",
    );
  } finally {
    await f.close();
  }
});

test("grouping does not dispatch a session the runner owner cannot authorize", async () => {
  const f = await seed();
  try {
    await insertQueuedItem(f.db, { id: "outside", sessionKey: "reporting-session", now: f.now });
    await exec(
      f.db,
      sql`INSERT INTO work_item_repository(item_id,owner,repo,remote_url) VALUES('outside','other','secret','https://github.com/other/secret.git')`,
    );
    await exec(
      f.db,
      sql`INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('ws','acme/allowed','team')`,
    );
    let attempts = 0;
    const helper = createFindingGroupHelper({
      store: f.db,
      profile: () => ({ agent: "codex", model: null }),
      helpers: async () => ({
        ...f.helpers,
        *dispatchSteps(q, input) {
          attempts++;
          return yield* f.helpers.dispatchSteps(q, input);
        },
      }),
    });
    await expect(
      helper({
        workspaceId: "ws",
        sessionId: "reporting-session",
        prompt: "Group",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("No paired runner");
    expect(attempts).toBe(0);
  } finally {
    await f.close();
  }
});
