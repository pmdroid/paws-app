import { expect, test } from "bun:test";
import { join } from "node:path";
import { createAccountManagement } from "../src/account-management";
import type { AccountPolicy, AgentProfiles } from "../src/config";
import {
  consumeWorkspaceBootstrap,
  legacyAgentAccountId,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordAccountObservation,
  recordRunnerAccountCapability,
} from "../src/db";
import {
  issueWorkspaceBootstrap,
  workspaceId,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";
import { tempHome } from "./helpers";

const PROFILES: AgentProfiles = {
  implementer: { agent: "claude", model: "opus" },
  reviewer: { agent: "codex", model: null },
};

function fixture() {
  const db = openDatabase(join(tempHome(), "paws.sqlite"));
  migrate(db);
  let clock = Date.now();
  const user = (name: string) =>
    putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: name,
      name,
      email: `${name}@example.invalid`,
    });
  const admin = user("admin");
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Test",
    userId: admin,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", clock)),
    now: clock,
  });
  const memberId = user("member");
  db.run(
    "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES(?,?,'member','manual',1,?)",
    [workspace.id, memberId, clock],
  );
  const runners = { R1: workspaceId(), R2: workspaceId() };
  for (const [name, id] of Object.entries(runners)) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
      [id, workspace.id, name === "R2" ? memberId : admin, name, clock, clock],
    );
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'claude',1)", [id]);
    db.run("INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?)", [
      id,
      "0.1.61",
      clock,
    ]);
  }
  const principal = (userId: string, role: "admin" | "member"): WorkspacePrincipal => ({
    workspaceId: workspace.id,
    userId,
    role,
    authenticatedAt: clock,
    teamIds: [],
  });
  let policy: AccountPolicy | null = null;
  const handler = createAccountManagement({
    db,
    now: () => clock,
    settings: () => ({ profiles: PROFILES, policy }),
  });
  const call = async (
    who: WorkspacePrincipal,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = (await handler(
      new Request(`https://paws.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      who,
    ))!;
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  };
  const audits = () =>
    db
      .query<{ action: string; subject: string }, [string]>(
        "SELECT action,subject FROM workspace_access_audit WHERE workspace_id=? AND action LIKE 'agent_account.%' ORDER BY id",
      )
      .all(workspace.id);
  return {
    db,
    workspaceId: workspace.id,
    runners,
    admin: principal(admin, "admin"),
    member: principal(memberId, "member"),
    memberId,
    call,
    audits,
    setPolicy(value: AccountPolicy | null) {
      policy = value;
    },
    report(runnerId: string, bindingIds: string[]) {
      recordRunnerAccountCapability(
        db,
        runnerId,
        { protocol: 1, bindings: bindingIds.map((bindingId) => ({ bindingId, agent: "claude" })) },
        clock,
      );
    },
    now: () => clock,
    tick(ms: number) {
      clock += ms;
      db.run("UPDATE runner SET last_seen_at=?", [clock]);
    },
  };
}

async function twoAccounts(f: ReturnType<typeof fixture>) {
  let list = (await f.call(f.admin, "/api/runners/accounts")).body;
  list = (
    await f.call(f.admin, "/api/runners/accounts", {
      revision: list.revision,
      agent: "claude",
      label: "Team A",
    })
  ).body;
  list = (
    await f.call(f.admin, "/api/runners/accounts", {
      revision: list.revision,
      agent: "claude",
      label: "Team B",
    })
  ).body;
  const id = (label: string) =>
    list.accounts.find((account: { label: string }) => account.label === label).id as string;
  const a = id("Team A");
  const b = id("Team B");
  for (const [account, runner] of [
    [a, f.runners.R1],
    [a, f.runners.R2],
    [b, f.runners.R1],
  ] as const)
    list = (
      await f.call(f.admin, `/api/runners/accounts/${account}/bindings`, {
        revision: list.revision,
        runnerId: runner,
      })
    ).body;
  const binding = (account: string, runner: string) =>
    list.accounts
      .find((entry: { id: string }) => entry.id === account)
      .bindings.find((entry: { runnerId: string }) => entry.runnerId === runner).id as string;
  return {
    a,
    b,
    list,
    bindings: {
      a1: binding(a, f.runners.R1),
      a2: binding(a, f.runners.R2),
      b1: binding(b, f.runners.R1),
    },
  };
}

test("a single-account installation lists only its default sign-ins and previews the default", async () => {
  const f = fixture();
  const list = await f.call(f.member, "/api/runners/accounts");
  expect(list.status).toBe(200);
  expect(list.body.canManage).toBe(false);
  expect(list.body.accounts).toHaveLength(1);
  expect(list.body.accounts[0]).toMatchObject({
    id: legacyAgentAccountId(f.workspaceId, "claude"),
    legacy: true,
    sharedLimit: false,
  });
  expect(
    list.body.accounts[0].bindings.map((b: { readiness: { state: string } }) => b.readiness.state),
  ).toEqual(["eligible", "eligible"]);
  expect(
    list.body.agents.every((agent: { unsupported: string | null }) => agent.unsupported === null),
  ).toBe(true);
  const preview = await f.call(f.member, "/api/runners/accounts/preview?role=implementer");
  expect(preview.body).toMatchObject({
    agent: "claude",
    source: "default",
    policyRevision: null,
    waiting: null,
    choice: { accountId: legacyAgentAccountId(f.workspaceId, "claude"), fallback: null },
  });
});

test("only an admin manages accounts; a runner owner links and unlinks only their own runner", async () => {
  const f = fixture();
  const { revision } = (await f.call(f.member, "/api/runners/accounts")).body;
  const denied = await f.call(f.member, "/api/runners/accounts", {
    revision,
    agent: "claude",
    label: "Mine",
  });
  expect(denied.status).toBe(403);
  const { a, list } = await twoAccounts(f);
  expect(
    (
      await f.call(f.member, `/api/runners/accounts/${a}`, {
        revision: list.revision,
        enabled: false,
      })
    ).status,
  ).toBe(403);
  const b = list.accounts.find((entry: { label: string }) => entry.label === "Team B").id;
  expect(
    (
      await f.call(f.member, `/api/runners/accounts/${b}/bindings`, {
        revision: list.revision,
        runnerId: f.runners.R1,
      })
    ).status,
  ).toBe(403);
  const own = await f.call(f.member, `/api/runners/accounts/${b}/bindings`, {
    revision: list.revision,
    runnerId: f.runners.R2,
  });
  expect(own.status).toBe(200);
  const bindingId = own.body.accounts
    .find((entry: { id: string }) => entry.id === b)
    .bindings.find((entry: { runnerId: string }) => entry.runnerId === f.runners.R2).id;
  expect(
    (
      await f.call(f.member, `/api/runners/accounts/${b}/bindings/${bindingId}/remove`, {
        revision: own.body.revision,
      })
    ).status,
  ).toBe(200);
  expect(f.audits().map((row) => row.action)).toEqual([
    "agent_account.created",
    "agent_account.created",
    "agent_account.binding_added",
    "agent_account.binding_added",
    "agent_account.binding_added",
    "agent_account.binding_added",
    "agent_account.binding_removed",
  ]);
  expect(f.audits().every((row) => !row.subject.includes("Team"))).toBe(true);
  const legacy = legacyAgentAccountId(f.workspaceId, "claude");
  expect(
    (
      await f.call(f.admin, `/api/runners/accounts/${legacy}`, {
        revision: list.revision,
        enabled: false,
      })
    ).status,
  ).toBe(409);
});

test("a stale or repeated write is refused and leaves the newer state", async () => {
  const f = fixture();
  const { a, list } = await twoAccounts(f);
  const renamed = await f.call(f.admin, `/api/runners/accounts/${a}`, {
    revision: list.revision,
    label: "Team A (primary)",
  });
  expect(renamed.status).toBe(200);
  const stale = await f.call(f.admin, `/api/runners/accounts/${a}`, {
    revision: list.revision,
    enabled: false,
  });
  expect(stale.status).toBe(409);
  expect(stale.body.revision).toBe(renamed.body.revision);
  const created = await f.call(f.admin, "/api/runners/accounts", {
    revision: renamed.body.revision,
    agent: "claude",
    label: "Team C",
  });
  expect(created.status).toBe(200);
  const repeated = await f.call(f.admin, "/api/runners/accounts", {
    revision: renamed.body.revision,
    agent: "claude",
    label: "Team C",
  });
  expect(repeated.status).toBe(409);
  const now = (await f.call(f.admin, "/api/runners/accounts")).body;
  expect(now.accounts.filter((entry: { label: string }) => entry.label === "Team C")).toHaveLength(
    1,
  );
  expect(now.accounts.find((entry: { id: string }) => entry.id === a)).toMatchObject({
    label: "Team A (primary)",
    enabled: true,
  });
  const bad = await f.call(f.admin, "/api/runners/accounts", {
    revision: now.revision,
    agent: "claude",
    label: "",
  });
  expect(bad.status).toBe(400);
});

test("membership is checked before the ETag answers, and a matching ETag is 304", async () => {
  const f = fixture();
  const first = await f.call(f.member, "/api/runners/accounts");
  const tag = first.headers.get("etag")!;
  expect(tag).toStartWith('W/"');
  const again = await f.call(f.member, "/api/runners/accounts", undefined, {
    "if-none-match": tag,
  });
  expect(again.status).toBe(304);
  f.db.run("UPDATE workspace_member SET active=0 WHERE user_id=?", [f.memberId]);
  const revoked = await f.call(f.member, "/api/runners/accounts", undefined, {
    "if-none-match": tag,
  });
  expect(revoked.status).toBe(403);
  expect(JSON.stringify(revoked.body)).not.toContain("Team");
});

test("A→B: readiness, shared limits and the preview explain which account new work gets, without dispatching", async () => {
  const f = fixture();
  const { a, b, bindings } = await twoAccounts(f);
  f.report(f.runners.R1, [bindings.a1, bindings.b1]);
  f.report(f.runners.R2, [bindings.a2]);
  f.setPolicy({
    revision: "pol-1",
    implementer: { agent: "claude", accounts: [a, b], source: "defaults" },
  });
  const counts = () =>
    f.db
      .query<{ commands: number; usage: number; health: number }, []>(
        `SELECT (SELECT COUNT(*) FROM runner_command) AS commands,
         (SELECT COUNT(*) FROM runner_execution_usage) AS usage,
         (SELECT COUNT(*) FROM agent_account_health) AS health`,
      )
      .get()!;
  const listed = (await f.call(f.admin, "/api/runners/accounts")).body;
  const teamA = listed.accounts.find((entry: { id: string }) => entry.id === a);
  expect(teamA.sharedLimit).toBe(true);
  expect(
    teamA.bindings.map((binding: { readiness: { state: string } }) => binding.readiness.state),
  ).toEqual(["eligible", "eligible"]);
  let preview = (await f.call(f.admin, "/api/runners/accounts/preview?role=implementer")).body;
  expect(preview.choice).toMatchObject({ accountId: a, position: 1, fallback: null });
  expect(preview.policyRevision).toBe("pol-1");

  recordAccountObservation(f.db, {
    bindingId: bindings.a1,
    source: "result",
    sourceId: "limit",
    observedAt: f.now(),
    now: f.now(),
    state: "exhausted",
    resetsAt: null,
  });
  const before = counts();
  preview = (await f.call(f.admin, "/api/runners/accounts/preview?role=implementer")).body;
  expect(preview.choice).toMatchObject({
    accountId: b,
    position: 2,
    fallback: "Team A: agent account quota cooldown, reset unknown",
  });
  const cooled = preview.accounts[0].bindings;
  expect(
    cooled.map(
      (binding: { readiness: { state: string; resetUnknown: boolean } }) => binding.readiness,
    ),
  ).toEqual([
    expect.objectContaining({ state: "cooling-down", resetUnknown: true }),
    expect.objectContaining({ state: "cooling-down", resetUnknown: true }),
  ]);
  expect(counts()).toEqual(before);

  const disabled = await f.call(f.admin, `/api/runners/accounts/${b}`, {
    revision: listed.revision,
    enabled: false,
  });
  expect(disabled.status).toBe(200);
  preview = (await f.call(f.admin, "/api/runners/accounts/preview?role=implementer")).body;
  expect(preview.choice).toBeNull();
  expect(preview.accounts[1].skipped).toBe("account is disabled");
  expect(preview.waiting).toContain("Team A: agent account quota cooldown, reset unknown");
  expect(counts()).toEqual(before);

  const unsigned = await f.call(f.admin, `/api/runners/accounts/${b}`, {
    revision: disabled.body.revision,
    enabled: true,
  });
  f.report(f.runners.R1, [bindings.a1]);
  const relisted = (await f.call(f.admin, "/api/runners/accounts")).body;
  expect(unsigned.status).toBe(200);
  expect(
    relisted.accounts.find((entry: { id: string }) => entry.id === b).bindings[0].readiness,
  ).toMatchObject({ state: "auth-required", reason: "not-signed-in" });
  expect(
    (await f.call(f.admin, "/api/runners/accounts/preview?role=reviewerFallback")).status,
  ).toBe(404);
  expect(
    (await f.call(f.admin, "/api/runners/accounts/preview?role=implementer&repository=../x"))
      .status,
  ).toBe(400);
});
