import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteWorkspaceSession,
  memberGitHubRecord,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { createMemberGitHubAccounts, issueWorkspaceSession } from "../src/workspace";
import { createFakeMemberGitHubClient, createMemberGitHubClient } from "../src/github";
import { readSecretFile, writeSecretFile } from "../src/credentials";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const signal = () => new AbortController().signal;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-member-github-"));
  const path = join(root, "db.sqlite");
  const secretsDir = join(root, "secrets");
  const db = openDatabase(path);
  migrate(db);
  let now = Date.now();
  const client = createFakeMemberGitHubClient();
  const accounts = createMemberGitHubAccounts({ db, secretsDir, client, now: () => now });
  for (const id of ["w", "other"])
    db.run("INSERT INTO workspace VALUES(?,?,?,?)", [id, id, id, now]);
  for (const userId of ["alice", "bob"]) {
    putWorkspaceUser(db, {
      id: userId,
      linearUserId: userId,
      name: userId,
      email: `${userId}@example.invalid`,
    });
    for (const workspaceId of ["w", "other"])
      syncWorkspaceMember(db, {
        workspaceId,
        userId,
        active: true,
        role: "member",
        teamIds: [],
        now,
      });
  }
  const binding = (userId = "alice", workspaceId = "w") => {
    const session = issueWorkspaceSession(db, { workspaceId, userId, now });
    return { workspaceId, userId, sessionHash: session.session.tokenHash };
  };
  const alice = binding();
  const bob = binding("bob");
  async function link(
    who = alice,
    id = 123,
    token = "fixture-member-token",
    expiresAt: number | null = null,
  ) {
    client.account = { id, login: `human-${id}` };
    return accounts.complete(who, accounts.begin(who), { accessToken: token, expiresAt }, signal());
  }
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    path,
    db,
    secretsDir,
    client,
    accounts,
    alice,
    bob,
    binding,
    link,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

test("members and workspaces persist independent encrypted links without operator or attribution changes", async () => {
  const f = fixture();
  writeSecretFile(join(f.secretsDir, "github-oauth"), "fixture-operator-token");
  f.db.run(
    "INSERT INTO verified_github_attribution(workspace_id,user_id,revision,github_id,login,name,consented_at) VALUES('w','alice',1,900,'attribution','Attribution',?)",
    [f.now()],
  );
  await f.link();
  await f.link(f.bob, 456, "fixture-bob-token");
  const other = f.binding("alice", "other");
  await f.link(other, 789, "fixture-other-token");
  expect(f.accounts.status("w", "alice")?.id).toBe(123);
  expect(f.accounts.status("w", "bob")?.id).toBe(456);
  expect(f.accounts.status("other", "alice")?.id).toBe(789);
  for (const name of readdirSync(f.secretsDir)) {
    expect(statSync(join(f.secretsDir, name)).mode & 0o777).toBe(0o600);
    expect(
      readFileSync(join(f.secretsDir, name)).includes(Buffer.from("fixture-member-token")),
    ).toBe(false);
  }
  expect(statSync(f.secretsDir).mode & 0o777).toBe(0o700);
  const reopened = openDatabase(f.path);
  expect(memberGitHubRecord(reopened, "w", "bob")?.githubId).toBe(456);
  expect(JSON.stringify(reopened.query("SELECT * FROM member_github_account").all())).not.toContain(
    "token",
  );
  reopened.close();
  await f.link(f.alice, 321, "fixture-replacement-token");
  f.accounts.unlink(f.alice);
  expect(f.accounts.status("w", "alice")).toBeNull();
  expect(f.accounts.status("w", "bob")?.id).toBe(456);
  expect(f.accounts.status("other", "alice")?.id).toBe(789);
  expect(readSecretFile(join(f.secretsDir, "github-oauth"))).toBe("fixture-operator-token");
  expect(f.db.query("SELECT github_id FROM verified_github_attribution").get()).toEqual({
    github_id: 900,
  });
  expect(
    f.db
      .query("SELECT active FROM workspace_member WHERE workspace_id='w' AND user_id='alice'")
      .get(),
  ).toEqual({ active: 1 });
  expect(readdirSync(f.secretsDir).filter((name) => name.startsWith("member-github-")).length).toBe(
    2,
  );
});

