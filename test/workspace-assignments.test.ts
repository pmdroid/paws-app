import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  syncWorkspaceMember,
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
  issueWorkspaceBootstrap,
  WORKSPACE_COOKIE,
  workspaceTokenHash,
} from "../src/workspace";
import { createOnboardingReadiness } from "../src/onboarding-readiness";

function fixture({ installed = true } = {}) {
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
  let memberRead: (() => Promise<void>) | undefined;
  const memberships = {
    async installation() {
      return { id: "org", name: "Workspace" };
    },
    async member(organizationId: string, userId: string) {
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
          return structuredClone(ownership);
        },
        async startCodeIssue() {
          throw new Error("No credentials or execution before continuation");
        },
      },
      tracker: {
        ...tracker,
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
  let orchestrator = buildOrchestrator();
  function buildOrchestrator() {
    return attachOrchestrator({
      db,
      jobs: new JobLoop(db, clock),
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
      launch: () => {
        throw new Error("No agent may start in the onboarding fixture");
      },
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
      now: () => clock.now(),
      fetch: (async (input, init) => {
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
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("host", new URL(origin).host);
      return (
        (await currentAccess.handle(
          new Request(`${origin}${url.pathname}${url.search}`, { headers, method: request.method }),
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
  async function begin(url = link()) {
    const target = new URL(url);
    return fetch(`${local}${target.pathname}${target.search}`, { redirect: "manual" });
  }
  async function callback(start: Response, user = "member") {
    const provider = new URL(start.headers.get("location")!);
    const url = `${local}/auth/linear/callback?state=${provider.searchParams.get("state")}&code=${user}`;
    return fetch(url, {
      redirect: "manual",
      headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! },
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
    get assignments() {
      return assignments;
    },
    get calls() {
      return calls;
    },
    get sessionReads() {
      return sessionReads;
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
  "observer",
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
      if (change === "observer")
        f.db.run(
          "UPDATE workspace_member SET role='observer',manual_role='observer',source='manual' WHERE user_id<>'owner'",
        );
      const jobs = f.jobs();
      await jobs.tick();
      await jobs.tick();
      expect(f.calls).toBe(0);
      expect(f.continuations).toEqual([]);
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

test("linked members avoid a new-issue sign-in hold while observers and removed members do not", async () => {
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
    f.db.run("UPDATE workspace_member SET role='observer' WHERE user_id='member'");
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
  [
    "guest",
    "Linear guests cannot delegate issues to Paws. Ask a member of Platform to delegate this issue.",
    (f) => f.setGuest(true),
  ],
  ["outside the team", "You are not a member of this issue's Linear team.", (f) => f.setTeams([])],
  [
    "inactive membership",
    "Your Paws workspace membership is not active.",
    (f) => f.db.run("UPDATE workspace_member SET active=0 WHERE user_id='member'"),
  ],
  [
    "observer",
    "Observers in the Paws workspace cannot delegate issues to Paws. Ask a member of Platform to delegate this issue.",
    (f) => f.db.run("UPDATE workspace_member SET role='observer' WHERE user_id='member'"),
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
      '<li class="needed"><span class="mark" aria-hidden="true">3</span><div><h2>Your runner</h2>',
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

test("the creator without a Paws session signs in again and returns to the same page", async () => {
  const f = fixture();
  try {
    await f.assignments.authorize(f.event);
    const link = f.link();
    await f.callback(await f.begin(link));
    const start = await f.begin(link);
    expect(start.status).toBe(303);
    expect(new URL(start.headers.get("location")!).origin).toBe("https://linear.app");
    expect(await start.text()).toBe("");
    const back = await f.callback(start);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(onboardPath(link));
    const page = await fetch(`${f.local}${onboardPath(link)}`, {
      redirect: "manual",
      headers: { cookie: sessionCookie(back) },
    });
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
      const opened = await fetch(`${f.local}${onboardPath(link)}`, {
        redirect: "manual",
        headers,
      });
      expect(opened.status).toBe(303);
      expect(new URL(opened.headers.get("location")!).origin).toBe("https://linear.app");
      expect(await opened.text()).not.toContain("TEST-1");
      const refused = await f.callback(opened, "other");
      expect(refused.status).toBe(403);
      const body = await refused.text();
      expect(body).toContain("This link belongs to Morgan Member.");
      expect(body).not.toContain("TEST-1");
      expect(refused.headers.get("location")).toBeNull();
      expect(
        refused.headers.getSetCookie().some((value) => value.startsWith(`${WORKSPACE_COOKIE}=`)),
      ).toBe(false);
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
