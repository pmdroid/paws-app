import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeWorkspaceRevocation,
  WORKSPACE_REVOKED_RESPONSE,
  WORKSPACE_REVOKED_SIGN_IN,
  advanceLinearSessionGeneration,
  claimNextJob,
  completeJob,
  consumeWorkspaceBootstrap,
  ensureLinearSession,
  getLinearSession,
  JobLoop,
  OutboxDispatcher,
  listWorkItems,
  listJobs,
  listOutbox,
  listPendingLinearTurns,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
  workspaceLinearMember,
} from "../src/db";
import { readyItems, syncItemDependencies } from "../src/intake";
import { attachOrchestrator, deliverLinearOutbox } from "../src/loop";
import { FakeClock } from "../src/core";
import {
  acknowledgeNewSession,
  createFakeTracker,
  LinearIntakePendingError,
  type AcceptedLinearEvent,
  type LinearSessionSnapshot,
} from "../src/linear";
import {
  createWorkspaceAccess,
  createWorkspaceAssignments,
  delegatorCommitCredit,
  issueWorkspaceBootstrap,
  ONBOARDING_EXPIRED_BODY,
  ONBOARDING_HOLD_MS,
  WORKSPACE_COOKIE,
  workspaceTokenHash,
} from "../src/workspace";
import { createOnboardingReadiness } from "../src/onboarding-readiness";

type AgentFixture = {
  repository: { owner: string; repo: string; remoteUrl: string };
  launch: (input: { purpose: string; role: string }) => {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  };
};

