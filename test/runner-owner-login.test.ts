import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  insertQueuedItem,
  migrate,
  migrations,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerLogin } from "../src/runner-login";
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
  let at = Date.now();
  const workspace = workspaceId();
  db.run("INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES(?,?,?,?)", [
    workspace,
    "login-org",
    "Login",
    at,
  ]);
  const members = ["owner", "admin", "member", "observer"].map((role, index) => {
    const userId = putWorkspaceUser(db, {
      id: workspaceId(),
      linearUserId: `login-user-${index}`,
      name: role,
      email: `${role}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: workspace,
      userId,
      role: role as WorkspacePrincipal["role"],
      active: true,
      teamIds: [],
      now: at,
    });
    return {
      workspaceId: workspace,
      userId,
      role: role as WorkspacePrincipal["role"],
      teamIds: [],
      authenticatedAt: at,
    };
  });
  const [owner, admin, member, observer] = [members[0]!, members[1]!, members[2]!, members[3]!];
  const runnerId = workspaceId();
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'active',?)",
    [runnerId, workspace, owner.userId, "Owner runner", at],
  );
  db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES(?,1)", [runnerId]);
  const signing = generateKeyPairSync("ed25519");
  const work = createRunnerWork({
    db,
    keyId: "login",
    privateKey: signing.privateKey,
    now: () => at,
  });
  const login = createRunnerLogin({ db, work, now: () => at });
  const waiting = {
    state: "waiting" as const,
    terminal: "",
    authorization: { url: "https://auth.openai.com/codex/device", message: "Enter the code 1234" },
    inputId: randomUUID(),
  };
  const connected = {
    state: "connected" as const,
    terminal: "",
    authorization: null,
    inputId: null,
  };
  const url = (id: string, suffix = "") =>
    `https://paws.example.invalid/api/runners/${runnerId}/accounts/codex/login/${id}${suffix}`;
  const policy = (agent: string) =>
    db
      .query<{ ready: number; authExpired: number }, [string, string]>(
        "SELECT ready,auth_expired AS authExpired FROM runner_agent_policy WHERE runner_id=? AND agent=?",
      )
      .get(runnerId, agent);
  return {
    db,
    owner,
    admin,
    member,
    observer,
    runnerId,
    work,
    login,
    waiting,
    connected,
    url,
    policy,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("the owner's sign-in carries no member and readies the runner's own agent", () => {
  const f = fixture();
  const session = f.login.start(f.owner, f.runnerId, "codex");
  expect(f.login.start(f.owner, f.runnerId, "codex").id).toBe(session.id);
  const [envelope] = f.work.commands(f.runnerId);
  const command = JSON.parse(
    Buffer.from(envelope!.payload, "base64url").toString(),
  ) as RunnerCommand;
  expect(command.type).toBe("login");
  expect(command.memberId).toBeUndefined();
  f.login.exchange(f.runnerId, session.id, f.waiting);
  expect(f.policy("codex")).toBeNull();
  f.login.exchange(f.runnerId, session.id, f.connected);
  expect(f.policy("codex")).toEqual({ ready: 1, authExpired: 0 });
  expect(f.login.list(f.owner, f.runnerId).accounts[1]!.connected).toBe(true);
});

test("only the runner owner can start, read, answer or list a sign-in", async () => {
  const f = fixture();
  for (const principal of [f.admin, f.member, f.observer]) {
    expect(() => f.login.start(principal, f.runnerId, "claude")).toThrow();
    expect(() => f.login.list(principal, f.runnerId)).toThrow();
  }
  expect(f.db.query("SELECT 1 FROM runner_login").get()).toBeNull();
  const session = f.login.start(f.owner, f.runnerId, "codex");
  f.login.exchange(f.runnerId, session.id, f.waiting);
  for (const method of ["GET", "DELETE"])
    expect(
      (await f.login.browser(new Request(f.url(session.id), { method }), f.admin))!.status,
    ).toBe(403);
  const answer = (principal: WorkspacePrincipal) =>
    f.login.browser(
      new Request(f.url(session.id, "/input"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true }),
      }),
      principal,
    );
  expect((await answer(f.member))!.status).toBe(403);
  expect((await answer(f.owner))!.status).toBe(200);
  expect(f.login.exchange(f.runnerId, session.id, f.waiting).input).toEqual({
    id: f.waiting.inputId,
    value: { accept: true },
  });
  expect(
    f.login.exchange(f.runnerId, session.id, { ...f.waiting, inputId: null }).input,
  ).toBeNull();
});

test("revocation, expiry and cancellation fence provider completion", async () => {
  for (const condition of ["revoked", "expired", "cancelled", "shutdown", "transferred"] as const) {
    const f = fixture();
    const session = f.login.start(f.owner, f.runnerId, "codex");
    if (condition === "revoked")
      f.db.run("UPDATE workspace_member SET active=0 WHERE user_id=?", [f.owner.userId]);
    if (condition === "expired") f.advance(600001);
    if (condition === "shutdown") f.login.stop();
    if (condition === "transferred")
      f.db.run("UPDATE runner SET owner_user_id=? WHERE id=?", [f.admin.userId, f.runnerId]);
    if (condition === "cancelled")
      await f.login.browser(new Request(f.url(session.id), { method: "DELETE" }), f.owner);
    expect(f.login.exchange(f.runnerId, session.id, f.connected).cancelled).toBe(true);
    expect(f.policy("codex")).toBeNull();
  }
});

test("login rejects foreign runners and provider URL substitution", () => {
  const f = fixture();
  const session = f.login.start({ ...f.owner, authenticatedAt: 0 }, f.runnerId, "codex");
  expect(() => f.login.exchange(workspaceId(), session.id, f.waiting)).toThrow();
  expect(() =>
    f.login.exchange(f.runnerId, session.id, {
      ...f.waiting,
      authorization: { url: "https://evil.example.invalid/authorize", message: "Open" },
    }),
  ).toThrow();
});

test("delayed login input is rejected after cancellation, revocation, expiry or prompt changes", async () => {
  for (const change of ["cancelled", "revoked", "expired", "prompt"] as const) {
    const f = fixture();
    const session = f.login.start(f.owner, f.runnerId, "codex");
    f.login.exchange(f.runnerId, session.id, f.waiting);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const pending = f.login.browser(
      new Request(f.url(session.id, "/input"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      f.owner,
    );
    if (change === "cancelled")
      await f.login.browser(new Request(f.url(session.id), { method: "DELETE" }), f.owner);
    if (change === "revoked")
      f.db.run("UPDATE workspace_member SET active=0 WHERE user_id=?", [f.owner.userId]);
    if (change === "expired") f.advance(600001);
    const current = change === "prompt" ? { ...f.waiting, inputId: randomUUID() } : f.waiting;
    if (change === "prompt") f.login.exchange(f.runnerId, session.id, current);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ accept: true })));
    controller.close();
    expect((await pending)!.status).toBe(403);
    expect(f.login.exchange(f.runnerId, session.id, current).input).toBeNull();
  }
});

test("Grok device login rejects foreign authorization hosts and connects the runner", async () => {
  const f = fixture();
  const endpoint = `https://paws.example.invalid/api/runners/${f.runnerId}/accounts/grok/login`;
  const response = await f.login.browser(new Request(endpoint, { method: "POST" }), f.owner);
  expect(response?.status).toBe(200);
  const session = (await response!.json()) as { id: string };
  const waiting = {
    ...f.waiting,
    inputId: null,
    authorization: {
      url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      message: "Enter ABCD-1234",
    },
  };
  expect(() => f.login.exchange(f.runnerId, session.id, f.waiting)).toThrow("authorization URL");
  for (const url of [
    "https://auth.x.ai.evil.invalid/device",
    "http://auth.x.ai/device",
    "https://user@auth.x.ai/device",
    "https://auth.x.ai:444/device",
    "https://accounts.x.ai.evil.invalid/oauth2/device",
    "http://accounts.x.ai/oauth2/device",
    "https://user@accounts.x.ai/oauth2/device",
    "https://accounts.x.ai:444/oauth2/device",
  ])
    expect(() =>
      f.login.exchange(f.runnerId, session.id, {
        ...waiting,
        authorization: { url, message: "Enter ABCD-1234" },
      }),
    ).toThrow();
  f.login.exchange(f.runnerId, session.id, {
    ...waiting,
    authorization: { url: "https://auth.x.ai/device", message: "Enter ABCD-1234" },
  });
  f.login.exchange(f.runnerId, session.id, waiting);
  expect(
    f.login.list(f.owner, f.runnerId).accounts.find((entry) => entry.agent === "grok")?.session
      ?.authorization,
  ).toEqual(waiting.authorization);
  f.login.exchange(f.runnerId, session.id, f.connected);
  expect(
    f.login.list(f.owner, f.runnerId).accounts.find((entry) => entry.agent === "grok")?.connected,
  ).toBe(true);
});

test("starting another sign-in keeps an agent that is already connected", () => {
  const f = fixture();
  const session = f.login.start(f.owner, f.runnerId, "grok");
  f.login.exchange(f.runnerId, session.id, f.connected);
  f.advance(1_000);
  const again = f.login.start(f.owner, f.runnerId, "grok");
  expect(again.id).not.toBe(session.id);
  expect(again.state).toBe("starting");
  expect(
    f.login.list(f.owner, f.runnerId).accounts.find((entry) => entry.agent === "grok")?.connected,
  ).toBe(true);
});

test("migration 091 drops member accounts and asks their runners to sign in again", () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.run("CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT");
  for (const migration of migrations.slice(
    0,
    migrations.findIndex((entry) => entry.id === "091_runner_owner_accounts"),
  )) {
    db.run(migration.sql);
    db.run("INSERT INTO schema_migration VALUES(?,0)", [migration.id]);
  }
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('w','org','W',1)",
  );
  for (const user of ["owner", "member"]) {
    db.run("INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES(?,?,?,?)", [
      user,
      `linear-${user}`,
      user,
      `${user}@example.invalid`,
    ]);
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES('w',?,?,'linear',1,1)",
      [user, user],
    );
  }
  for (const runner of ["shared", "plain"]) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,'w','owner',?,'active',1)",
      [runner, runner],
    );
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,'codex',1)", [runner]);
  }
  for (const user of ["owner", "member"]) {
    db.run(
      "INSERT INTO runner_member_account(runner_id,user_id,agent,connected,updated_at) VALUES('shared',?,'codex',1,1)",
      [user],
    );
    db.run(
      "INSERT INTO runner_agent_usage(runner_id,member_id,agent,limits_json,observed_at) VALUES('shared',?,'codex','[]',1)",
      [user],
    );
    db.run(
      "INSERT INTO agent_model_catalog(runner_id,user_id,agent,model,result_json,updated_at) VALUES('shared',?,'codex','','{}',1)",
      [user],
    );
  }
  db.run(
    "INSERT INTO runner_agent_usage(runner_id,member_id,agent,limits_json,observed_at) VALUES('plain','','codex','[]',2)",
  );
  migrate(db);
  expect(
    db.query("SELECT name FROM sqlite_master WHERE name='runner_member_account'").get(),
  ).toBeNull();
  expect(
    db
      .query("SELECT runner_id,ready,auth_expired FROM runner_agent_policy ORDER BY runner_id")
      .all(),
  ).toEqual([
    { runner_id: "plain", ready: 1, auth_expired: 0 },
    { runner_id: "shared", ready: 0, auth_expired: 1 },
  ]);
  expect(db.query("SELECT runner_id,agent,observed_at FROM runner_agent_usage").all()).toEqual([
    { runner_id: "plain", agent: "codex", observed_at: 2 },
  ]);
  expect(db.query("SELECT user_id FROM agent_model_catalog").all()).toEqual([{ user_id: "owner" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

function busy(f: ReturnType<typeof fixture>, agent: string) {
  insertQueuedItem(f.db, { id: `busy-item-${agent}`, now: 0 });
  f.db.run(
    "INSERT INTO run(id,item_id,kind,agent,status,created_at,updated_at) VALUES(?,?,'implement',?,'active',0,0)",
    [`busy-run-${agent}`, `busy-item-${agent}`, agent],
  );
  f.db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,1,0,?,?)",
    [
      `busy-run-${agent}`,
      f.runnerId,
      f.owner.workspaceId,
      `busy-command-${agent}`,
      Date.now() + 60_000,
    ],
  );
  return () => f.db.query("SELECT * FROM runner_work WHERE run_id=?").get(`busy-run-${agent}`);
}

for (const agent of ["claude", "grok"] as const) {
  test(`a sign-in to ${agent} starts while the runner runs a Claude task`, async () => {
    const f = fixture();
    busy(f, "claude");
    const response = (await f.login.browser(
      new Request(
        `https://paws.example.invalid/api/runners/${f.runnerId}/accounts/${agent}/login`,
        {
          method: "POST",
        },
      ),
      f.owner,
    ))!;
    expect(response.status).toBe(200);
    expect(((await response.json()) as { state: string }).state).toBe("starting");
    expect(f.db.query("SELECT agent,state FROM runner_login").all()).toEqual([
      { agent, state: "starting" },
    ]);
    const accounts = f.login.list(f.owner, f.runnerId).accounts;
    expect(accounts.map((account) => [account.agent, account.running])).toEqual([
      ["claude", 1],
      ["codex", 0],
      ["grok", 0],
    ]);
  });
}

test("a runner with four sign-ins waiting refuses another, even while it works", async () => {
  const f = fixture();
  busy(f, "codex");
  for (const agent of ["claude", "codex", "grok"] as const)
    f.login.start(f.owner, f.runnerId, agent);
  // Sign-ins left waiting by the runner's earlier owners still count.
  for (const earlier of [f.admin, f.member]) {
    f.db.run("UPDATE runner_login SET user_id=? WHERE user_id=? AND agent='grok'", [
      earlier.userId,
      f.owner.userId,
    ]);
    if (earlier === f.admin)
      expect(f.login.start(f.owner, f.runnerId, "grok").state).toBe("starting");
  }
  const response = (await f.login.browser(
    new Request(`https://paws.example.invalid/api/runners/${f.runnerId}/accounts/grok/login`, {
      method: "POST",
    }),
    f.owner,
  ))!;
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({
    error: "This runner already has four sign-ins waiting. Finish one first.",
  });
});

test("a sign-in that succeeds during a live turn of its agent clears auth_expired and leaves the turn", () => {
  const f = fixture();
  f.db.run(
    "INSERT INTO runner_agent_policy(runner_id,agent,ready,auth_expired) VALUES(?,'claude',0,1)",
    [f.runnerId],
  );
  const turn = busy(f, "claude");
  const before = turn();
  const session = f.login.start(f.owner, f.runnerId, "claude");
  expect(session.state).toBe("starting");
  f.login.exchange(f.runnerId, session.id, f.connected);
  expect(f.policy("claude")).toEqual({ ready: 1, authExpired: 0 });
  expect(turn()).toEqual(before);
  expect(f.login.list(f.owner, f.runnerId).accounts[0]).toMatchObject({
    agent: "claude",
    connected: true,
    running: 1,
  });
});

test("the owner can sign in agents on a paused runner, not on a draining or revoked one", () => {
  const f = fixture();
  f.db.run("UPDATE runner SET status='paused' WHERE id=?", [f.runnerId]);
  const session = f.login.start(f.owner, f.runnerId, "claude");
  expect(session.state).toBe("starting");
  expect(f.login.list(f.owner, f.runnerId).accounts.length).toBeGreaterThan(0);
  for (const status of ["draining", "revoked"]) {
    f.db.run("UPDATE runner SET status=? WHERE id=?", [status, f.runnerId]);
    expect(() => f.login.start(f.owner, f.runnerId, "codex")).toThrow();
  }
});
