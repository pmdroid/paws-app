import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bindLinearSessionTask,
  bindWorkItemRepository,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  saveTaskMode,
  syncWorkspaceMember,
} from "../src/db";
import {
  createMemberGitHubAccounts,
  createMemberRepositoryAccess,
  issueWorkspaceSession,
} from "../src/workspace";
import { createMemberGitHubClient } from "../src/github";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const signal = () => new AbortController().signal;
function fixture(mode: "code" | "answer" | "artifact" = "code", repositoryContext = true) {
  const root = mkdtempSync(join(tmpdir(), "paws-member-permission-"));
  const db = openDatabase(join(root, "db.sqlite"));
  migrate(db);
  let now = Date.now();
  db.run("INSERT INTO workspace VALUES('w','org','Workspace',?)", [now]);
  for (const id of ["member", "lead"]) {
    putWorkspaceUser(db, {
      id,
      linearUserId: `linear-${id}`,
      name: id,
      email: `${id}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: "w",
      userId: id,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  }
  const item = insertQueuedItem(db, { id: "item", now, sessionKey: "session" });
  recordLinearInstallation(db, {
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    sessionId: "session",
    teamId: "team",
    observedAtMs: now,
  });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "linear-member" });
  db.run("UPDATE linear_session SET issue_id=? WHERE session_id='session'", [item.linearIssueId]);
  bindWorkItemRepository(db, item.id, {
    owner: "acme",
    repo: "repo",
    remoteUrl: "https://github.com/acme/repo.git",
  });
  db.run(
    "INSERT INTO repository_catalog VALUES('acme/repo','acme','repo','https://github.com/acme/repo.git','main',?)",
    [now],
  );
  saveTaskMode(db, item.id, mode, 0, repositoryContext);
  const login = issueWorkspaceSession(db, { workspaceId: "w", userId: "member", now });
  const binding = { workspaceId: "w", userId: "member", sessionHash: login.session.tokenHash };
  let status = 200;
  let permissions: unknown = { pull: true, push: true };
  let account = { id: 123, login: "member-github", type: "User" };
  let beforeIdentity: (() => Promise<void>) | undefined;
  let beforeRepository: (() => Promise<void>) | undefined;
  let beforeMembership: (() => Promise<void>) | undefined;
  let active = true;
  let guest = false;
  let teamIds = ["team"];
  let outage = false;
  const tokens: string[] = [];
  const client = createMemberGitHubClient(async (input, init) => {
    const token = new Headers(init?.headers).get("authorization")!;
    tokens.push(token);
    if (String(input).endsWith("/user")) {
      await beforeIdentity?.();
      return Response.json(account);
    }
    await beforeRepository?.();
    if (outage) throw new Error("private-provider-detail");
    return Response.json({ permissions }, { status });
  });
  const accounts = createMemberGitHubAccounts({
    db,
    client,
    secretsDir: join(root, "secrets"),
    now: () => now,
  });
  const membershipReads: string[] = [];
  const gate = createMemberRepositoryAccess({
    db,
    clientId: "client",
    accounts,
    now: () => now,
    memberships: {
      async member(organizationId, userId) {
        membershipReads.push(userId);
        await beforeMembership?.();
        return { organizationId, userId, active, guest, admin: false, teamIds };
      },
    },
  });
  async function link(expiresAt: number | null = null) {
    await accounts.complete(
      binding,
      accounts.begin(binding),
      { accessToken: "ghu_memberFixture", expiresAt },
      signal(),
    );
  }
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    accounts,
    gate,
    binding,
    item,
    link,
    tokens,
    membershipReads,
    setStatus(value: number) {
      status = value;
    },
    setPermissions(value: unknown) {
      permissions = value;
    },
    setAccount(id: number) {
      account = { id, login: `human-${id}`, type: "User" };
    },
    onIdentity(value: () => Promise<void>) {
      beforeIdentity = value;
    },
    onRepository(value: () => Promise<void>) {
      beforeRepository = value;
    },
    onMembership(value: () => Promise<void>) {
      beforeMembership = value;
    },
    setMembership(value: { active?: boolean; guest?: boolean; teamIds?: string[] }) {
      active = value.active ?? active;
      guest = value.guest ?? guest;
      teamIds = value.teamIds ?? teamIds;
    },
    outage(value: boolean) {
      outage = value;
    },
    advance(ms = 1) {
      now += ms;
      return now;
    },
    now: () => now,
  };
}

test("code checks push for delegated member, not project attribution lead", async () => {
  const f = fixture();
  await f.link();
  const before = getWorkItem(f.db, "item");
  expect(await f.gate.check("item", signal())).toMatchObject({
    state: "ready",
    account: { id: 123, login: "member-github" },
    repository: "acme/repo",
    permission: "push",
  });
  expect(f.membershipReads).toEqual(["linear-member"]);
  expect(getWorkItem(f.db, "item")).toEqual(before);
  expect(f.db.query("SELECT * FROM job").all()).toEqual([]);
});

for (const mode of ["answer", "artifact"] as const)
  test(`repository-backed ${mode} asks for read without push`, async () => {
    const f = fixture(mode);
    await f.link();
    f.setPermissions({ pull: true, push: false });
    expect(await f.gate.check("item", signal())).toMatchObject({
      state: "ready",
      permission: "read",
    });
    f.setPermissions({ pull: false, push: false });
    expect(await f.gate.check("item", signal())).toMatchObject({
      state: "denied",
      permission: "read",
    });
  });

test("Check again preserves checked account and token through denial and transient outage", async () => {
  const f = fixture();
  await f.link();
  f.setPermissions({ pull: true, push: false });
  expect(await f.gate.check("item", signal())).toMatchObject({
    state: "denied",
    account: { id: 123 },
  });
  f.outage(true);
  expect(await f.gate.check("item", signal())).toMatchObject({
    state: "unavailable",
    reason: "provider",
    account: { id: 123 },
  });
  expect(f.accounts.status("w", "member")?.id).toBe(123);
  f.outage(false);
  f.setPermissions({ pull: true, push: true });
  expect((await f.gate.check("item", signal())).state).toBe("ready");
  expect(new Set(f.tokens)).toEqual(new Set(["Bearer ghu_memberFixture"]));
});

for (const status of [401, 403, 404, 429, 500])
  test(`provider status ${status} has a truthful nonterminal state`, async () => {
    const f = fixture();
    await f.link();
    f.setStatus(status);
    const result = await f.gate.check("item", signal());
    expect(result.state).toBe(
      status === 401 ? "missing_link" : status === 404 ? "denied" : "unavailable",
    );
    expect(result.account).toEqual({ id: 123, login: "member-github" });
    expect(getWorkItem(f.db, "item")?.cancelRequested).toBe(false);
    if (status !== 401) expect(f.accounts.status("w", "member")?.id).toBe(123);
  });

test("absent, expired and mismatched account links fail closed", async () => {
  const f = fixture();
  expect((await f.gate.check("item", signal())).state).toBe("missing_link");
  await f.link(f.now() + 10);
  f.advance(11);
  expect((await f.gate.check("item", signal())).state).toBe("missing_link");
  await f.link();
  f.setAccount(999);
  expect((await f.gate.check("item", signal())).state).toBe("missing_link");
});

test("malformed repository permission is unavailable, never denial or success", async () => {
  const f = fixture();
  await f.link();
  f.setPermissions({ push: "true" });
  expect((await f.gate.check("item", signal())).state).toBe("unavailable");
});

for (const fault of [
  "mapping",
  "catalog",
  "team",
  "observer",
  "client",
  "unbound",
  "no-repository-mode",
  "stopped",
  "issue",
  "workspace",
] as const)
  test(`local authority ${fault} refuses provider access`, async () => {
    const f = fixture();
    await f.link();
    const calls = f.tokens.length;
    if (fault === "mapping")
      f.db.run("INSERT INTO workspace_repository VALUES('w','acme/other','team')");
    if (fault === "catalog") f.db.run("DELETE FROM repository_catalog");
    if (fault === "team") f.db.run("DELETE FROM workspace_user_team WHERE user_id='member'");
    if (fault === "observer")
      f.db.run("UPDATE workspace_member SET role='observer' WHERE user_id='member'");
    if (fault === "client") f.db.run("UPDATE linear_session SET oauth_client_id='foreign'");
    if (fault === "unbound") f.db.run("DELETE FROM work_item_repository");
    if (fault === "no-repository-mode")
      f.db.run("UPDATE work_item_task SET mode='answer',repository_context=0");
    if (fault === "stopped") f.db.run("UPDATE linear_session SET stopped_at=1");
    if (fault === "issue") f.db.run("UPDATE linear_session SET issue_id='foreign'");
    if (fault === "workspace") f.db.run("UPDATE workspace SET linear_organization_id='foreign'");
    expect((await f.gate.check("item", signal())).state).not.toBe("ready");
    expect(f.tokens.length).toBe(calls);
  });

for (const phase of ["membership", "identity", "repository"] as const)
  for (const mutation of [
    "version",
    "actor",
    "generation",
    "mapping",
    "mode",
    "unlink",
    "replacement",
    "repository",
    "run",
    "cancel",
    "member",
    "catalog",
  ] as const)
    test(`${mutation} during ${phase} fences old access`, async () => {
      const f = fixture();
      await f.link();
      const mutate = async () => {
        if (mutation === "version") f.db.run("UPDATE work_item SET version=version+1");
        if (mutation === "actor") f.db.run("UPDATE work_item SET owner_user_id='lead'");
        if (mutation === "generation")
          f.db.run("UPDATE linear_session SET generation=generation+1");
        if (mutation === "mapping")
          f.db.run("INSERT INTO workspace_repository VALUES('w','acme/other','team')");
        if (mutation === "mode")
          f.db.run(
            "UPDATE work_item_task SET mode='answer',repository_context=1,generation=generation+1",
          );
        if (mutation === "unlink") f.accounts.unlink(f.binding);
        if (mutation === "replacement") f.accounts.begin(f.binding);
        if (mutation === "repository") f.db.run("UPDATE work_item_repository SET repo='other'");
        if (mutation === "run") f.db.run("UPDATE work_item SET current_run_id='new-run'");
        if (mutation === "cancel") f.db.run("UPDATE work_item SET cancel_requested=1");
        if (mutation === "member")
          f.db.run("UPDATE workspace_member SET active=0 WHERE user_id='member'");
        if (mutation === "catalog") f.db.run("DELETE FROM repository_catalog");
      };
      if (phase === "membership") f.onMembership(mutate);
      if (phase === "identity") f.onIdentity(mutate);
      if (phase === "repository") f.onRepository(mutate);
      expect(await f.gate.check("item", signal())).toMatchObject({
        state: "unavailable",
        reason: "authority_changed",
        account: { id: 123 },
      });
    });

test("fresh membership revocation and outage do not cancel work", async () => {
  const f = fixture();
  await f.link();
  f.setMembership({ active: false });
  f.advance();
  expect(await f.gate.check("item", signal())).toMatchObject({
    state: "denied",
    reason: "membership",
  });
  expect(getWorkItem(f.db, "item")?.state).toBe("queued");
});

test("caller abort propagates while a provider outage remains retryable", async () => {
  const f = fixture();
  await f.link();
  const controller = new AbortController();
  f.onRepository(async () => {
    controller.abort(new Error("fixture-aborted"));
  });
  await expect(f.gate.check("item", controller.signal)).rejects.toThrow("fixture-aborted");
  expect(getWorkItem(f.db, "item")?.cancelRequested).toBe(false);
});

test("membership provider failures and lost team scope refuse access without deleting the member link", async () => {
  const f = fixture();
  await f.link();
  f.onMembership(async () => {
    throw new Error("fixture-linear-outage");
  });
  expect(await f.gate.check("item", signal())).toMatchObject({
    state: "unavailable",
    reason: "provider",
  });
  expect(f.accounts.status("w", "member")?.id).toBe(123);
  f.onMembership(async () => {});
  f.setMembership({ teamIds: [] });
  f.advance();
  expect((await f.gate.check("item", signal())).state).not.toBe("ready");
  expect(getWorkItem(f.db, "item")?.cancelRequested).toBe(false);
});

test("explicit team mapping keeps its existing policy even without a catalog fallback", async () => {
  const f = fixture();
  await f.link();
  f.db.run("INSERT INTO workspace_repository VALUES('w','acme/repo','team')");
  f.db.run("DELETE FROM repository_catalog");
  expect((await f.gate.check("item", signal())).state).toBe("ready");
});

test("expiry during provider read becomes missing_link and preserves checked account context", async () => {
  const f = fixture();
  await f.link(f.now() + 10);
  f.onRepository(async () => {
    f.advance(11);
  });
  expect(await f.gate.check("item", signal())).toMatchObject({
    state: "missing_link",
    account: { id: 123 },
  });
});