function fixture({
  installed = true,
  projectLeadId,
  createVm,
  agent,
}: {
  installed?: boolean;
  projectLeadId?: string;
  createVm?: boolean;
  agent?: AgentFixture;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-assignment-"));
  let db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const clock = new FakeClock(Date.now());
  const origin = "https://paws.example.invalid";
  const ownerId = putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const bootstrap = issueWorkspaceBootstrap(db, "org", clock.now());
  consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    tokenHash: workspaceTokenHash(bootstrap),
    userId: ownerId,
    now: clock.now(),
  });
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "TEST-1",
      title: "Work",
      description: "Original criteria",
      ...(projectLeadId === undefined ? {} : { projectId: "project", projectLeadId }),
      subIssues: [],
    },
  ]);
  const session: LinearSessionSnapshot = {
    id: "session",
    status: "active",
    createdAt: new Date(clock.now()).toISOString(),
    updatedAt: new Date(clock.now()).toISOString(),
    endedAt: null,
    dismissedAt: null,
    appUserId: "app",
    creatorId: "member",
    issue: { id: "issue", identifier: "TEST-1", title: "Work", description: "Original criteria" },
    comment: null,
    sourceComment: null,
    summary: null,
    plan: null,
    context: null,
    externalLinks: [],
    pullRequest: null,
  };
  const ownership = {
    id: "issue",
    url: "https://linear.app/acme/issue/TEST-1",
    teamId: "team",
    teamName: "Platform",
    assigneeId: "member",
    delegateId: "app" as string | null,
    stateType: "started",
  };
  let active = true;
  let guest = false;
  let teams = ["team"];
  let failContinue = false;
  let changeAtIntake: (() => void) | undefined;
  let calls = 0;
  let linearRequests = 0;
  const logs: string[] = [];
  let memberRead: (() => Promise<void>) | undefined;
  const githubCalls: string[] = [];
  const memberships = {
    async installation() {
      return { id: "org", name: "Workspace" };
    },
    async member(organizationId: string, userId: string) {
      linearRequests++;
      await memberRead?.();
      return { organizationId, userId, active, guest, admin: false, teamIds: teams };
    },
  };
  const event: AcceptedLinearEvent = {
    dedupeKey: "session:session:created",
    deliveryId: "delivery",
    source: "webhook",
    action: "created",
    sessionId: "session",
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: clock.now(),
    payload: JSON.stringify({
      organizationId: "org",
      appUserId: "app",
      agentSession: {
        creatorId: "member",
        creator: { id: "member", name: "Morgan Member" },
      },
    }),
  };
  ensureLinearSession(db, { sessionId: "session", issueId: "issue" });
  const install = () =>
    recordLinearInstallation(db, {
      sessionId: "session",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      observedAtMs: clock.now(),
    });
  if (installed) install();
  let failedSessionReads = 0;
  let sessionReads = 0;
  let issueReads = 0;
  let epicReads = 0;
  const continuations: string[] = [];
  const build = () =>
    createWorkspaceAssignments({
      db,
      origin,
      clientId: "client",
      memberships,
      now: () => clock.now(),
      lifecycle: {
        async inspect() {
          issueReads++;
          return structuredClone(ownership);
        },
        async startCodeIssue() {
          throw new Error("No credentials or execution before continuation");
        },
      },
      tracker: {
        ...tracker,
        async loadEpic(id) {
          epicReads++;
          return tracker.loadEpic(id);
        },
        async getSession() {
          sessionReads++;
          if (failedSessionReads > 0) {
            failedSessionReads--;
            throw new Error("Linear HTTP 503");
          }
          return structuredClone(session);
        },
      },
      async accept() {
        return true;
      },
      async continue(value) {
        calls++;
        expect(await currentAccess.authorizeLinearEvent(value)).toBe(true);
        expect(await assignments.authorize(value)).toEqual({ outcome: "accepted" });
        if (failContinue) {
          failContinue = false;
          throw new Error("Interrupted before canonical intake");
        }
        await orchestrator.onLinearEvent(value);
        const delegationId = getLinearSession(db, "session")!.delegationId!;
        const itemIds = db
          .query<{ id: string }, [string]>(
            "SELECT id FROM work_item WHERE delegation_id=? ORDER BY position,id",
          )
          .all(delegationId);
        for (const item of itemIds)
          await syncItemDependencies(db, {
            itemId: item.id,
            workspaceId: "workspace",
            expectedGeneration: readyItems(db, { itemId: item.id, workspaceId: "workspace" })
              .generation,
            tracker,
            lifecycle: {
              async inspect() {
                return structuredClone(ownership);
              },
            },
          });
        orchestrator.reconcileExecution();
        if (!continuations.includes(value.dedupeKey)) continuations.push(value.dedupeKey);
      },
    });
  let assignments = build();
  let orchestratorJobs = new JobLoop(db, clock);
  let orchestrator = buildOrchestrator();
  function buildOrchestrator() {
    orchestratorJobs = new JobLoop(db, clock);
    return attachOrchestrator({
      db,
      jobs: orchestratorJobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: root,
      tracker: {
        ...tracker,
        async loadEpic(id) {
          changeAtIntake?.();
          changeAtIntake = undefined;
          return tracker.loadEpic(id);
        },
      },
      clock,
      authorizeLinearEvent: async (incoming) =>
        (await currentAccess.authorizeLinearEvent(incoming))
          ? await assignments.authorize(incoming)
          : { outcome: "refused", reason: "denied" },
      authorizeLinearIntake: (sessionId, spec) => assignments.authorizeIntake(sessionId, spec),
      ...(agent
        ? { repositories: [agent.repository], launch: agent.launch }
        : {
            launch: () => {
              throw new Error("No agent may start in the onboarding fixture");
            },
          }),
    });
  }
  const access = () =>
    createWorkspaceAccess({
      db,
      assignments,
      publicUrl: origin,
      clientId: "client",
      installedOrganization: { id: "org", name: "Workspace" },
      memberships,
      onboardingReadiness: createOnboardingReadiness(db),
      ...(createVm === undefined ? {} : { createVmAvailable: async () => createVm }),
      githubAttributionClient: { clientId: "github-client", clientSecret: "github-secret" },
      now: () => clock.now(),
      log: (line) => logs.push(line),
      fetch: (async (input, init) => {
        // A fake GitHub OAuth: Paws never reaches github.com in tests.
        if (String(input) === "https://github.com/login/oauth/access_token") {
          githubCalls.push("token");
          return Response.json({ access_token: "ghu_onboardingFixture", scope: "" });
        }
        if (String(input) === "https://api.github.com/user") {
          githubCalls.push("user");
          return Response.json({ id: 4242, login: "morgan-gh", type: "User", name: "Morgan" });
        }
        linearRequests++;
        if (String(input).endsWith("/oauth/token")) {
          const code = new URLSearchParams(String(init?.body)).get("code");
          return Response.json({ access_token: `fixture-${code}` });
        }
        const user = new Headers(init?.headers)
          .get("authorization")!
          .replace("Bearer fixture-", "");
        return Response.json({
          data: {
            viewer: {
              id: user,
              name: user,
              email: `${user}@example.invalid`,
              app: false,
              organization: { id: user === "outsider" ? "other" : "org", name: "Workspace" },
            },
          },
        });
      }) as typeof fetch,
    });
  let currentAccess = access();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, current): Promise<Response> {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("host", new URL(origin).host);
      return (
        (await currentAccess.handle(
          new Request(`${origin}${url.pathname}${url.search}`, {
            headers,
            method: request.method,
            ...(["GET", "HEAD"].includes(request.method)
              ? {}
              : { body: await request.arrayBuffer() }),
          }),
          { ip: request.headers.get("x-test-ip") ?? current.requestIP(request)?.address },
        )) ?? new Response(null, { status: 404 })
      );
    },
  });
  const local = `http://127.0.0.1:${server.port}`;
  function link() {
    const row = listOutbox(db).at(-1)!;
    const payload = row.payload as { auth: { url: string; userId: string } };
    expect(payload.auth.userId).toBe("member");
    return payload.auth.url;
  }
  async function begin(url = link(), headers: Record<string, string> = {}) {
    const target = new URL(url);
    return fetch(`${local}${target.pathname}${target.search}`, { redirect: "manual", headers });
  }
  async function callback(start: Response, user = "member", headers: Record<string, string> = {}) {
    const provider = new URL(start.headers.get("location")!);
    const url = `${local}/auth/linear/callback?state=${provider.searchParams.get("state")}&code=${user}`;
    return fetch(url, {
      redirect: "manual",
      headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]!, ...headers },
    });
  }
  const delivered = new Set<number>();
  /** Sends every queued Linear write to the fake tracker, as the outbox would. */
  async function deliver() {
    for (const row of listOutbox(db))
      if (!delivered.has(row.id)) {
        delivered.add(row.id);
        await deliverLinearOutbox(row, tracker, async () => {}, undefined, db);
      }
  }
  function jobs() {
    const loop = new JobLoop(db, clock);
    assignments.register(loop);
    return loop;
  }
  return {
    event,
    tracker,
    session,
    ownership,
    clock,
    continuations,
    githubCalls,
    origin,
    begin,
    callback,
    deliver,
    local,
    link,
    jobs,
    get db() {
      return db;
    },
    install,
    failSessionRead() {
      failedSessionReads++;
    },
    get orchestrator() {
      return orchestrator;
    },
    get orchestratorJobs() {
      return orchestratorJobs;
    },
    get assignments() {
      return assignments;
    },
    get calls() {
      return calls;
    },
    get linearRequests() {
      return linearRequests;
    },
    logs,
    get sessionReads() {
      return sessionReads;
    },
    /** Linear reads made by the assignment decisions themselves, not by intake. */
    get decisionReads() {
      return { session: sessionReads, issue: issueReads, epic: epicReads };
    },
    setActive(value: boolean) {
      active = value;
    },
    setGuest(value: boolean) {
      guest = value;
    },
    setTeams(value: string[]) {
      teams = value;
    },
    failContinue() {
      failContinue = true;
    },
    onMemberRead(fn: () => Promise<void>) {
      memberRead = fn;
    },
    changeAtIntake(fn: () => void) {
      changeAtIntake = fn;
    },
    async restart() {
      await currentAccess.stop();
      await orchestrator.shutdown();
      db.close();
      db = openDatabase(join(root, "paws.sqlite"));
      migrate(db);
      assignments = build();
      orchestrator = buildOrchestrator();
      currentAccess = access();
    },
    async close() {
      server.stop(true);
      await currentAccess.stop();
      await orchestrator.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("first assignment holds without manufacturing membership and resumes once after browser OAuth and restart", async () => {
  const f = fixture();
  try {
    expect(await f.assignments.authorize(f.event)).toMatchObject({ outcome: "refused" });
    expect(await f.assignments.authorize({ ...f.event, deliveryId: "duplicate" })).toMatchObject({
      outcome: "refused",
    });
    expect(listOutbox(f.db)).toHaveLength(1);
    expect(
      f.db.query("SELECT 1 FROM workspace_user WHERE linear_user_id='member'").get(),
    ).toBeNull();
    expect(f.calls).toBe(0);
    const start = await f.begin();
    expect(start.status).toBe(303);
    expect(new URL(start.headers.get("location")!).searchParams.get("actor")).toBe("user");
    await f.restart();
    expect((await f.callback(start)).status).toBe(303);
    expect((await f.callback(start)).status).toBe(400);
    expect(listJobs(f.db).filter((job) => job.queue === "workspace.assignment")).toHaveLength(1);
    await f.restart();
    const jobs = f.jobs();
    await jobs.tick();
    await jobs.tick();
    expect(f.calls).toBe(1);
    expect(listWorkItems(f.db)).toHaveLength(1);
    expect(listJobs(f.db).filter((job) => job.queue === "item.start")).toHaveLength(1);
    expect(f.continuations).toEqual([f.event.dedupeKey]);
    expect(await f.assignments.authorize(f.event)).toMatchObject({ outcome: "refused" });
    expect(
      f.db
        .query("SELECT action FROM workspace_access_audit WHERE action='assignment.resumed'")
        .all(),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const identity of ["wrong", "outsider"])
  test(`assignment OAuth rejects ${identity} identity`, async () => {
    const f = fixture();
    try {
      await f.assignments.authorize(f.event);
      const start = await f.begin();
      const refused = await f.callback(start, identity);
      expect(refused.status).toBe(403);
      if (identity === "wrong")
        expect(await refused.text()).toContain("This link belongs to Morgan Member.");
      expect(refused.headers.get("location")).toBeNull();
      expect(listJobs(f.db)).toHaveLength(0);
      expect(
        f.db.query("SELECT status,completed_at AS completedAt FROM workspace_assignment").get(),
      ).toEqual({ status: "pending", completedAt: null });
      expect(f.calls).toBe(0);
      expect((await f.callback(await f.begin())).status).toBe(303);
    } finally {
      await f.close();
    }
  });

for (const change of [
  "stop",
  "generation",
  "delegation",
  "spec",
  "repository",
  "membership",
  "guest",
  "team",
  "inactive member",
])
  test(`assignment continuation fails closed after ${change} changes`, async () => {
    const f = fixture();
    try {
      await f.assignments.authorize(f.event);
      expect((await f.callback(await f.begin())).status).toBe(303);
      if (change === "stop")
        advanceLinearSessionGeneration(f.db, "session", { stop: true, now: f.clock.now() });
      if (change === "generation")
        advanceLinearSessionGeneration(f.db, "session", { now: f.clock.now() });
      if (change === "delegation") f.ownership.delegateId = "another-app";
      if (change === "spec") f.tracker.epics.get("issue")!.description = "New criteria";
      if (change === "repository")
        f.db.run(
          "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('workspace','owner/new','team')",
        );
      if (change === "membership") f.setActive(false);
      if (change === "guest") f.setGuest(true);
      if (change === "team") f.setTeams([]);
      if (change === "inactive member")
        f.db.run("UPDATE workspace_member SET active=0 WHERE user_id<>'owner'");
      const jobs = f.jobs();
      await jobs.tick();
      await jobs.tick();
      // The resume reads only the issue and the membership. A changed description is caught at
      // intake, which reads the epic anyway and compares it with the stored snapshot.
      expect(f.calls).toBe(change === "spec" ? 1 : 0);
      expect(f.continuations).toEqual([]);
      expect(listWorkItems(f.db)).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test("held prompts cannot become initial delegation; waiting writes nothing; Stop invalidates hold", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const original = f.link();
    expect(
      await f.assignments.authorize({
        ...f.event,
        action: "prompted",
        body: "Go ahead",
        actorId: "member",
      }),
    ).toEqual({
      outcome: "refused",
      reason: "It waits until you sign in to Paws with your Linear account.",
    });
    f.clock.advance(600_001);
    await f.restart();
    await f.jobs().tick();
    expect(listOutbox(f.db)).toHaveLength(1);
    expect(f.link()).toBe(original);
    const start = await f.begin(original);
    expect(start.status).toBe(303);
    expect(
      await f.assignments.authorize({ ...f.event, signal: "stop", action: "prompted" }),
    ).toEqual({ outcome: "accepted" });
    expect((await f.callback(start)).status).toBe(400);
    expect(f.calls).toBe(0);
  } finally {
    await f.close();
  }
});

test("linked members avoid a new-issue sign-in hold while removed members do not", async () => {
  const f = fixture();
  try {
    const userId = putWorkspaceUser(f.db, {
      id: "member",
      linearUserId: "member",
      name: "Member",
      email: "member@example.invalid",
    });
    syncWorkspaceMember(f.db, {
      workspaceId: "workspace",
      userId,
      active: true,
      role: "member",
      teamIds: ["team"],
      now: f.clock.now(),
    });
    expect(await f.assignments.authorize(f.event)).toEqual({ outcome: "accepted" });
    expect(listOutbox(f.db)).toHaveLength(0);
    f.db.run("UPDATE workspace_member SET active=0 WHERE user_id='member'");
    expect(await f.assignments.authorize(f.event)).toMatchObject({ outcome: "refused" });
    expect(getLinearSession(f.db, "session")!.creatorId).toBe("member");
  } finally {
    await f.close();
  }
});

function linkMember(f: ReturnType<typeof fixture>) {
  const userId = putWorkspaceUser(f.db, {
    id: "member",
    linearUserId: "member",
    name: "Member",
    email: "member@example.invalid",
  });
  syncWorkspaceMember(f.db, {
    workspaceId: "workspace",
    userId,
    active: true,
    role: "member",
    teamIds: ["team"],
    now: f.clock.now(),
  });
}

const rules: [string, string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    "delegated elsewhere",
    "This issue is delegated to another agent.",
    (f) => (f.ownership.delegateId = "another-app"),
  ],
  [
    "closed issue",
    "This issue is completed or canceled.",
    (f) => (f.ownership.stateType = "completed"),
  ],
  [
    "issue outside the team",
    "This issue is not in the Linear team Paws is installed for.",
    (f) => (f.ownership.teamId = "other"),
  ],
  [
    "ended session",
    "This session already ended in Linear.",
    (f) => (f.session.endedAt = new Date(f.clock.now()).toISOString()),
  ],
  [
    "session started by Paws",
    "Paws could not tell who started this session.",
    (f) => (f.session.creatorId = "app"),
  ],
  [
    "stopped session",
    "This session was stopped or replaced by a newer delegation.",
    (f) => advanceLinearSessionGeneration(f.db, "session", { stop: true, now: f.clock.now() }),
  ],
  ["inactive account", "Your Linear account is not active.", (f) => f.setActive(false)],
  ["outside the team", "You are not a member of this issue's Linear team.", (f) => f.setTeams([])],
  [
    "inactive membership",
    "Your Paws workspace membership is not active.",
    (f) => f.db.run("UPDATE workspace_member SET active=0 WHERE user_id='member'"),
  ],
];

for (const [rule, reason, apply] of rules)
  test(`a delegation refused for ${rule} says so`, async () => {
    const f = fixture();
    try {
      linkMember(f);
      apply(f);
      expect(await f.assignments.authorize(f.event)).toEqual({ outcome: "refused", reason });
    } finally {
      await f.close();
    }
  });

test("a Linear guest's delegation is ignored, and the session's response says guests can't use Paws", async () => {
  const f = fixture();
  try {
    linkMember(f);
    f.setGuest(true);
    expect(await f.assignments.authorize(f.event)).toEqual({
      outcome: "refused",
      reason: "Linear guests can't use Paws.",
      response: true,
    });
    await acknowledgeNewSession(f.tracker, f.event, (event) => f.orchestrator.onLinearEvent(event));
    expect(listWorkItems(f.db)).toHaveLength(0);
    expect(f.tracker.progress.slice(1).map((update) => [update.kind, update.body])).toEqual([
      ["response", "Linear guests can't use Paws."],
    ]);
    // A linked member who became a guest loses access, the same as a deactivated account.
    expect(workspaceLinearMember(f.db, "workspace", "member")?.active).toBe(false);
  } finally {
    await f.close();
  }
});

test("a member's delegation whose first Linear read fails is retried and accepted", async () => {
  const f = fixture();
  try {
    linkMember(f);
    f.failSessionRead();
    const acknowledged = new Set<string>();
    const deliver = (attempt: number) =>
      acknowledgeNewSession(
        f.tracker,
        f.event,
        (event) => f.orchestrator.onLinearEvent(event),
        undefined,
        { acknowledged, reportFailure: attempt === 0 },
      );
    await expect(deliver(0)).rejects.toBeInstanceOf(LinearIntakePendingError);
    await deliver(1);
    expect(listWorkItems(f.db)).toHaveLength(1);
    expect(f.tracker.progress.filter((update) => update.kind === "error")).toEqual([]);
    expect(f.tracker.progress[1]!.body).toContain("Linear HTTP 503");
  } finally {
    await f.close();
  }
});

test("one delegation event reads each Linear source once", async () => {
  const f = fixture();
  try {
    linkMember(f);
    let reads = 0;
    f.onMemberRead(async () => {
      reads++;
    });
    await f.orchestrator.onLinearEvent(f.event);
    expect(reads).toBe(1);
    expect(f.sessionReads).toBe(1);
    expect(listWorkItems(f.db)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a delegation that arrives before its installation is recorded is accepted once it is", async () => {
  const f = fixture({ installed: false });
  try {
    linkMember(f);
    expect(await f.assignments.authorize(f.event)).toMatchObject({ outcome: "retry" });
    f.install();
    expect(await f.assignments.authorize(f.event)).toEqual({ outcome: "accepted" });
  } finally {
    await f.close();
  }
});

test("concurrent delegations from the same member are all accepted", async () => {
  const f = fixture();
  try {
    linkMember(f);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    f.onMemberRead(() => (++reads === 1 ? held : Promise.resolve()));
    const first = f.assignments.authorize(f.event);
    await Bun.sleep(0);
    f.clock.advance(1_000);
    const second = await f.assignments.authorize({ ...f.event, dedupeKey: "second" });
    release();
    expect([await first, second]).toEqual([{ outcome: "accepted" }, { outcome: "accepted" }]);
    expect(listOutbox(f.db)).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("an interrupted canonical continuation retries from durable acceptance without repeating the decision", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    await f.callback(await f.begin());
    f.failContinue();
    await f.jobs().tick();
    const job = listJobs(f.db).find((value) => value.queue === "workspace.assignment")!;
    expect(job.status).toBe("pending");
    await f.restart();
    f.clock.advance(60_000);
    const loop = f.jobs();
    await loop.tick();
    await loop.tick();
    expect(f.continuations).toHaveLength(1);
    expect(
      f.db.query("SELECT 1 FROM workspace_access_audit WHERE action='assignment.resumed'").all(),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("two workers cannot claim the same durable continuation", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    await f.callback(await f.begin());
    const first = claimNextJob(f.db, { queues: ["workspace.assignment"], now: f.clock.now() })!;
    expect(claimNextJob(f.db, { queues: ["workspace.assignment"], now: f.clock.now() })).toBeNull();
    expect(completeJob(f.db, first, f.clock.now())).toBe(true);
  } finally {
    await f.close();
  }
});

test("the resume reuses the stored snapshot and reads only the issue and the membership", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    expect(f.decisionReads).toEqual({ session: 1, issue: 1, epic: 1 });
    expect((await f.callback(await f.begin())).status).toBe(303);
    const before = f.linearRequests;
    const jobs = f.jobs();
    await jobs.tick();
    await jobs.tick();
    expect(f.continuations).toEqual([f.event.dedupeKey]);
    // One issue read and one membership read before resume; the continuation reads neither.
    expect(f.decisionReads).toEqual({ session: 1, issue: 2, epic: 1 });
    expect(f.linearRequests - before).toBe(1);
  } finally {
    await f.close();
  }
});

const errors = (f: ReturnType<typeof fixture>) =>
  listOutbox(f.db)
    .map((row) => row.payload as { kind?: string; body?: string })
    .filter((payload) => payload.kind === "error")
    .map((payload) => payload.body);

for (const [change, reason, apply] of [
  [
    "the issue's delegate",
    "This issue changed while Paws waited for you to sign in.",
    (f: ReturnType<typeof fixture>) => (f.ownership.delegateId = "another-app"),
  ],
  [
    "the issue's state",
    "This issue changed while Paws waited for you to sign in.",
    (f: ReturnType<typeof fixture>) => (f.ownership.stateType = "completed"),
  ],
  [
    "the Linear account",
    "Your Linear account is not active.",
    (f: ReturnType<typeof fixture>) => f.setActive(false),
  ],
  [
    "the issue's team membership",
    "You are not a member of this issue's Linear team.",
    (f: ReturnType<typeof fixture>) => f.setTeams([]),
  ],
] as const)
  test(`a change to ${change} between sign-in and resume refuses once with its reason`, async () => {
    const f = fixture();
    try {
      await f.assignments.authorize(f.event);
      expect((await f.callback(await f.begin())).status).toBe(303);
      apply(f);
      const jobs = f.jobs();
      await jobs.tick();
      await jobs.tick();
      expect(f.calls).toBe(0);
      expect(listWorkItems(f.db)).toHaveLength(0);
      expect(errors(f)).toEqual([`Paws did not start this work. ${reason}`]);
      expect(f.db.query("SELECT status FROM workspace_assignment").get()).toEqual({
        status: "invalid",
      });
      expect(
        listJobs(f.db).filter((job) => job.queue === "workspace.assignment" && job.lastError),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  });

for (const change of ["spec", "repository", "membership"])
  test(`intake refuses ${change} changing after continuation checks`, async () => {
    const f = fixture();
    try {
      await f.assignments.authorize(f.event);
      await f.callback(await f.begin());
      f.changeAtIntake(() => {
        if (change === "spec") f.tracker.epics.get("issue")!.description = "Replaced during intake";
        if (change === "repository")
          f.db.run(
            "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('workspace','another/repo','team')",
          );
        if (change === "membership")
          f.db.run("UPDATE workspace_member SET active=0 WHERE user_id<>'owner'");
      });
      await f.jobs().tick();
      expect(listWorkItems(f.db)).toHaveLength(0);
      expect(listJobs(f.db).filter((job) => job.queue === "item.start")).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

test("a new canonical generation does not reuse an obsolete onboarding hold", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const previous = f.link();
    advanceLinearSessionGeneration(f.db, "session", { now: f.clock.now() });
    expect(
      await f.assignments.authorize({ ...f.event, dedupeKey: "new-assignment" }),
    ).toMatchObject({ outcome: "refused" });
    expect(listOutbox(f.db)).toHaveLength(2);
    expect(f.link()).not.toBe(previous);
    expect((await f.begin(previous)).status).toBe(404);
    expect((await f.callback(await f.begin())).status).toBe(303);
  } finally {
    await f.close();
  }
});

test("browser callback cannot accept a hold after losing the issue team", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const start = await f.begin();
    f.setTeams([]);
    expect((await f.callback(start)).status).toBe(400);
    expect(listJobs(f.db)).toHaveLength(0);
  } finally {
    await f.close();
  }
});

const SIGN_IN_BODY =
  "Welcome to Paws. Sign in with Linear so I can start TEST-1. I'll start on my own once you're set up. You can Stop this anytime.\n\nOptional: link GitHub on the next page so your commits credit you.";

const elicitations = (f: ReturnType<typeof fixture>) =>
  listOutbox(f.db).filter((row) => row.op === "elicitation");

test("an unknown delegator sees the first thought, then one sign-in action, and waiting writes nothing", async () => {
  const f = fixture();
  try {
    const acknowledged = new Set<string>();
    const deliver = () =>
      acknowledgeNewSession(
        f.tracker,
        f.event,
        (event) => f.orchestrator.onLinearEvent(event),
        {},
        {
          acknowledged,
        },
      );
    expect(await deliver()).toBe(false);
    await f.deliver();
    expect(f.tracker.progress.map((update) => [update.kind, update.body])).toEqual([
      ["thought", "Picked up this issue."],
    ]);
    expect(f.tracker.questions).toHaveLength(1);
    const question = f.tracker.questions[0]!;
    expect(question.body).toBe(SIGN_IN_BODY);
    expect(question.body).toContain(
      "Optional: link GitHub on the next page so your commits credit you.",
    );
    expect(question.auth?.userId).toBe("member");
    expect(question.auth?.url).toMatch(
      /^https:\/\/paws\.example\.invalid\/onboard\/[A-Za-z0-9]{26}$/,
    );
    expect(question.auth?.url).not.toContain("?");

    expect(await deliver()).toBe(false);
    const jobs = f.jobs();
    for (let minute = 0; minute < 120; minute++) {
      f.clock.advance(60_000);
      await jobs.tick();
    }
    await f.deliver();
    expect(f.tracker.progress).toHaveLength(1);
    expect(f.tracker.questions).toHaveLength(1);
    expect(listOutbox(f.db)).toHaveLength(1);

    const start = await f.begin(question.auth!.url);
    expect(start.status).toBe(303);
    const provider = new URL(start.headers.get("location")!);
    expect(`${provider.origin}${provider.pathname}`).toBe("https://linear.app/oauth/authorize");
    expect(provider.searchParams.get("code_challenge_method")).toBe("S256");
    expect(start.headers.get("set-cookie")).toMatch(/^__Host-paws-login=/);
  } finally {
    await f.close();
  }
});

/** The Paws session cookie a callback set, ready for a cookie header. */
function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${WORKSPACE_COOKIE}=`));
  expect(cookie).toBeDefined();
  return cookie!.split(";")[0]!;
}

const onboardPath = (link: string) => new URL(link).pathname;

test("the creator's link sign-in resumes the held session and lands on its onboarding page", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    const done = await f.callback(await f.begin(link));
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(onboardPath(link));
    const hold = f.db
      .query<{ status: string; completedAt: number | null }, []>(
        "SELECT status,completed_at AS completedAt FROM workspace_assignment",
      )
      .get()!;
    expect(hold).toEqual({ status: "ready", completedAt: f.clock.now() });
    const cookie = sessionCookie(done);
    const page = await fetch(`${f.local}${onboardPath(link)}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    const html = await page.text();
    expect(html).toContain("Welcome, member");
    expect(html).toContain("<strong>TEST-1</strong>");
    expect(html).toMatch(
      /<h2>Linear<\/h2><p class="detail">Signed in as member@example\.invalid\.<\/p><\/div><span class="label">Done<\/span>/,
    );
    expect(html).toMatch(
      /<h2>Membership<\/h2><p class="detail">Member of Platform\.<\/p><\/div><span class="label">Done<\/span>/,
    );
    expect(html).toContain(
      '<li class="needed" data-runner="needed"><span class="mark" aria-hidden="true">3</span><div><h2>Runner</h2>',
    );
    expect(html).toContain(
      '<li class="later"><span class="mark" aria-hidden="true">4</span><div><h2>Claude and Codex</h2>',
    );
    expect(html).toContain("<h2>GitHub credit</h2>");
    expect(html).toContain(
      '<a href="https://linear.app/acme/issue/TEST-1">Open TEST-1 in Linear</a>',
    );
    expect(html).toContain("You can close this tab.");
    expect(html).toContain('<meta http-equiv="refresh" content="15">');

    // Closing the page changes nothing: the hold continues on its own and Linear hears nothing new.
    const jobs = f.jobs();
    await jobs.tick();
    await jobs.tick();
    expect(f.continuations).toEqual([f.event.dedupeKey]);
    expect(listWorkItems(f.db)).toHaveLength(1);
    expect(elicitations(f)).toHaveLength(1);

    // Reopening after a restart shows the current state from SQLite.
    await f.restart();
    const outbox = listOutbox(f.db).length;
    const reopened = await fetch(`${f.local}${onboardPath(link)}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(reopened.status).toBe(200);
    expect(await reopened.text()).toContain("Welcome, member");
    expect(listOutbox(f.db)).toHaveLength(outbox);
  } finally {
    await f.close();
  }
});

test("the runner step uses the issue's project lead's shared runner, never another member's", async () => {
  const f = fixture({ projectLeadId: "lead" });
  try {
    for (const id of ["lead", "colleague"]) {
      putWorkspaceUser(f.db, {
        id,
        linearUserId: id,
        name: id === "lead" ? "Lena Lead" : "Colin",
        email: `${id}@example.invalid`,
      });
      syncWorkspaceMember(f.db, {
        workspaceId: "workspace",
        userId: id,
        role: "member",
        active: true,
        teamIds: ["team"],
        now: f.clock.now(),
      });
    }
    const addRunner = (id: string, owner: string, sharing: number) => {
      f.db.run(
        "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",
        [id, "workspace", owner, `${id}-host`, "active", f.clock.now(), f.clock.now()],
      );
      f.db.run("INSERT INTO runner_policy(runner_id,sharing) VALUES(?,?)", [id, sharing]);
    };
    // A colleague who does not lead the project shares a runner; it does not count.
    addRunner("colleague-box", "colleague", 1);
    await f.assignments.authorize(f.event);
    const link = f.link();
    const done = await f.callback(await f.begin(link));
    const cookie = sessionCookie(done);
    const open = async () =>
      (
        await fetch(`${f.local}${onboardPath(link)}`, { redirect: "manual", headers: { cookie } })
      ).text();
    const needed = await open();
    expect(needed).toMatch(
      /<h2>Runner<\/h2><p class="detail">You have no runner Paws can use for this task\. Add a host with an enrollment token\. This step completes when it pairs\.<\/p><div class="actions"><button type="button" class="action" data-action="add-host">Add a host<\/button><\/div><\/div><span class="label">Needed<\/span>/,
    );
    expect(needed).not.toContain("colleague-box");
    // The lead shares a runner: the step is ready on the next load, without restarting anything.
    const outbox = listOutbox(f.db).length;
    addRunner("lead-box", "lead", 1);
    expect(await open()).toMatch(
      /<h2>Runner<\/h2><p class="detail">Lena Lead&#39;s shared runner lead-box-host will run this task\.<\/p><\/div><span class="label">Ready<\/span>/,
    );
    expect(listOutbox(f.db)).toHaveLength(outbox);
  } finally {
    await f.close();
  }
});

test("the runner step offers Create VM when Paws can create one", async () => {
  const f = fixture({ createVm: true });
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    const done = await f.callback(await f.begin(link));
    const html = await (
      await fetch(`${f.local}${onboardPath(link)}`, {
        redirect: "manual",
        headers: { cookie: sessionCookie(done) },
      })
    ).text();
    expect(html).toContain(
      '<button type="button" class="action" data-action="create-vm">Create VM</button>',
    );
    expect(html).toContain('<button type="button" class="action" data-action="add-host">');
  } finally {
    await f.close();
  }
});

test("the onboarding page reads no Linear data and is gone once the member loses access", async () => {
  const f = fixture({ createVm: true });
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    const done = await f.callback(await f.begin(link));
    const cookie = sessionCookie(done);
    let memberReads = 0;
    f.onMemberRead(async () => {
      memberReads++;
    });
    const sessionReads = f.sessionReads;
    const fetchPage = () =>
      fetch(`${f.local}${onboardPath(link)}`, { redirect: "manual", headers: { cookie } });
    const open = async () => {
      const page = await fetchPage();
      expect(page.status).toBe(200);
      return page.text();
    };
    const member = await open();
    expect(member).toContain('data-action="create-vm"');
    expect(member).toMatch(/<meta name="paws-csrf" content="[^"]+">/);
    await open();
    f.db.run(
      "UPDATE workspace_member SET active=0 WHERE user_id=(SELECT id FROM workspace_user WHERE linear_user_id='member')",
    );
    expect((await fetchPage()).status).toBe(404);
    expect(memberReads).toBe(0);
    expect(f.sessionReads).toBe(sessionReads);
  } finally {
    await f.close();
  }
});

test("a finished link opened without a Paws session is 404, even for its creator", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    await f.callback(await f.begin(link));
    const opened = await f.begin(link);
    expect(opened.status).toBe(404);
    expect(opened.headers.get("location")).toBeNull();
    expect(opened.headers.get("set-cookie")).toBeNull();
    expect(await opened.text()).not.toContain("TEST-1");
    // The creator signs in from the dashboard and the link shows their page again.
    const back = await f.callback(await fetch(`${f.local}/auth/linear`, { redirect: "manual" }));
    expect(back.status).toBe(303);
    const page = await f.begin(link, { cookie: sessionCookie(back) });
    expect(page.status).toBe(200);
    expect(f.db.query("SELECT status FROM workspace_assignment").get()).toEqual({
      status: "ready",
    });
  } finally {
    await f.close();
  }
});

test("another member opening the onboarding link sees nothing about the issue", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    await f.callback(await f.begin(link));
    const dashboard = await f.callback(
      await fetch(`${f.local}/auth/linear`, { redirect: "manual" }),
      "other",
    );
    expect(dashboard.headers.get("location")).toBe("/status/");
    const cookie = sessionCookie(dashboard);
    for (const headers of [{ cookie }, {}] as Record<string, string>[]) {
      const opened = await f.begin(link, headers);
      expect(opened.status).toBe(404);
      expect(opened.headers.get("location")).toBeNull();
      expect(
        opened.headers.getSetCookie().some((value) => value.startsWith(`${WORKSPACE_COOKIE}=`)),
      ).toBe(false);
      expect(await opened.text()).not.toContain("TEST-1");
    }
    expect(f.db.query("SELECT status FROM workspace_assignment").get()).toEqual({
      status: "ready",
    });
  } finally {
    await f.close();
  }
});

test("a stopped session closes its onboarding page", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    const cookie = sessionCookie(await f.callback(await f.begin(link)));
    advanceLinearSessionGeneration(f.db, "session", { stop: true, now: f.clock.now() });
    const opened = await fetch(`${f.local}${onboardPath(link)}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(opened.status).toBe(404);
    expect(await opened.text()).not.toContain("TEST-1");
  } finally {
    await f.close();
  }
});

test("signing in from the dashboard instead of the link releases the hold", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const start = await fetch(`${f.local}/auth/linear`, { redirect: "manual" });
    const done = await f.callback(start);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/status/");
    const jobs = f.jobs();
    await jobs.tick();
    await jobs.tick();
    expect(f.continuations).toEqual([f.event.dedupeKey]);
    expect(elicitations(f)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a member row for the creator lets the hold continue on the next sweep with no new action", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const jobs = f.jobs();
    await jobs.tick();
    expect(f.continuations).toEqual([]);
    linkMember(f);
    f.clock.advance(60_000);
    await jobs.tick();
    await jobs.tick();
    await jobs.tick();
    expect(f.continuations).toEqual([f.event.dedupeKey]);
    expect(elicitations(f)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("old secret sign-in links answer 410 and unknown onboarding links 404", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const old = await fetch(`${f.local}/auth/linear?assignment=${"a".repeat(43)}`, {
      redirect: "manual",
    });
    expect(old.status).toBe(410);
    expect(await old.json()).toEqual({
      error: "This sign-in link was replaced. Use the latest Sign in to Paws action in Linear.",
    });
    expect(old.headers.get("set-cookie")).toBeNull();
    for (const path of ["/onboard/AAAAAAAAAAAAAAAAAAAAAAAAAA", "/onboard/short", "/onboard/"])
      expect((await fetch(`${f.local}${path}`, { redirect: "manual" })).status).toBe(404);
  } finally {
    await f.close();
  }
});

test("at deploy a pending hold without a link gets one link and one new-form action", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    f.db.run(
      "UPDATE workspace_assignment SET link_id=NULL,link_expires_at=NULL,token_hash='old',expires_at=?",
      [f.clock.now() - 1],
    );
    f.db.run("DELETE FROM outbox");
    await f.restart();
    f.jobs();
    await f.restart();
    await f.jobs().tick();
    expect(elicitations(f)).toHaveLength(1);
    const link = f.link();
    expect(link).toMatch(/^https:\/\/paws\.example\.invalid\/onboard\/[A-Za-z0-9]{26}$/);
    const hold = f.db
      .query<{ linkId: string; tokenHash: string; linkExpiresAt: number }, []>(
        "SELECT link_id AS linkId,token_hash AS tokenHash,link_expires_at AS linkExpiresAt FROM workspace_assignment",
      )
      .get()!;
    expect(link.endsWith(hold.linkId)).toBe(true);
    expect(hold.tokenHash).toBe(workspaceTokenHash(hold.linkId));
    expect(hold.linkExpiresAt).toBeGreaterThan(f.clock.now());
    expect((await f.callback(await f.begin(link))).headers.get("location")).toBe(
      new URL(link).pathname,
    );
  } finally {
    await f.close();
  }
});

/** Signs the creator in through their link and lets the held session resume. */
async function onboarded(f: ReturnType<typeof fixture>) {
  await f.assignments.authorize(f.event);
  const link = f.link();
  const done = await f.callback(await f.begin(link));
  expect(done.status).toBe(303);
  const jobs = f.jobs();
  await jobs.tick();
  await jobs.tick();
  expect(f.continuations).toEqual([f.event.dedupeKey]);
  const items = listWorkItems(f.db);
  expect(items).toHaveLength(1);
  return { path: onboardPath(link), cookie: sessionCookie(done), itemId: items[0]!.id };
}

function formFields(html: string) {
  const form = html.match(/<form method="post" action="([^"]+)">/);
  const csrf = html.match(/<input type="hidden" name="csrf" value="([^"]+)">/);
  return form && csrf ? { action: form[1]!, csrf: csrf[1]! } : null;
}

function postCredit(
  f: ReturnType<typeof fixture>,
  path: string,
  cookie: string,
  body: Record<string, string>,
  query = "",
) {
  return fetch(`${f.local}${path}/github${query}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin: f.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
}

test("an onboarding without a GitHub link resumes and starts with no commit credit", async () => {
  const f = fixture();
  try {
    const { path, cookie, itemId } = await onboarded(f);
    const html = await (await fetch(`${f.local}${path}`, { headers: { cookie } })).text();
    expect(html).toContain("Link GitHub to get credit on commits and pull requests (optional).");
    expect(formFields(html)).toEqual({ action: `${path}/github`, csrf: expect.any(String) });
    // The optional step never counts as remaining work.
    expect(html).toContain("2 more steps before Paws starts");
    expect(delegatorCommitCredit(f.db, itemId)).toBeNull();
    expect(f.githubCalls).toEqual([]);
  } finally {
    await f.close();
  }
});

test("linking GitHub from the onboarding page returns to it and credits that run's commits", async () => {
  const f = fixture();
  try {
    const { path, cookie, itemId } = await onboarded(f);
    const html = await (await fetch(`${f.local}${path}`, { headers: { cookie } })).text();
    const { csrf } = formFields(html)!;

    const start = await postCredit(f, path, cookie, { csrf, consent: "yes" });
    expect(start.status).toBe(303);
    const authorize = new URL(start.headers.get("location")!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      `${f.origin}/auth/github-attribution/callback`,
    );
    expect(
      f.db.query("SELECT return_path AS returnPath FROM github_attribution_request").get(),
    ).toEqual({ returnPath: path });
    expect(f.githubCalls).toEqual([]);

    const attribution = start.headers.get("set-cookie")!.split(";")[0]!;
    const back = await fetch(
      `${f.local}/auth/github-attribution/callback?state=${authorize.searchParams.get("state")}&code=fixture`,
      { redirect: "manual", headers: { cookie: `${cookie}; ${attribution}` } },
    );
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${f.origin}${path}`);
    expect(f.githubCalls).toEqual(["token", "user"]);

    const linked = await (await fetch(`${f.local}${path}`, { headers: { cookie } })).text();
    expect(linked).toContain("Commits will credit @morgan-gh.");
    expect(linked).toMatch(/<h2>GitHub credit<\/h2>.*<span class="label">Linked<\/span>/);
    expect(formFields(linked)).toBeNull();
    expect(delegatorCommitCredit(f.db, itemId)).toEqual({
      id: 4242,
      login: "morgan-gh",
      name: "Morgan",
      email: "4242+morgan-gh@users.noreply.github.com",
    });
  } finally {
    await f.close();
  }
});

test("a forged return_path in the request cannot move where the GitHub credit callback returns", async () => {
  const f = fixture();
  try {
    const { path, cookie } = await onboarded(f);
    const { csrf } = formFields(
      await (await fetch(`${f.local}${path}`, { headers: { cookie } })).text(),
    )!;
    const forged = "https://evil.example/steal";
    const start = await postCredit(
      f,
      path,
      cookie,
      { csrf, consent: "yes", return_path: forged, returnPath: forged },
      `?return_path=${encodeURIComponent(forged)}`,
    );
    expect(start.status).toBe(303);
    expect(
      f.db.query("SELECT return_path AS returnPath FROM github_attribution_request").get(),
    ).toEqual({ returnPath: path });
    const authorize = new URL(start.headers.get("location")!);
    const back = await fetch(
      `${f.local}/auth/github-attribution/callback?state=${authorize.searchParams.get("state")}&code=fixture&return_path=${encodeURIComponent(forged)}`,
      {
        redirect: "manual",
        headers: { cookie: `${cookie}; ${start.headers.get("set-cookie")!.split(";")[0]!}` },
      },
    );
    expect(back.headers.get("location")).toBe(`${f.origin}${path}`);
  } finally {
    await f.close();
  }
});

test("the onboarding credit form needs the creator, CSRF and consent, and calls GitHub for none", async () => {
  const f = fixture();
  try {
    const { path, cookie } = await onboarded(f);
    const { csrf } = formFields(
      await (await fetch(`${f.local}${path}`, { headers: { cookie } })).text(),
    )!;
    expect((await postCredit(f, path, cookie, { csrf: "wrong", consent: "yes" })).status).toBe(403);
    expect((await postCredit(f, path, cookie, { csrf })).status).toBe(400);
    expect((await postCredit(f, path, "", { csrf, consent: "yes" })).status).toBe(404);
    expect(
      (await postCredit(f, "/onboard/AAAAAAAAAAAAAAAAAAAAAAAAAA", cookie, { csrf, consent: "yes" }))
        .status,
    ).toBe(404);
    const crossSite = await fetch(`${f.local}${path}/github`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf, consent: "yes" }).toString(),
    });
    expect(crossSite.status).toBe(403);
    expect((await fetch(`${f.local}${path}/github`, { headers: { cookie } })).status).toBe(405);
    expect(f.db.query("SELECT count(*) AS n FROM github_attribution_request").get()).toEqual({
      n: 0,
    });
    expect(f.githubCalls).toEqual([]);
  } finally {
    await f.close();
  }
});

