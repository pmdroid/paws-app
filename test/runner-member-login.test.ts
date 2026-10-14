import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { migrate, putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import { createRunnerWork } from "../src/runner-work";
import { createRunnerLogin } from "../src/runner-login";
import { authorizeRunnerAccount } from "../src/runner-accounts";
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
  const members = ["owner", "member", "observer"].map((role, index) => {
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
  const owner = members[0]!;
  const member = members[1]!;
  const observer = members[2]!;
  const runnerId = workspaceId();
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'active',?)",
    [runnerId, workspace, owner.userId, "Member runner", at],
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
  const url = (id: string, suffix = "") =>
    `https://paws.example.invalid/api/runners/${runnerId}/accounts/codex/login/${id}${suffix}`;
  return {
    db,
    owner,
    member,
    observer,
    runnerId,
    work,
    login,
    waiting,
    url,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

test("member login binds signed identity and never lets a second member read, answer or cancel it", async () => {
  const f = fixture();
  const session = f.login.start(f.member, f.runnerId, "codex");
  expect(f.login.start(f.member, f.runnerId, "codex").id).toBe(session.id);
  const [envelope] = f.work.commands(f.runnerId);
  const command = JSON.parse(
    Buffer.from(envelope!.payload, "base64url").toString(),
  ) as RunnerCommand;
  expect(command.memberId).toBe(f.member.userId);
  expect(command.type).toBe("login");
  f.login.exchange(f.runnerId, session.id, f.waiting);
  for (const method of ["GET", "DELETE"])
    expect(
      (await f.login.browser(new Request(f.url(session.id), { method }), f.owner))!.status,
    ).toBe(403);
  expect(
    (await f.login.browser(
      new Request(f.url(session.id, "/input"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true }),
      }),
      f.owner,
    ))!.status,
  ).toBe(403);
  expect(f.login.list(f.owner, f.runnerId).accounts[1]!.session).toBeNull();
  expect(
    (await f.login.browser(
      new Request(f.url(session.id, "/input"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accept: true }),
      }),
      f.member,
    ))!.status,
  ).toBe(200);
  expect(f.login.exchange(f.runnerId, session.id, f.waiting).input).toEqual({
    id: f.waiting.inputId,
    value: { accept: true },
  });
  expect(
    f.login.exchange(f.runnerId, session.id, { ...f.waiting, inputId: null }).input,
  ).toBeNull();
  f.login.exchange(f.runnerId, session.id, {
    state: "connected",
    terminal: "",
    authorization: null,
    inputId: null,
  });
  expect(f.login.list(f.member, f.runnerId).accounts[1]!.connected).toBe(true);
  expect(f.login.list(f.owner, f.runnerId).accounts[1]!.connected).toBe(false);
});

test("revocation, expiry and cancellation fence provider completion", async () => {
  for (const condition of ["revoked", "expired", "cancelled", "shutdown", "sharing"] as const) {
    const f = fixture();
    const session = f.login.start(f.member, f.runnerId, "codex");
    if (condition === "revoked")
      f.db.run("UPDATE workspace_member SET active=0 WHERE user_id=?", [f.member.userId]);
    if (condition === "expired") f.advance(600001);
    if (condition === "shutdown") f.login.stop();
    if (condition === "sharing") f.db.run("UPDATE runner_policy SET sharing=0");
    if (condition === "cancelled")
      await f.login.browser(new Request(f.url(session.id), { method: "DELETE" }), f.member);
    expect(
      f.login.exchange(f.runnerId, session.id, {
        state: "connected",
        terminal: "",
        authorization: null,
        inputId: null,
      }).cancelled,
    ).toBe(true);
    expect(
      f.db.query<{ connected: number }, []>("SELECT connected FROM runner_member_account").get()!
        .connected,
    ).toBe(0);
  }
});

