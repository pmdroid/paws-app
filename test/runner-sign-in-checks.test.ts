import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Database } from "bun:sqlite";
import { migrate, putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerHealth } from "../src/runner-health";
import { createRunnerLogin } from "../src/runner-login";
import { createRunnerHttp, type RunnerControl } from "../src/runner-control";
import { workspaceId, type WorkspacePrincipal } from "../src/workspace";
import type { RunnerCommand } from "../src/runner-protocol";

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
    role: "owner",
    active: true,
    teamIds: [],
    now: at,
  });
  const owner: WorkspacePrincipal = {
    workspaceId: workspace,
    userId,
    role: "owner",
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
  const answer = (command: { id: string; runnerId: string; agent: string }, authenticated = true) =>
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
  expect(f.checks().map((check) => check.agent)).toEqual(["claude", "codex", "grok"]);
  expect(f.checks().every((check) => check.memberId === undefined)).toBe(true);
  f.health.refresh();
  expect(f.checks()).toHaveLength(3);
  const [claude, codex] = f.checks();
  f.advance(10_000);
  f.answer(claude!);
  f.answer(codex!, false);

  f.advance(3 * 60_000);
  f.seen(runnerId);
  f.health.refresh();
  expect(f.checks()).toHaveLength(3);

  f.advance(2 * 60_000 - 5_000);
  f.seen(runnerId);
  f.health.refresh();
  expect(
    f
      .checks()
      .slice(3)
      .map((check) => check.agent),
  ).toEqual(["grok"]);

  f.advance(10_000);
  f.seen(runnerId);
  f.health.refresh();
  expect(
    f
      .checks()
      .slice(4)
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
  ).toEqual(["codex", "grok"]);
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
  });
  const resetsAt = f.now() + 3_600_000;
  f.db.run(
    "INSERT INTO runner_agent_policy(runner_id,agent,quota_state,resets_at,cooldown_until) VALUES(?,'claude','exhausted',?,?)",
    [runnerId, resetsAt, resetsAt],
  );
  expect(statuses().claude).toEqual({ status: "usage_limit", checkedAt: f.now(), resetsAt });
  f.advance(3_600_001);
  expect(statuses().claude!.status).toBe("signed_in");

  const http = createRunnerHttp(
    {
      list: () => [{ id: runnerId, name: "Runner active", status: "active" }],
      serverVersion: () => null,
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
  ]);
});

test("a completed member sign-in queues one login check for that member and agent", () => {
  const f = fixture();
  const runnerId = f.runner();
  const login = createRunnerLogin({
    db: f.db,
    work: f.work,
    now: f.now,
    onSignedIn: (signedIn) =>
      f.health.afterSignIn(signedIn.runnerId, signedIn.memberId, signedIn.agent),
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
    ["claude", f.owner.userId],
  ]);
  expect(f.health.afterSignIn(runnerId, f.owner.userId, "claude")).toBe(false);
  f.health.refresh();
  expect(f.checks()).toHaveLength(1);
  expect(f.health.agents(f.owner, runnerId).map(({ agent, status }) => [agent, status])).toEqual([
    ["claude", "checking"],
    ["codex", "unknown"],
  ]);
});