const holdStatus = (f: ReturnType<typeof fixture>) =>
  f.db.query<{ status: string }, []>("SELECT status FROM workspace_assignment").get()!.status;

test("a pending hold past one day posts one final response, ends the session and cancels the hold", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    const start = await f.begin(link);
    await f.deliver();
    expect(f.tracker.questions).toHaveLength(1);
    const jobs = f.jobs();
    f.clock.advance(ONBOARDING_HOLD_MS - 60_000);
    await jobs.tick();
    expect(holdStatus(f)).toBe("pending");
    expect(listOutbox(f.db)).toHaveLength(1);

    f.clock.advance(2 * 60_000);
    for (let minute = 0; minute < 5; minute++) {
      await jobs.tick();
      f.clock.advance(60_000);
    }
    await f.deliver();
    const responses = f.tracker.progress.filter((update) => update.kind === "response");
    expect(responses.map((update) => update.body)).toEqual([ONBOARDING_EXPIRED_BODY]);
    expect(f.tracker.questions).toHaveLength(1);
    expect(getLinearSession(f.db, "session")!.stoppedAt).not.toBeNull();
    expect(holdStatus(f)).toBe("invalid");
    expect(listWorkItems(f.db)).toHaveLength(0);

    // The link, a late callback and a later sign-in from the dashboard cannot start the work.
    expect((await f.begin(link)).status).toBe(404);
    expect((await f.callback(start)).status).toBe(400);
    const dashboard = await fetch(`${f.local}/auth/linear`, { redirect: "manual" });
    expect((await f.callback(dashboard)).status).toBe(303);
    await jobs.tick();
    await jobs.tick();
    expect(f.continuations).toEqual([]);
    expect(listOutbox(f.db).filter((row) => row.status !== "dropped")).toHaveLength(1);
    expect(holdStatus(f)).toBe("invalid");
  } finally {
    await f.close();
  }
});

