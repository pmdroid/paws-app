import { systemClock } from "../src/core";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JobLoop,
  ensureLinearSession,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { createFakeMemberGitHubClient } from "../src/github";
import {
  createMemberGitHubAccounts,
  createMemberRepositoryAccess,
  createOnboardingPreparation,
  createOnboardingReadiness,
  createWorkspaceAssignments,
  issueWorkspaceSession,
  type OnboardingReadinessContext,
} from "../src/workspace";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const context: OnboardingReadinessContext = {
  sessionId: "session",
  generation: 0,
  workspaceId: "w",
  linearUserId: "member",
};
const signal = () => new AbortController().signal;
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-readiness-"));
  const db = openDatabase(join(root, "db.sqlite"));
  migrate(db);
  let now = Date.now();
  db.run("INSERT INTO workspace VALUES('w','org','Workspace',?)", [now]);
  putWorkspaceUser(db, {
    id: "member",
    linearUserId: "member",
    name: "Member",
    email: "member@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: "w",
    userId: "member",
    role: "member",
    active: true,
    teamIds: ["team"],
    now,
  });
  const spec = {
    linearIssueId: "issue",
    identifier: "TEST-1",
    title: "Work",
    description: "Original criteria",
    subIssues: [],
  };
  ensureLinearSession(db, { sessionId: "session", issueId: "issue", creatorId: "member" });
  const installation = {
    sessionId: "session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: now,
  };
  recordLinearInstallation(db, installation);
  db.run(
    "INSERT INTO workspace_assignment VALUES('session',0,'w','member','hash',?,'{}',?,'ready')",
    [JSON.stringify({ installation, spec }), now + 600000],
  );
  db.run(
    "INSERT INTO repository_catalog VALUES('acme/repo','acme','repo','https://github.com/acme/repo.git','main',?)",
    [now],
  );
  let onMember: (() => Promise<void>) | undefined;
  const memberships = {
    async installation() {
      return { id: "org", name: "Workspace" };
    },
    async member(organizationId: string, userId: string) {
      await onMember?.();
      return {
        organizationId,
        userId,
        active: true,
        guest: false,
        admin: false,
        teamIds: ["team"],
      };
    },
  };
  const tracker = createFakeTracker([spec]);
  const assignments = createWorkspaceAssignments({
    db,
    origin: "https://paws.example.invalid",
    clientId: "client",
    memberships,
    tracker,
    onboarding: {},
    lifecycle: {
      async inspect() {
        throw new Error();
      },
      async startCodeIssue() {
        throw new Error();
      },
    },
    async accept() {
      return true;
    },
    async continue() {
      throw new Error("No continuation");
    },
    now: () => now,
  });
  const preparation = createOnboardingPreparation({
    db,
    clientId: "client",
    repositories: tracker,
    now: () => now,
  });
  const login = issueWorkspaceSession(db, { workspaceId: "w", userId: "member", now });
  const binding = { workspaceId: "w", userId: "member", sessionHash: login.session.tokenHash };
  const first = await preparation.refresh(context, signal());
  preparation.answer(context, binding, { revision: first.revision, mode: "code" });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES('runner','w','member','Runner','active',?)",
    [now],
  );
  db.run(
    "INSERT INTO runner_certificate(fingerprint,serial,runner_id,pem,not_before,not_after,accepted_until) VALUES('cert','cert','runner','fixture',?,?,?)",
    [now - 1, now + 600000, now + 600000],
  );
  const github = createFakeMemberGitHubClient();
  const accounts = createMemberGitHubAccounts({
    db,
    secretsDir: join(root, "secrets"),
    client: github,
    now: () => now,
  });
  await accounts.complete(
    binding,
    accounts.begin(binding),
    { accessToken: "ghu_fixture", expiresAt: now + 300000 },
    signal(),
  );
  const access = createMemberRepositoryAccess({
    db,
    clientId: "client",
    memberships,
    accounts,
    now: () => now,
  });
  const connected = new Map([
    ["claude", true],
    ["codex", true],
  ]);
  const agents = {
    login: {
      list: () => ({
        accounts: (["claude", "codex"] as const).map((agent) => ({
          agent,
          connected: connected.get(agent)!,
          updatedAt: 1,
          session: null,
        })),
      }),
    },
    health: {
      agents: () =>
        (["claude", "codex"] as const).map((agent) => ({
          agent,
          status: "signed_in" as const,
          checkedAt: 1,
        })),
    },
  } as unknown as Parameters<typeof createOnboardingReadiness>[0]["agents"];
  const build = () =>
    createOnboardingReadiness({ db, assignments, preparation, access, agents, now: () => now });
  const readiness = build();
  cleanups.push(() => {
    db.close();
    rmSync(root, { force: true, recursive: true });
  });
  return {
    db,
    memberships,
    spec,
    assignments,
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    readiness,
    build,
    accounts,
    binding,
    github,
    connected,
    preparation,
    onMember(action: () => Promise<void>) {
      onMember = action;
    },
  };
}