test("member accounts reject shared execution and expired memberships while legacy hosts remain supported", () => {
  const f = fixture();
  const probe: RunnerCommand = {
    id: randomUUID(),
    type: "probe",
    runnerId: f.runnerId,
    workspaceId: f.member.workspaceId,
    profile: { agent: "codex", model: null },
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
  };
  expect(() => authorizeRunnerAccount(f.db, probe)).not.toThrow();
  const session = f.login.start(f.member, f.runnerId, "codex");
  expect(() => authorizeRunnerAccount(f.db, probe)).toThrow("Select a member");
  expect(() => authorizeRunnerAccount(f.db, { ...probe, memberId: f.member.userId })).toThrow(
    "requires sign-in",
  );
  f.login.exchange(f.runnerId, session.id, {
    state: "connected",
    terminal: "",
    authorization: null,
    inputId: null,
  });
  expect(() => authorizeRunnerAccount(f.db, { ...probe, memberId: f.member.userId })).not.toThrow();
  expect(() => authorizeRunnerAccount(f.db, { ...probe, memberId: f.owner.userId })).toThrow(
    "requires sign-in",
  );
  f.db.run("UPDATE runner_policy SET sharing=0");
  expect(() => authorizeRunnerAccount(f.db, { ...probe, memberId: f.member.userId })).toThrow(
    "sharing",
  );
  f.db.run("UPDATE workspace_member SET active=0 WHERE user_id=?", [f.member.userId]);
  expect(() => authorizeRunnerAccount(f.db, { ...probe, memberId: f.member.userId })).toThrow(
    "membership",
  );
});

test("login rejects observers, stale sign-in, foreign runners and provider URL substitution", () => {
  const f = fixture();
  expect(() => f.login.start(f.observer, f.runnerId, "codex")).toThrow();
  expect(() => f.login.start({ ...f.member, authenticatedAt: 0 }, f.runnerId, "codex")).toThrow();
  const session = f.login.start(f.member, f.runnerId, "codex");
  expect(() => f.login.exchange(workspaceId(), session.id, f.waiting)).toThrow();
  expect(() =>
    f.login.exchange(f.runnerId, session.id, {
      ...f.waiting,
      authorization: { url: "https://evil.example.invalid/authorize", message: "Open" },
    }),
  ).toThrow();
});

test("a member cannot initiate account cutover without host consent, while the owner can", () => {
  const f = fixture();
  f.db.run("UPDATE runner_policy SET sharing=0");
  expect(() => f.login.start(f.member, f.runnerId, "claude")).toThrow("sharing");
  expect(f.db.query("SELECT 1 FROM runner_member_account").get()).toBeNull();
  expect(f.db.query("SELECT 1 FROM runner_login").get()).toBeNull();
  const session = f.login.start(f.owner, f.runnerId, "claude");
  expect(session.state).toBe("starting");
  expect(() =>
    authorizeRunnerAccount(f.db, {
      id: randomUUID(),
      type: "probe",
      runnerId: f.runnerId,
      workspaceId: f.owner.workspaceId,
      profile: { agent: "codex", model: null },
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    }),
  ).toThrow("Select a member");
});

test("delayed login input is rejected after cancellation, revocation, expiry or prompt changes", async () => {
  for (const change of ["cancelled", "revoked", "expired", "prompt"] as const) {
    const f = fixture();
    const session = f.login.start(f.member, f.runnerId, "codex");
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
      f.member,
    );
    if (change === "cancelled")
      await f.login.browser(new Request(f.url(session.id), { method: "DELETE" }), f.member);
    if (change === "revoked")
      f.db.run("UPDATE workspace_member SET active=0 WHERE user_id=?", [f.member.userId]);
    if (change === "expired") f.advance(600001);
    const current = change === "prompt" ? { ...f.waiting, inputId: randomUUID() } : f.waiting;
    if (change === "prompt") f.login.exchange(f.runnerId, session.id, current);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ accept: true })));
    controller.close();
    expect((await pending)!.status).toBe(403);
    expect(f.login.exchange(f.runnerId, session.id, current).input).toBeNull();
  }
});