test("a completed link shows the task only to its creator and is 404 for anyone else", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    const done = await f.callback(await f.begin(link));
    expect(done.status).toBe(303);
    const creator = sessionCookie(done);
    const jobs = f.jobs();
    await jobs.tick();
    await jobs.tick();
    expect(f.continuations).toEqual([f.event.dedupeKey]);

    const mine = await f.begin(link, { cookie: creator });
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain("<strong>TEST-1</strong>");

    const anonymous = await f.begin(link);
    expect(anonymous.status).toBe(404);
    expect(anonymous.headers.get("location")).toBeNull();
    expect(anonymous.headers.get("set-cookie")).toBeNull();
    expect(await anonymous.text()).not.toContain("TEST-1");

    const other = await f.callback(
      await fetch(`${f.local}/auth/linear`, { redirect: "manual" }),
      "wrong",
    );
    expect(other.status).toBe(303);
    const someoneElse = await f.begin(link, { cookie: sessionCookie(other) });
    expect(someoneElse.status).toBe(404);
    expect(someoneElse.headers.get("location")).toBeNull();
    expect(await someoneElse.text()).not.toContain("TEST-1");
  } finally {
    await f.close();
  }
});

test("onboarding starts are limited per client IP and per link, and a 429 writes nothing", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    const outbox = listOutbox(f.db).length;
    const linear = f.linearRequests;
    const ip = { "x-test-ip": "203.0.113.7" };
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await f.begin(link, ip)).status).toBe(303);
    const limited = await f.begin(link, ip);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get("set-cookie")).toBeNull();
    // Unknown links count against the same address, so ids cannot be guessed past the limit.
    expect(
      (await f.begin("https://paws.example.invalid/onboard/AAAAAAAAAAAAAAAAAAAAAAAAAA", ip)).status,
    ).toBe(429);
    expect((await f.begin(link, { "x-test-ip": "203.0.113.8" })).status).toBe(303);
    f.clock.advance(60_000);
    expect((await f.begin(link, ip)).status).toBe(303);

    // 12 starts so far for this link; 8 more reach its daily limit from fresh addresses.
    for (let attempt = 0; attempt < 8; attempt++)
      expect((await f.begin(link, { "x-test-ip": `198.51.100.${attempt}` })).status).toBe(303);
    const perLink = await f.begin(link, { "x-test-ip": "198.51.100.200" });
    expect(perLink.status).toBe(429);
    expect(Number(perLink.headers.get("retry-after"))).toBeGreaterThan(60);
    expect(Number(perLink.headers.get("retry-after"))).toBeLessThanOrEqual(24 * 60 * 60);

    expect(listOutbox(f.db)).toHaveLength(outbox);
    expect(f.linearRequests).toBe(linear);
    expect(f.tracker.questions).toHaveLength(0);
    expect(f.tracker.progress).toHaveLength(0);
    expect(f.logs).toEqual([
      "Paws rate limit reached: onboarding.start.ip",
      "Paws rate limit reached: onboarding.start.ip",
      "Paws rate limit reached: onboarding.start.link",
    ]);
  } finally {
    await f.close();
  }
});