test("joint readiness binds existing expiry, survives no restart reuse and creates no execution", async () => {
  const f = await fixture();
  expect(await f.readiness.refresh(context, signal())).toMatchObject({
    state: "ready",
    expiresAt: f.now() + 300000,
  });
  expect(f.readiness.readyToContinue(context)).toBe(true);
  expect(f.build().read(context)).toBeNull();
  expect(f.db.query("SELECT * FROM work_item").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM job").all()).toEqual([]);
  f.advance(300001);
  expect(f.readiness.readyToContinue(context)).toBe(false);
});
for (const dependency of ["metadata", "vm", "claude", "codex", "github"] as const)
  test(`missing ${dependency} never authorizes continuation`, async () => {
    const f = await fixture();
    if (dependency === "metadata") f.db.run("DELETE FROM onboarding_preparation");
    if (dependency === "vm") f.db.run("UPDATE runner SET status='paused'");
    if (dependency === "claude" || dependency === "codex") f.connected.set(dependency, false);
    if (dependency === "github") f.accounts.unlink(f.binding);
    expect((await f.readiness.refresh(context, signal())).state).not.toBe("ready");
    expect(f.readiness.readyToContinue(context)).toBe(false);
    expect(f.db.query("SELECT * FROM work_item").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM job").all()).toEqual([]);
  });
for (const phase of ["membership", "identity", "repository"] as const)
  test(`CAS rejects VM changes during ${phase}`, async () => {
    const f = await fixture();
    const change = async () => {
      f.db.run("UPDATE runner SET fence=fence+1");
    };
    if (phase === "membership") f.onMember(change);
    if (phase === "identity")
      f.github.identity = async () => {
        await change();
        return f.github.account;
      };
    if (phase === "repository")
      f.github.repository = async () => {
        await change();
        return true;
      };
    expect((await f.readiness.refresh(context, signal())).state).toBe("unavailable");
    expect(f.readiness.readyToContinue(context)).toBe(false);
  });
test("newer refresh fences older response and outage invalidates prior ready without cancelling", async () => {
  const f = await fixture();
  await f.readiness.refresh(context, signal());
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.onMember(async () => {
    entered();
    await held;
  });
  const earlier = f.readiness.refresh(context, signal());
  await started;
  expect(f.readiness.readyToContinue(context)).toBe(false);
  f.onMember(async () => {});
  const latest = await f.readiness.refresh(context, signal());
  release();
  expect((await earlier).state).toBe("unavailable");
  expect(f.readiness.read(context)?.revision).toBe(latest.revision);
  f.github.repository = async () => {
    throw new Error("provider outage");
  };
  expect((await f.readiness.refresh(context, signal())).state).toBe("unavailable");
  expect(f.readiness.readyToContinue(context)).toBe(false);
  f.github.repository = async () => true;
  expect((await f.readiness.refresh(context, signal())).state).toBe("ready");
});

test("an unavailable authoritative membership observation cannot reuse a prior ready result", async () => {
  const f = await fixture();
  await f.readiness.refresh(context, signal());
  f.onMember(async () => {
    throw new Error("membership outage");
  });
  expect((await f.readiness.refresh(context, signal())).state).toBe("unavailable");
  expect(f.readiness.readyToContinue(context)).toBe(false);
});

for (const known of [true, false])
  test(`${known ? "known" : "new"} member remains held by incomplete joint readiness`, async () => {
    const f = await fixture();
    f.db.run("DELETE FROM onboarding_preparation");
    f.db.run("DELETE FROM workspace_assignment");
    if (!known) f.db.run("DELETE FROM workspace_session");
    if (!known) f.db.run("UPDATE workspace_user SET linear_user_id='old-member' WHERE id='member'");
    let continued = 0;
    const tracker = createFakeTracker([f.spec]);
    tracker.getSession = async () =>
      ({
        id: "session",
        status: "active",
        createdAt: "",
        updatedAt: "",
        endedAt: null,
        dismissedAt: null,
        appUserId: "app",
        creatorId: "member",
        issue: { id: "issue" },
        comment: null,
        sourceComment: null,
        summary: null,
        plan: null,
        context: null,
        externalLinks: [],
        pullRequest: null,
      }) as never;
    const assignments = createWorkspaceAssignments({
      db: f.db,
      origin: "https://paws.example.invalid",
      clientId: "client",
      memberships: f.memberships,
      tracker,
      onboarding: { refresh: async () => {}, readyToContinue: () => false },
      lifecycle: {
        async inspect() {
          return {
            id: "issue",
            teamId: "team",
            assigneeId: "member",
            delegateId: "app",
            stateType: "started",
          };
        },
        async startCodeIssue() {
          throw new Error();
        },
      },
      accept: async () => true,
      continue: async () => {
        continued++;
      },
      now: f.now,
    });
    const event = {
      sessionId: "session",
      issueId: "issue",
      action: "created",
      signal: null,
      payload: "{}",
      dedupeKey: "fixture",
      deliveryId: null,
      source: "webhook",
      activityId: null,
      body: null,
      updatedAtMs: f.now(),
    } as Parameters<typeof assignments.authorize>[0];
    expect(await assignments.authorize(event)).toBe(false);
    const hold = f.db
      .query<{ status: string }, []>("SELECT status FROM workspace_assignment")
      .get();
    expect(hold?.status).toBe(known ? "ready" : "pending");
    if (!known) f.db.run("UPDATE workspace_assignment SET status='ready'");
    const jobs = new JobLoop(f.db, systemClock);
    assignments.register(jobs);
    await jobs.tick();
    expect(continued).toBe(0);
    expect(f.db.query("SELECT * FROM work_item").all()).toEqual([]);
  });