test("session binding, replacement revision and unlink fence delayed sign-ins", async () => {
  const f = fixture();
  const revision = f.accounts.begin(f.alice);
  await expect(
    f.accounts.complete(
      { ...f.alice, userId: "bob" },
      revision,
      { accessToken: "fixture-secret", expiresAt: null },
      signal(),
    ),
  ).rejects.toThrow("GitHub connection failed");
  await expect(
    f.accounts.complete(
      f.bob,
      revision,
      { accessToken: "fixture-secret", expiresAt: null },
      signal(),
    ),
  ).rejects.toThrow("GitHub connection failed");
  expect(() => f.accounts.unlink({ ...f.alice, userId: "bob" })).toThrow();
  await f.link();
  await expect(
    f.accounts.complete(
      f.alice,
      revision,
      { accessToken: "fixture-secret", expiresAt: null },
      signal(),
    ),
  ).rejects.toThrow();
  const pending = f.accounts.begin(f.alice);
  f.accounts.unlink(f.alice);
  await expect(
    f.accounts.complete(
      f.alice,
      pending,
      { accessToken: "fixture-secret", expiresAt: null },
      signal(),
    ),
  ).rejects.toThrow();
  const loggedOut = f.accounts.begin(f.alice);
  deleteWorkspaceSession(f.db, f.alice.sessionHash);
  await expect(
    f.accounts.complete(
      f.alice,
      loggedOut,
      { accessToken: "fixture-secret", expiresAt: null },
      signal(),
    ),
  ).rejects.toThrow();
  expect(readdirSync(f.secretsDir).filter((name) => name.startsWith("member-github-"))).toEqual([]);
});

test("repository checks hide credentials, ask read or push and fail closed on provider errors", async () => {
  const f = fixture();
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "read", signal())).toBe(
    false,
  );
  await f.link();
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "read", signal())).toBe(true);
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "push", signal())).toBe(true);
  expect(f.client.calls.at(-1)).toEqual({
    operation: "repository",
    repository: "owner/repo",
    permission: "push",
  });
  expect(JSON.stringify(f.client.calls)).not.toContain("token");
  f.client.allowed = false;
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "read", signal())).toBe(
    false,
  );
  f.client.repository = async () => {
    throw new Error("fixture-member-token");
  };
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "read", signal())).toBe(
    false,
  );
  f.client.unauthorized = true;
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "read", signal())).toBe(
    false,
  );
  f.client.unauthorized = false;
  expect(f.accounts.status("w", "alice")).toBeNull();
});

test("expiry and membership revocation stay closed after restoration until reconnection", async () => {
  const f = fixture();
  await f.link(f.alice, 123, "fixture-expiring", f.now() + 100);
  f.advance(101);
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "read", signal())).toBe(
    false,
  );
  await f.link();
  syncWorkspaceMember(f.db, {
    ...f.alice,
    active: false,
    role: "member",
    teamIds: [],
    now: f.advance(1),
  });
  expect(f.accounts.status("w", "alice")).toBeNull();
  syncWorkspaceMember(f.db, {
    ...f.alice,
    active: true,
    role: "member",
    teamIds: [],
    now: f.advance(1),
  });
  expect(f.accounts.status("w", "alice")).toBeNull();
  const restored = f.binding();
  await f.link(restored);
  syncWorkspaceMember(f.db, {
    ...f.alice,
    active: true,
    role: "observer",
    teamIds: [],
    now: f.advance(1),
  });
  expect(f.accounts.status("w", "alice")).toBeNull();
  expect(() => f.accounts.begin(restored)).toThrow();
});

test("unlink, membership loss, replacement and cancellation during provider reads refuse stale admission", async () => {
  for (const change of ["unlink", "membership", "replace", "cancel"] as const) {
    const f = fixture();
    await f.link();
    const controller = new AbortController();
    f.client.repository = async () => {
      if (change === "unlink") f.accounts.unlink(f.alice);
      if (change === "replace") await f.link(f.alice, 456);
      if (change === "membership")
        syncWorkspaceMember(f.db, {
          ...f.alice,
          active: false,
          role: "member",
          teamIds: [],
          now: f.advance(1),
        });
      if (change === "cancel") controller.abort();
      return true;
    };
    expect(
      await f.accounts.checkRepository("w", "alice", "owner/repo", "read", controller.signal),
    ).toBe(false);
  }
});