test("five failed callbacks from one IP in ten minutes block the sixth without a Linear request", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const ip = { "x-test-ip": "203.0.113.9" };
    const start = await f.begin(f.link(), ip);
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = await fetch(`${f.local}/auth/linear/callback?state=bad${attempt}&code=bad`, {
        redirect: "manual",
        headers: ip,
      });
      expect(failed.status).toBe(400);
    }
    const outbox = listOutbox(f.db).length;
    const linear = f.linearRequests;
    const limited = await f.callback(start, "member", ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(600);
    expect(f.linearRequests).toBe(linear);
    expect(listOutbox(f.db)).toHaveLength(outbox);
    expect(listJobs(f.db).filter((job) => job.queue === "workspace.assignment")).toHaveLength(0);
    expect(holdStatus(f)).toBe("pending");
    expect(f.logs).toEqual(["Paws rate limit reached: linear.callback.failed.ip"]);

    // The state stays unused, so the same start completes once the window has passed.
    f.clock.advance(5 * 60_000);
    const later = await f.begin(f.link(), ip);
    f.clock.advance(5 * 60_000 + 1);
    expect((await f.callback(later, "member", ip)).status).toBe(303);
  } finally {
    await f.close();
  }
});

test("no log line contains the link path, an OAuth code or state, or a cookie value", async () => {
  const captured: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((method) => console[method]);
  for (const method of methods)
    console[method] = (...args: unknown[]) => {
      captured.push(
        args.map((arg) => (typeof arg === "string" ? arg : Bun.inspect(arg))).join(" "),
      );
    };
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    const path = new URL(link).pathname;
    const secrets = [path, path.slice("/onboard/".length)];
    const ip = { "x-test-ip": "203.0.113.10" };
    const starts: Response[] = [];
    for (let attempt = 0; attempt < 11; attempt++) starts.push(await f.begin(link, ip));
    for (const start of starts.slice(0, 10)) {
      const provider = new URL(start.headers.get("location")!);
      secrets.push(
        provider.searchParams.get("state")!,
        provider.searchParams.get("code_challenge")!,
      );
      secrets.push(start.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!);
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const state = `STATE${attempt}x${"q".repeat(20)}`;
      const code = `CODE${attempt}x${"z".repeat(20)}`;
      const cookie = `COOKIE${attempt}x${"k".repeat(20)}`;
      secrets.push(state, code, cookie);
      await fetch(`${f.local}/auth/linear/callback?state=${state}&code=${code}`, {
        redirect: "manual",
        headers: { cookie: `__Host-paws-login=${cookie}`, "x-test-ip": "203.0.113.11" },
      });
    }
    const done = await f.callback(starts[0]!, "member", ip);
    expect(done.status).toBe(303);
    const session = sessionCookie(done);
    secrets.push(session.split("=")[1]!);
    const jobs = f.jobs();
    await jobs.tick();
    await jobs.tick();
    await f.deliver();
    await f.begin(link, { cookie: session, "x-test-ip": "203.0.113.12" });
    await f.begin(link, { "x-test-ip": "203.0.113.12" });
    expect(f.continuations).toEqual([f.event.dedupeKey]);

    const lines = [...captured, ...f.logs];
    expect(f.logs).toEqual([
      "Paws rate limit reached: onboarding.start.ip",
      "Paws rate limit reached: linear.callback.failed.ip",
    ]);
    for (const line of lines) {
      expect(line).not.toContain("/onboard/");
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  } finally {
    methods.forEach((method, index) => (console[method] = original[index]!));
    await f.close();
  }
});

