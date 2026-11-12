import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { rmSync } from "node:fs";
import { createGitHubInstallationCheck, createGitHubTokenProvider } from "../src/auth";
import {
  FakeClock,
  appBotCommitIdentity,
  policyCoauthors,
  type GitCommitPolicy,
} from "../src/core";
import { pawsPaths } from "../src/config";
import * as dbApi from "../src/db";
import { saveRunCommitPolicy, syncSteps } from "../src/db";
import { INSTALLATION_PERMISSIONS } from "../src/github";
import {
  createFakeTracker,
  type AcceptedLinearEvent,
  type LinearSessionSnapshot,
} from "../src/linear";
import { attachOrchestrator, GitHubInstallationCheck } from "../src/loop";
import * as workspace from "../src/workspace";
import { migratedHome } from "./helpers";

test("onboarded authoritative creator resumes once with current App and no personal GitHub consent", async () => {
  const root = await migratedHome();
  const reopen = () => dbApi.openPawsStore({ url: null, pgliteDir: pawsPaths(root).pgliteDir });
  let database = await reopen();
  let db = database.store;
  const clock = new FakeClock(Date.now());
  const now = () => clock.now();
  const origin = "https://paws.example.invalid";
  const owner = await dbApi.putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await dbApi.consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    userId: owner,
    tokenHash: workspace.workspaceTokenHash(
      await workspace.issueWorkspaceBootstrap(db, "org", now()),
    ),
    now: now(),
  });
  await dbApi.ensureLinearSession(db, { sessionId: "session", issueId: "issue" });
  await dbApi.recordLinearInstallation(db, {
    sessionId: "session",
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    observedAtMs: now(),
  });
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "JOIN-1",
      title: "Joined work",
      description: "Build it",
      subIssues: [],
    },
  ]);
  const session: LinearSessionSnapshot = {
    id: "session",
    status: "active",
    createdAt: new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString(),
    endedAt: null,
    dismissedAt: null,
    appUserId: "app",
    creatorId: "creator",
    issue: { id: "issue", identifier: "JOIN-1", title: "Joined work", description: "Build it" },
    comment: null,
    sourceComment: null,
    summary: null,
    plan: null,
    context: null,
    externalLinks: [],
    pullRequest: null,
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
    updatedAtMs: now(),
    payload: JSON.stringify({
      organizationId: "org",
      appUserId: "app",
      agentSession: { creatorId: "creator" },
    }),
  };
  const active = true;
  const memberships = {
    async installation() {
      return { id: "org", name: "Workspace" };
    },
    async member(organizationId: string, userId: string) {
      return { organizationId, userId, active, guest: false, admin: false, teamIds: ["team"] };
    },
  };
  let continuations = 0;
  const build = () => {
    const assignments = workspace.createWorkspaceAssignments({
      store: db,
      origin,
      clientId: "client",
      memberships,
      now,
      lifecycle: {
        async inspect() {
          return {
            id: "issue",
            teamId: "team",
            assigneeId: "owner",
            delegateId: "app",
            stateType: "started",
          };
        },
        async startCodeIssue() {
          throw new Error("Unexpected execution");
        },
      },
      tracker: {
        ...tracker,
        async getSession() {
          return structuredClone(session);
        },
      },
      async accept() {
        return true;
      },
      async continue(incoming) {
        expect(await access.authorizeLinearEvent(incoming)).toBe(true);
        expect(await assignments.authorize(incoming)).toEqual({ outcome: "accepted" });
        await orchestrator.onLinearEvent(incoming);
        continuations++;
      },
    });
    const access = workspace.createWorkspaceAccess({
      store: db,
      assignments,
      publicUrl: origin,
      clientId: "client",
      installedOrganization: { id: "org", name: "Workspace" },
      memberships,
      now,
      fetch: (async (input) => {
        if (String(input) === "https://api.linear.app/oauth/token")
          return Response.json({ access_token: "synthetic-linear" });
        expect(String(input)).toBe("https://api.linear.app/graphql");
        return Response.json({
          data: {
            viewer: {
              id: "creator",
              name: "Creator",
              email: "creator@example.invalid",
              app: false,
              organization: { id: "org", name: "Workspace" },
            },
          },
        });
      }) as typeof fetch,
    });
    const orchestrator = attachOrchestrator({
      store: db,
      jobs: new dbApi.JobLoop(db, clock),
      outbox: new dbApi.OutboxDispatcher(db, clock),
      pawsRoot: root,
      tracker,
      clock,
      authorizeLinearEvent: async (incoming) =>
        (await access.authorizeLinearEvent(incoming))
          ? await assignments.authorize(incoming)
          : { outcome: "refused", reason: "denied" },
      authorizeLinearIntake: (q, id, spec) => assignments.authorizeIntakeSteps(q, id, spec),
      launch: () => {
        throw new Error("Unexpected agent launch");
      },
    });
    return { assignments, access, orchestrator };
  };
  let runtime = build();
  let auth: GitHubInstallationCheck | undefined;
  try {
    expect(await runtime.assignments.authorize(event)).toMatchObject({ outcome: "refused" });
    expect(
      await runtime.assignments.authorize({ ...event, deliveryId: "duplicate" }),
    ).toMatchObject({ outcome: "refused" });
    expect(await dbApi.workspaceLinearMember(db, "workspace", "creator")).toBeNull();
    expect(await dbApi.listWorkItems(db)).toHaveLength(0);
    expect(await dbApi.listOutbox(db)).toHaveLength(1);
    const prompt = (await dbApi.listOutbox(db))[0]!.payload as {
      auth: { url: string; userId: string };
    };
    expect(prompt.auth.userId).toBe("creator");
    const started = (await runtime.access.handle(new Request(prompt.auth.url)))!;
    expect(started.status).toBe(303);
    const provider = new URL(started.headers.get("location")!);
    expect(provider.searchParams.get("actor")).toBe("user");
    await runtime.access.stop();
    await runtime.orchestrator.shutdown();
    await database.close();
    database = await reopen();
    db = database.store;
    runtime = build();
    const callback = () =>
      runtime.access.handle(
        new Request(
          `${origin}/auth/linear/callback?state=${provider.searchParams.get("state")}&code=creator`,
          {
            headers: { cookie: started.headers.get("set-cookie")!.split(";")[0]! },
          },
        ),
      );
    expect((await callback())!.status).toBe(303);
    expect((await callback())!.status).toBe(400);
    const jobs = new dbApi.JobLoop(db, clock);
    runtime.assignments.register(jobs);
    await jobs.tick();
    await jobs.tick();
    expect(
      (await dbApi.listJobs(db))
        .filter((job) => job.queue === "workspace.assignment")
        .map((job) => job.lastError),
    ).toEqual([null]);
    expect(continuations).toBe(1);
    expect(await dbApi.listWorkItems(db)).toHaveLength(1);
    const itemId = (await dbApi.listWorkItems(db))[0]!.id;
    expect(await dbApi.delegatedLinearUserId(db, itemId)).toBe("creator");
    expect(
      await db.run((q) =>
        q.all(
          q.orm
            .select()
            .from(q.t.workspaceAccessAudit)
            .where(eq(q.t.workspaceAccessAudit.action, "assignment.resumed")),
        ),
      ),
    ).toHaveLength(1);
    expect(await runtime.assignments.authorize(event)).toMatchObject({ outcome: "refused" });
    await dbApi.beginImplementRun(db, itemId, now());
    const current = async () => (await dbApi.getWorkItem(db, itemId))!;
    const privateKeyPem = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    let generation = 1;
    let installed = false;
    let rotateDuringCheck = false;
    const app = () => ({
      appId: "99",
      clientId: "app-client",
      clientSecret: "synthetic",
      installationId: "22",
      privateKeyPem,
      generation,
    });
    const requests: string[] = [];
    const githubFetch: typeof fetch = (async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.github.com");
      requests.push(url.pathname);
      if (url.pathname === "/app")
        return Response.json({ id: 99, client_id: "app-client", slug: "paws-test" });
      if (url.pathname === "/repos/acme/widgets/installation")
        return Response.json({ id: 22 }, { status: installed ? 200 : 404 });
      if (url.pathname === "/app/installations/22/access_tokens") {
        if (rotateDuringCheck) {
          generation++;
          rotateDuringCheck = false;
        }
        return Response.json(
          {
            token: "synthetic-installation",
            expires_at: new Date(Date.now() + 1800_000).toISOString(),
            repository_selection: "selected",
            repositories: [{ name: "widgets", full_name: "acme/widgets" }],
            permissions: INSTALLATION_PERMISSIONS,
          },
          { status: 201 },
        );
      }
      if (decodeURIComponent(url.pathname) === "/users/paws-test[bot]")
        return Response.json({ id: 88, login: "paws-test[bot]", type: "Bot" });
      throw new Error(`Unexpected provider request ${url.pathname}`);
    }) as typeof fetch;
    const installation = createGitHubInstallationCheck({
      home: root,
      env: {},
      resolve: async () => app(),
      fetch: githubFetch,
    });
    const botProvider = createGitHubTokenProvider({
      auth: "app",
      repo: "acme/widgets",
      ...app(),
      fetch: githubFetch,
    });
    const policy = async (): Promise<GitCommitPolicy> => ({
      bot: await botProvider.botIdentity!(),
      credit: await workspace.delegatorCommitCredit(db, (await current()).id),
    });
    auth = new GitHubInstallationCheck(
      db,
      {
        check: (_item, signal) => installation("acme/widgets", "write", signal),
        administrators: () => syncSteps(() => ["owner"]),
        recoveryUrl: `${origin}/status`,
        identity: () => syncSteps(() => "creator:acme/widgets"),
      },
      now,
    );
    const signal = new AbortController().signal;
    expect(await auth.ensure(await current(), "initial", signal)).toBe(false);
    expect((await current()).state).toBe("awaiting_input");
    installed = true;
    rotateDuringCheck = true;
    expect(await installation("acme/widgets", "write", signal)).toBe(false);
    await auth.recover();
    expect((await current()).state).toBe("running");
    expect(policyCoauthors(await policy())).toEqual([]);
    expect((await dbApi.listJobs(db)).filter((job) => job.queue === "run.resume")).toHaveLength(1);
    const member = (await dbApi.workspaceLinearMember(db, "workspace", "creator"))!;
    const login = await workspace.issueWorkspaceSession(db, {
      workspaceId: "workspace",
      userId: member.userId,
      now: now(),
    });
    const binding = {
      workspaceId: "workspace",
      userId: member.userId,
      sessionHash: login.session.tokenHash,
    };
    const request = { stateHash: "synthetic-state", browserHash: "synthetic-browser", now: now() };
    await dbApi.beginGitHubAttribution(db, binding, request);
    const { revision } = await dbApi.consumeGitHubAttributionRequest(db, binding, request);
    await dbApi.saveGitHubAttribution(
      db,
      binding,
      {
        id: 7,
        login: "creator",
        name: "Creator",
        email: "7+creator@users.noreply.github.com",
      },
      revision,
      now(),
    );
    await Promise.all([auth.recover(), auth.recover()]);
    await auth.recover();
    expect((await current()).state).toBe("running");
    expect((await dbApi.listJobs(db)).filter((job) => job.queue === "run.resume")).toHaveLength(1);
    const captured = await policy();
    expect(appBotCommitIdentity(captured.bot)).toEqual({
      name: "Paws",
      email: "88+paws-test[bot]@users.noreply.github.com",
    });
    expect(policyCoauthors(await policy())).toEqual([
      { id: 7, login: "creator", name: "Creator", email: "7+creator@users.noreply.github.com" },
    ]);
    await saveRunCommitPolicy(db, (await current()).currentRunId!, captured);
    expect(
      (await dbApi.getRun(db, (await current()).currentRunId!))!.checkpoint!.commitPolicy,
    ).toEqual(captured);
    await dbApi.revokeGitHubAttribution(
      db,
      { workspaceId: "workspace", userId: member.userId, sessionHash: login.session.tokenHash },
      now(),
    );
    expect(policyCoauthors(await policy())).toEqual([]);
    expect(await auth.ensure(await current(), "publication", signal)).toBe(true);
    await auth.recover();
    expect((await current()).state).toBe("running");
    expect((await dbApi.listJobs(db)).filter((job) => job.queue === "run.reverify")).toHaveLength(
      0,
    );
    expect(requests).toContain("/app/installations/22/access_tokens");
    expect(requests).not.toContain("/user");
  } finally {
    auth?.close();
    await runtime.access.stop();
    await runtime.orchestrator.shutdown();
    await database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