test("missing, corrupt or mismatched member secrets never grant repository access", async () => {
  const f = fixture();
  await f.link();
  f.client.account = { id: 999, login: "unexpected" };
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "read", signal())).toBe(
    false,
  );
  await f.link();
  const secret = readdirSync(f.secretsDir).find((name) => name.startsWith("member-github-"))!;
  writeFileSync(join(f.secretsDir, secret), "paws-envelope-v1\ncorrupt");
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "read", signal())).toBe(
    false,
  );
  rmSync(join(f.secretsDir, secret));
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "read", signal())).toBe(
    false,
  );
});

test("real GitHub adapter checks user permissions rather than installation authority", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  let status = 200;
  let body: unknown = { permissions: { pull: true, push: false } };
  const client = createMemberGitHubClient(async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json(body, { status });
  });
  expect(await client.repository("fixture-user-token", "owner/repo", "read", signal())).toBe(true);
  expect(await client.repository("fixture-user-token", "owner/repo", "push", signal())).toBe(false);
  body = { private: true, permissions: { pull: false, push: false } };
  expect(await client.repository("fixture-user-token", "owner/repo", "read", signal())).toBe(false);
  for (const incomplete of [{}, { permissions: {} }, { permissions: { pull: "true" } }]) {
    body = incomplete;
    await expect(
      client.repository("fixture-user-token", "owner/repo", "read", signal()),
    ).rejects.toThrow("incomplete");
  }
  body = { permissions: { push: true } };
  expect(await client.repository("fixture-user-token", "owner/repo", "push", signal())).toBe(true);
  body = {};
  await expect(
    client.repository("fixture-user-token", "owner/repo", "push", signal()),
  ).rejects.toThrow("incomplete");
  for (const failure of [401, 403, 404, 500]) {
    status = failure;
    if (failure === 404)
      expect(await client.repository("fixture-user-token", "owner/repo", "read", signal())).toBe(
        false,
      );
    else
      await expect(
        client.repository("fixture-user-token", "owner/repo", "read", signal()),
      ).rejects.toThrow();
  }
  status = 200;
  body = { id: 123, login: "human", type: "User" };
  expect(await client.identity("fixture-user-token", signal())).toEqual({
    id: 123,
    login: "human",
  });
  body = { id: 123, login: "bot", type: "Bot" };
  await expect(client.identity("fixture-user-token", signal())).rejects.toThrow();
  expect(requests[0]?.url).toBe("https://api.github.com/repos/owner/repo");
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
    "Bearer fixture-user-token",
  );
  expect(requests.every((request) => request.init?.redirect === "error")).toBe(true);
});

test("membership or session loss while GitHub identity is pending cannot publish a link", async () => {
  for (const change of ["membership", "session", "newer"] as const) {
    const f = fixture();
    const revision = f.accounts.begin(f.alice);
    f.client.identity = async () => {
      if (change === "membership")
        syncWorkspaceMember(f.db, {
          ...f.alice,
          active: false,
          role: "member",
          teamIds: [],
          now: f.advance(1),
        });
      if (change === "session") deleteWorkspaceSession(f.db, f.alice.sessionHash);
      if (change === "newer") f.accounts.begin(f.alice);
      return { id: 123, login: "human" };
    };
    await expect(
      f.accounts.complete(
        f.alice,
        revision,
        { accessToken: "fixture-hidden-token", expiresAt: null },
        signal(),
      ),
    ).rejects.toThrow("GitHub connection failed. Start sign-in again.");
    expect(f.accounts.status("w", "alice")).toBeNull();
    expect(readdirSync(f.secretsDir).filter((name) => name.startsWith("member-github-"))).toEqual(
      [],
    );
  }
});

test("existing live sessions can link, check and unlink without recent reauthentication", async () => {
  const f = fixture();
  f.advance(24 * 60 * 60_000);
  await f.link();
  expect(f.accounts.status("w", "alice")?.id).toBe(123);
  expect(await f.accounts.checkRepository("w", "alice", "owner/repo", "push", signal())).toBe(true);
  f.accounts.unlink(f.alice);
  expect(f.accounts.status("w", "alice")).toBeNull();
});