function heldReply(f: ReturnType<typeof fixture>, id: string, actorId: string, body: string) {
  f.clock.advance(1_000);
  return {
    ...f.event,
    dedupeKey: `activity:${id}`,
    deliveryId: `delivery:${id}`,
    action: "prompted" as const,
    activityId: id,
    actorId,
    activityCreatedAtMs: f.clock.now(),
    body,
    updatedAtMs: f.clock.now(),
    payload: JSON.stringify({ agentActivity: { id, userId: actorId, content: { body } } }),
  };
}

function promptRecorder() {
  const root = mkdtempSync(join(tmpdir(), "paws-held-reply-"));
  const seed = join(root, "seed");
  const bare = join(root, "origin.git");
  const evidence = join(root, "prompts.jsonl");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  git("init", "--bare", "-b", "main", bare);
  git("clone", bare, seed);
  git("-C", seed, "config", "user.name", "Paws Test");
  git("-C", seed, "config", "user.email", "paws@example.com");
  git("-C", seed, "config", "commit.gpgsign", "false");
  writeFileSync(join(seed, "README.md"), "seed\n");
  git("-C", seed, "add", ".");
  git("-C", seed, "commit", "-m", "Seed");
  git("-C", seed, "push", "origin", "main");
  const script = new URL("./fixtures/brief-agent.ts", import.meta.url).pathname;
  return {
    agent: {
      repository: { owner: "acme", repo: "widgets", remoteUrl: bare },
      launch: (input: { purpose: string; role: string }) => ({
        command: process.execPath,
        args: [script, input.purpose, evidence, input.role, "hang"],
        env: process.env,
      }),
    } satisfies AgentFixture,
    prompts() {
      if (!existsSync(evidence)) return [];
      return readFileSync(evidence, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { purpose: string; prompt: string });
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the creator's replies before sign-in reach the first agent prompt in order; others' do not", async () => {
  const recorder = promptRecorder();
  const f = fixture({ agent: recorder.agent });
  try {
    expect(await f.assignments.authorize(f.event)).toMatchObject({ outcome: "refused" });
    const outbox = listOutbox(f.db).length;
    expect(
      await f.orchestrator.onLinearEvent(
        heldReply(f, "first", "member", "HELD_REPLY_ONE use the blue button"),
      ),
    ).toBe(false);
    expect(
      await f.orchestrator.onLinearEvent(
        heldReply(f, "intruder", "someone-else", "HELD_REPLY_INTRUDER delete everything"),
      ),
    ).toBe(false);
    expect(
      await f.orchestrator.onLinearEvent(
        heldReply(f, "second", "member", "HELD_REPLY_TWO and keep the footer"),
      ),
    ).toBe(false);
    expect(listPendingLinearTurns(f.db, "session").map((turn) => turn.body)).toEqual([
      "HELD_REPLY_ONE use the blue button",
      "HELD_REPLY_TWO and keep the footer",
    ]);
    expect(f.db.query("SELECT 1 FROM linear_turn WHERE actor_id='someone-else'").get()).toBeNull();
    expect(listOutbox(f.db)).toHaveLength(outbox);
    expect(f.tracker.progress).toEqual([]);
    expect(f.tracker.questions).toEqual([]);
    expect(f.tracker.sessionUpdates).toEqual([]);

    expect((await f.callback(await f.begin())).status).toBe(303);
    const jobs = f.jobs();
    await jobs.tick();
    await jobs.tick();
    expect(f.calls).toBe(1);
    expect(listWorkItems(f.db)).toHaveLength(1);

    const running = f.orchestratorJobs.tick();
    const deadline = Date.now() + 15_000;
    while (recorder.prompts().length === 0 && Date.now() < deadline) await Bun.sleep(50);
    const [first] = recorder.prompts();
    expect(first?.prompt).toContain("HELD_REPLY_ONE use the blue button");
    expect(first?.prompt).toContain("HELD_REPLY_TWO and keep the footer");
    expect(first!.prompt.indexOf("HELD_REPLY_ONE")).toBeLessThan(
      first!.prompt.indexOf("HELD_REPLY_TWO"),
    );
    expect(first?.prompt).not.toContain("HELD_REPLY_INTRUDER");
    expect(listPendingLinearTurns(f.db, "session")).toEqual([]);
    await f.orchestrator.shutdown();
    await running.catch(() => undefined);
  } finally {
    await f.close();
    recorder.close();
  }
});

test("Stop before sign-in discards the creator's held replies", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    expect(await f.orchestrator.onLinearEvent(heldReply(f, "first", "member", "Held reply"))).toBe(
      false,
    );
    expect(listPendingLinearTurns(f.db, "session")).toHaveLength(1);
    f.clock.advance(1_000);
    await f.orchestrator.onLinearEvent({
      ...f.event,
      dedupeKey: "activity:stop",
      deliveryId: "delivery:stop",
      action: "prompted",
      activityId: "stop",
      actorId: "member",
      signal: "stop",
      updatedAtMs: f.clock.now(),
    });
    expect(listPendingLinearTurns(f.db, "session")).toEqual([]);
    expect(
      f.db.query("SELECT state FROM linear_turn WHERE event_key='activity:first'").get(),
    ).toEqual({ state: "cancelled" });
    expect((await f.begin(link)).status).toBe(404);
    expect(f.calls).toBe(0);
  } finally {
    await f.close();
  }
});

