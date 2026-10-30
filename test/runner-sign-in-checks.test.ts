import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  migrate,
  putWorkspaceUser,
  recordRunnerAgentUsage,
  runnerAgentUsage,
  syncWorkspaceMember,
} from "../src/db";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerLogin } from "../src/runner-login";
import { createRunnerHttp, type RunnerControl } from "../src/runner-control";
import { workspaceId, type WorkspacePrincipal } from "../src/workspace";
import { RunnerHealthResultSchema, type RunnerCommand } from "../src/runner-protocol";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.run("PRAGMA foreign_keys=ON");
  migrate(db);
  let at = 1_800_000_000_000;
  const workspace = workspaceId();
  db.run("INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES(?,?,?,?)", [
    workspace,
    "sign-in-org",
    "Sign-in",
    at,
  ]);
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "sign-in-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: workspace,
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now: at,
  });
  const owner: WorkspacePrincipal = {
    workspaceId: workspace,
    userId,
    role: "admin",
    teamIds: [],
    authenticatedAt: at,
  };
  const work = createRunnerWork({
    db,
    keyId: "sign-in",
    privateKey: generateKeyPairSync("ed25519").privateKey,
    now: () => at,
  });
  const health = createRunnerHealth({ db, work, now: () => at });
  const runner = (
    status: "active" | "paused" | "draining" | "revoked" = "active",
    lastSeenAt: number | null = at,
  ) => {
    const id = workspaceId();
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)",
      [
        id,
        workspace,
        userId,
        `Runner ${status}`,
        status,
        at,
        lastSeenAt,
        status === "revoked" ? at : null,
      ],
    );
    db.run("INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?)", [
      id,
      "0.1.53",
      at,
    ]);
    return id;
  };
  const checks = (runnerId?: string) =>
    db
      .query<{ envelope: string }, []>(
        "SELECT envelope FROM runner_command WHERE kind='login_check' ORDER BY ordinal",
      )
      .all()
      .map(
        (row) =>
          JSON.parse(
            Buffer.from(
              (JSON.parse(row.envelope) as { payload: string }).payload,
              "base64url",
            ).toString(),
          ) as Extract<RunnerCommand, { type: "login_check" }>,
      )
      .filter((command) => !runnerId || command.runnerId === runnerId);
  const answer = (
    command: { id: string; runnerId: string; agent: string },
    authenticated = true,
    limits?: { window: string; usedPercent: number; resetsAt: number | null }[],
  ) =>
    health.submit(command.runnerId, {
      executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      commandId: command.id,
      role: "implementer",
      stopReason: "end_turn",
      timedOut: false,
      cancelled: false,
      authRequired: false,
      agentExited: true,
      login: {
        agent: command.agent as "claude",
        authenticated,
        method: authenticated ? "subscription" : "none",
      },
      ...(limits ? { agentLimits: limits } : {}),
    });
  const seen = (runnerId: string) =>
    db.run("UPDATE runner SET last_seen_at=? WHERE id=?", [at, runnerId]);
  return {
    db,
    owner,
    work,
    health,
    runner,
    checks,
    answer,
    seen,
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("background sign-in checks run once per agent per interval and never while one is in flight", () => {
  const f = fixture();
  const runnerId = f.runner();
  f.health.refresh();
  expect(f.checks().map((check) => check.agent)).toEqual(["claude", "codex", "grok", "opencode"]);
  expect(f.checks().every((check) => check.memberId === undefined)).toBe(true);
  f.health.refresh();
  expect(f.checks()).toHaveLength(4);
  const [claude, codex] = f.checks();
  f.advance(10_000);
  f.answer(claude!);
  f.answer(codex!, false);

  f.advance(3 * 60_000);
  f.seen(runnerId);
  f.health.refresh();
  expect(f.checks()).toHaveLength(4);

  f.advance(2 * 60_000 - 5_000);
  f.seen(runnerId);
  f.health.refresh();
  expect(
    f
      .checks()
      .slice(4)
      .map((check) => check.agent),
  ).toEqual(["grok", "opencode"]);

  f.advance(10_000);
  f.seen(runnerId);
  f.health.refresh();
  expect(
    f
      .checks()
      .slice(6)
      .map((check) => check.agent),
  ).toEqual(["claude", "codex"]);
  expect(f.db.query("SELECT 1 FROM runner_command WHERE kind='probe'").get()).toBeNull();

  const inFlight = f.checks().length;
  f.work.enqueue({
    id: crypto.randomUUID(),
    type: "login_check",
    runnerId,
    workspaceId: f.owner.workspaceId,
    agent: "claude",
    issuedAt: f.now(),
    expiresAt: f.now() + 20 * 60_000,
  });
  f.advance(6 * 60_000);
  f.seen(runnerId);
  f.health.refresh();
  expect(
    f
      .checks()
      .slice(inFlight + 1)
      .map((check) => check.agent),
  ).toEqual(["codex", "grok", "opencode"]);
});

test("paused, draining, revoked and unseen runners are skipped", () => {
  const f = fixture();
  const active = f.runner();
  for (const status of ["paused", "draining", "revoked"] as const) f.runner(status);
  f.runner("active", null);
  f.runner("active", f.now() - 2 * 60_000);
  f.health.refresh();
  expect(new Set(f.checks().map((check) => check.runnerId))).toEqual(new Set([active]));
});

test("runner list reports signed in, signed out, checking, usage limit and unknown per agent", async () => {
  const f = fixture();
  const runnerId = f.runner();
  const statuses = () =>
    Object.fromEntries(
      f.health.agents(f.owner, runnerId).map(({ agent, ...rest }) => [agent, rest]),
    );
  expect(statuses()).toEqual({
    claude: { status: "unknown", checkedAt: null },
    codex: { status: "unknown", checkedAt: null },
    grok: { status: "unknown", checkedAt: null },
    opencode: { status: "unknown", checkedAt: null },
  });
  f.health.refresh();
  expect(statuses().claude!.status).toBe("checking");
  const [claude, codex] = f.checks();
  f.answer(claude!);
  f.answer(codex!, false);
  expect(statuses()).toEqual({
    claude: { status: "signed_in", checkedAt: f.now() },
    codex: { status: "signed_out", checkedAt: f.now() },
    grok: { status: "checking", checkedAt: null },
    opencode: { status: "checking", checkedAt: null },
  });
  const resetsAt = f.now() + 3_600_000;
  f.db.run(
    "INSERT INTO runner_agent_policy(runner_id,agent,quota_state,resets_at,cooldown_until) VALUES(?1,'claude','exhausted',?2,?3) ON CONFLICT(runner_id,agent) DO UPDATE SET quota_state='exhausted',resets_at=?2,cooldown_until=?3",
    [runnerId, resetsAt, resetsAt],
  );
  expect(statuses().claude).toEqual({ status: "usage_limit", checkedAt: f.now(), resetsAt });
  f.advance(3_600_001);
  expect(statuses().claude!.status).toBe("signed_in");

  const http = createRunnerHttp(
    {
      list: () => [{ id: runnerId, name: "Runner active", status: "active" }],
      serverVersion: () => null,
      agentVersions: () => [],
    } as unknown as RunnerControl,
    { agents: (principal, id) => f.health.agents(principal, id) },
  );
  const response = await http.browser(
    new Request("https://paws.example.invalid/api/runners"),
    f.owner,
  );
  const body = (await response!.json()) as {
    runners: { agents: { agent: string; status: string }[] }[];
  };
  expect(body.runners[0]!.agents.map(({ agent, status }) => [agent, status])).toEqual([
    ["claude", "signed_in"],
    ["codex", "signed_out"],
    ["grok", "unknown"],
    ["opencode", "unknown"],
  ]);
});

test("the latest usage windows reach the runner list with when they were read", () => {
  const f = fixture();
  const runnerId = f.runner();
  f.health.refresh();
  const [claude] = f.checks();
  const limits = [
    { window: "5-hour", usedPercent: 16, resetsAt: f.now() + 3_600_000 },
    { window: "Weekly", usedPercent: 3, resetsAt: null },
  ];
  f.answer(claude!, true, limits);
  const status = () => f.health.agents(f.owner, runnerId)[0]!;
  expect(status()).toEqual({
    agent: "claude",
    status: "signed_in",
    checkedAt: f.now(),
    limits,
    limitsAt: f.now(),
  });
  const resetsAt = f.now() + 60_000;
  f.db.run(
    "INSERT INTO runner_agent_policy(runner_id,agent,quota_state,resets_at,cooldown_until) VALUES(?1,'claude','exhausted',?2,?3) ON CONFLICT(runner_id,agent) DO UPDATE SET quota_state='exhausted',resets_at=?2,cooldown_until=?3",
    [runnerId, resetsAt, resetsAt],
  );
  expect(status()).toEqual({
    agent: "claude",
    status: "usage_limit",
    checkedAt: f.now(),
    resetsAt,
    limits,
    limitsAt: f.now(),
  });
  const schema = RunnerHealthResultSchema.shape.agentLimits;
  expect(schema.safeParse(limits).success).toBe(true);
  expect(schema.safeParse([]).success).toBe(false);
  for (const bad of [
    { window: "5-hour", usedPercent: 101, resetsAt: null },
    { window: "", usedPercent: 5, resetsAt: null },
    { window: "5-hour", usedPercent: 5, resetsAt: 1.5 },
    { window: "5-hour", usedPercent: 5, resetsAt: null, balance: "855" },
  ])
    expect(schema.safeParse([bad]).success).toBe(false);
});

test("an older usage reading never replaces a newer one", () => {
  const f = fixture();
  const runnerId = f.runner();
  const reading = (usedPercent: number) => [{ window: "Weekly", usedPercent, resetsAt: null }];
  const record = (usedPercent: number, observedAt: number) =>
    recordRunnerAgentUsage(f.db, {
      runnerId,
      agent: "codex",
      limits: reading(usedPercent),
      observedAt,
    });
  record(40, 2_000);
  record(10, 1_000);
  expect(runnerAgentUsage(f.db, runnerId, "codex")).toEqual({
    limits: reading(40),
    observedAt: 2_000,
  });
  record(55, 3_000);
  expect(runnerAgentUsage(f.db, runnerId, "codex")!.limits).toEqual(reading(55));
  expect(runnerAgentUsage(f.db, runnerId, "claude")).toBeNull();
});

test("a completed sign-in queues one login check for that agent", () => {
  const f = fixture();
  const runnerId = f.runner();
  const login = createRunnerLogin({
    db: f.db,
    work: f.work,
    now: f.now,
    onSignedIn: (signedIn) => f.health.afterSignIn(signedIn.runnerId, signedIn.agent),
  });
  const session = login.start(f.owner, runnerId, "claude");
  expect(f.checks()).toHaveLength(0);
  login.exchange(runnerId, session.id, {
    state: "connected",
    terminal: "",
    authorization: null,
    inputId: null,
  });
  expect(f.checks().map(({ agent, memberId }) => [agent, memberId])).toEqual([
    ["claude", undefined],
  ]);
  expect(f.health.afterSignIn(runnerId, "claude")).toBe(false);
  expect(f.health.agents(f.owner, runnerId).map(({ agent, status }) => [agent, status])).toEqual([
    ["claude", "checking"],
    ["codex", "unknown"],
    ["grok", "unknown"],
    ["opencode", "unknown"],
  ]);
});

test("a login check readies the runner's agent or marks it signed out", () => {
  const f = fixture();
  const runnerId = f.runner();
  const policy = () =>
    f.db
      .query<{ ready: number; authExpired: number }, [string]>(
        "SELECT ready,auth_expired AS authExpired FROM runner_agent_policy WHERE runner_id=? AND agent='grok'",
      )
      .get(runnerId);
  f.health.refresh();
  f.answer(f.checks(runnerId).find((command) => command.agent === "grok")!);
  expect(policy()).toEqual({ ready: 1, authExpired: 0 });
  f.advance(5 * 60_000 + 1);
  f.seen(runnerId);
  f.health.refresh();
  f.answer(
    f.checks(runnerId).findLast((command) => command.agent === "grok")!,
    false,
  );
  expect(policy()).toEqual({ ready: 0, authExpired: 1 });
});

test("a sign-in check's usage reading replaces a stale usage limit", () => {
  const f = fixture();
  const runnerId = f.runner();
  const reset = f.now() + 3 * 86_400_000;
  f.db.run(
    "INSERT INTO runner_agent_policy(runner_id,agent,ready,auth_expired,quota_state,resets_at,cooldown_until) VALUES(?,'claude',1,0,'exhausted',?,?)",
    [runnerId, reset, reset],
  );
  const policy = () =>
    f.db
      .query<{ quotaState: string; resetsAt: number | null; cooldownUntil: number }, [string]>(
        "SELECT quota_state AS quotaState,resets_at AS resetsAt,cooldown_until AS cooldownUntil FROM runner_agent_policy WHERE runner_id=? AND agent='claude'",
      )
      .get(runnerId);
  const claude = () => f.checks(runnerId).findLast((command) => command.agent === "claude")!;
  f.health.refresh();
  f.answer(claude(), true, [
    { window: "5-hour", usedPercent: 0, resetsAt: null },
    { window: "Weekly", usedPercent: 8, resetsAt: reset + 16 * 3_600_000 },
  ]);
  expect(policy()).toEqual({ quotaState: "ok", resetsAt: null, cooldownUntil: 0 });

  f.advance(5 * 60_000 + 1);
  f.seen(runnerId);
  f.health.refresh();
  f.answer(claude(), true, [
    { window: "5-hour", usedPercent: 12, resetsAt: null },
    { window: "Weekly", usedPercent: 100, resetsAt: reset },
  ]);
  expect(policy()).toEqual({ quotaState: "exhausted", resetsAt: reset, cooldownUntil: reset });

  f.advance(5 * 60_000 + 1);
  f.seen(runnerId);
  f.health.refresh();
  f.answer(claude());
  expect(policy()).toEqual({ quotaState: "exhausted", resetsAt: reset, cooldownUntil: reset });
});

test("older runners keep their three login checks and reject OpenCode before dispatch", () => {
  const f = fixture();
  const runnerId = f.runner();
  f.db.run("UPDATE runner_host_status SET runner_version='0.1.52' WHERE runner_id=?", [runnerId]);
  f.health.refresh();
  expect(f.checks().map((command) => command.agent)).toEqual(["claude", "codex", "grok"]);
  expect(() =>
    f.health.request(f.owner, runnerId, { type: "login_check", agent: "opencode" }),
  ).toThrow("OpenCode needs runner 0.1.53");
  expect(f.checks()).toHaveLength(3);
  f.db.run("UPDATE runner_host_status SET runner_version='0.1.53' WHERE runner_id=?", [runnerId]);
  f.health.refresh();
  expect(f.checks().map((command) => command.agent)).toEqual([
    "claude",
    "codex",
    "grok",
    "opencode",
  ]);
});