test("revoked members cannot sign in or delegate while Linear still considers them active; restore permits sign-in", async () => {
  const f = fixture();
  try {
    linkMember(f);
    changeWorkspaceRevocation(f.db, {
      workspaceId: "workspace",
      actorId: "owner",
      userId: "member",
      revoked: true,
      now: f.clock.now(),
    });
    const denied = await f.callback(await f.begin(`${f.origin}/auth/linear`));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: WORKSPACE_REVOKED_SIGN_IN });
    expect(await f.assignments.authorize(f.event)).toEqual({
      outcome: "refused",
      reason: WORKSPACE_REVOKED_RESPONSE,
      response: true,
    });
    await acknowledgeNewSession(f.tracker, f.event, (event) => f.orchestrator.onLinearEvent(event));
    expect(listWorkItems(f.db)).toHaveLength(0);
    expect(f.tracker.progress.slice(1).map((update) => [update.kind, update.body])).toEqual([
      ["response", WORKSPACE_REVOKED_RESPONSE],
    ]);
    expect(workspaceLinearMember(f.db, "workspace", "member")?.revokedAt).not.toBeNull();
    changeWorkspaceRevocation(f.db, {
      workspaceId: "workspace",
      actorId: "owner",
      userId: "member",
      revoked: false,
      now: f.clock.now(),
    });
    expect((await f.callback(await f.begin(`${f.origin}/auth/linear`))).status).toBe(303);
  } finally {
    await f.close();
  }
});
