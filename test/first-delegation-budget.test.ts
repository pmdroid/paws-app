import { createHmac, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { FakeScript } from "../src/acp/testing/script";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  consumeWorkspaceBootstrap,
  getRunnerSetupHold,
  listOutbox,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
} from "../src/db";
import { createFakeGitHub } from "../src/github";
import {
  cacheLinearMemberships,
  currentLinearCaller,
  handleLinearWebhook,
  linearCallerFor,
  openLinear,
} from "../src/linear";
import { attachOrchestrator, LinearTaskAccess, type AgentLaunch } from "../src/loop";
import {
  itemOwnerEligibleRunner,
  itemOwnerHasEligibleRunner,
  itemOwnerRunnerSetupNeed,
} from "../src/runner-placement";
import { startServer } from "../src/server";
import {
  createWorkspaceAccess,
  createWorkspaceAssignments,
  issueWorkspaceBootstrap,
  workspaceTokenHash,
} from "../src/workspace";
import { emptyReview, githubClient, repoLayout } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const ORIGIN = "https://paws.example.invalid";
const RUNNERS_URL = `${ORIGIN}/status/runners`;
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };

type Membership = { active: boolean; guest: boolean; teamIds: string[] };

/**
 * A Linear API that counts every request it answers: app-token GraphQL, the user's OAuth code
 * exchange and the user's identity read. `item` counts what the ledger attributed to ENG-1.
 */
function countingLinear() {
  const issue = {
    id: "issue",
    identifier: "ENG-1",
    title: "Write ok.txt",
    description: "Create ok.txt.",
    url: "https://linear.app/eng/issue/ENG-1",
    team: { id: "team", name: "Engineering" },
    project: null,
    assignee: { id: "newbie", name: "Nova Newbie" },
    delegate: { id: "app", name: "Paws" } as { id: string; name: string } | null,
    state: { id: "todo", name: "Todo", type: "unstarted" },
    priority: 0,
  };
  const membership: Membership = { active: true, guest: false, teamIds: ["team"] };
  const page = { pageInfo: { hasNextPage: false, endCursor: null } };
  const operations: string[] = [];
  const answer = (operation: string, variables: Record<string, unknown>): unknown => {
    switch (operation) {
      case "PawsSessionInstallation":
        return {
          viewer: { id: "app", app: true, organization: { id: "org" } },
          agentSession: {
            id: variables["id"],
            appUser: { id: "app", app: true, organization: { id: "org" } },
            issue: { id: issue.id, team: issue.team },
          },
        };
      case "PawsBrowserMembership":
        return {
          viewer: { app: true, organization: { id: "org" } },
          user: {
            id: variables["id"],
            active: membership.active,
            guest: membership.guest,
            admin: false,
            organization: { id: "org" },
            teams: { nodes: membership.teamIds.map((id) => ({ id })), ...page },
          },
        };
      case "PawsBrowserIdentity":
        return {
          viewer: {
            id: "newbie",
            name: "Nova Newbie",
            email: "nova@example.invalid",
            app: false,
            admin: false,
            active: true,
            guest: false,
            organization: { id: "org", name: "Workspace" },
          },
        };
      case "IssueStart":
        return {
          issue: {
            ...issue,
            team: { id: issue.team.id, states: { nodes: [{ id: "doing", position: 1 }], ...page } },
            labels: { nodes: [] },
            children: { nodes: [], ...page },
            relations: { nodes: [], ...page },
            inverseRelations: { nodes: [], ...page },
          },
          user: { id: variables["actor"], app: false },
        };
      case "PawsTeamAccess":
        return { team: { id: variables["id"] } };
      case "IssueOwnership":
        return { issue };
      case "CodeTaskActor":
        return { user: { id: variables["id"], app: false } };
      case "StartedWorkflowStates":
        return { team: { states: { nodes: [{ id: "doing", position: 1 }], ...page } } };
      case "StartDelegatedIssue":
        issue.state = { id: "doing", name: "In Progress", type: "started" };
        return { issueUpdate: { success: true } };
      case "IssueSnapshot":
        return { issue: { ...issue, children: { nodes: [], ...page } } };
      case "IssueRelations":
        return {
          issue: {
            id: issue.id,
            relations: { nodes: [], ...page },
            inverseRelations: { nodes: [], ...page },
          },
        };
      case "PawsAgentSession":
        return {
          agentSession: {
            id: variables["id"],
            status: "active",
            createdAt: "2026-10-23T09:00:00.000Z",
            updatedAt: "2026-10-23T09:00:00.000Z",
            endedAt: null,
            dismissedAt: null,
            summary: null,
            plan: null,
            context: null,
            appUser: { id: "app" },
            creator: { id: "newbie" },
            issue,
            comment: null,
            sourceComment: null,
            externalLinks: [],
            pullRequest: null,
          },
        };
      case "PawsAgentSessionHistory":
        return { agentSession: { id: variables["id"], activities: { nodes: [], ...page } } };
      case "PawsIssueContext":
        return {
          issue: {
            ...issue,
            updatedAt: "2026-10-23T09:00:00.000Z",
            reactions: [],
            comments: { nodes: [], ...page },
          },
        };
      case "PawsMergeContext":
        return { issue: { project: null, labels: { nodes: [] } } };
      case "PawsIssueAttribution":
        return {
          viewer: { app: true, organization: { id: "org" } },
          issue: { id: issue.id, team: issue.team, project: null },
        };
      case "AgentActivityByCallerId":
        return { agentActivities: { nodes: [], pageInfo: { hasNextPage: false } } };
      case "AgentActivityCreate": {
        const input = variables["input"] as { id?: string };
        return {
          agentActivityCreate: { success: true, agentActivity: { id: input.id ?? "activity" } },
        };
      }
      case "AgentActivityWithSessionUpdate": {
        const input = variables["input"] as { id?: string };
        return {
          agentActivityCreate: { success: true, agentActivity: { id: input.id ?? "activity" } },
          agentSessionUpdate: { success: true, agentSession: { id: variables["id"] } },
        };
      }
      case "AgentSessionUpdate":
        return { agentSessionUpdate: { success: true, agentSession: { id: variables["id"] } } };
      case "IssueStates":
        return {
          issue: {
            team: {
              states: {
                nodes: [
                  { id: "doing", name: "In Progress", type: "started" },
                  { id: "done", name: "Done", type: "completed" },
                ],
              },
            },
          },
        };
      case "IssueUpdate":
        return { issueUpdate: { success: true } };
      default:
        throw new Error(`Unexpected Linear operation ${operation}`);
    }
  };
  return {
    issue,
    membership,
    operations,
    /** Every request so far, and the ones the ledger attributed to ENG-1. */
    get total() {
      return operations.length;
    },
    item: 0,
    async fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
      const target = String(url);
      if (!target.startsWith("https://api.linear.app/"))
        throw new Error(`Unexpected request ${target}`);
      if (target === "https://api.linear.app/oauth/token") {
        operations.push("oauth:token");
        return Response.json({ access_token: "user-token" });
      }
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
      operations.push(operation);
      if (currentLinearCaller().item === "ENG-1") this.item += 1;
      return Response.json({ data: answer(operation, variables ?? {}) });
    },
  };
}

function signed(body: Record<string, unknown>, delivery: string): Request {
  const raw = JSON.stringify({ ...scope, webhookTimestamp: Date.now(), ...body });
  return new Request("http://localhost/webhook", {
    method: "POST",
    body: raw,
    headers: {
      "linear-signature": createHmac("sha256", "secret").update(raw).digest("hex"),
      "linear-delivery": delivery,
    },
  });
}

/** One online runner owned by `ownerId`, with both agents signed in. */
function addRunner(db: Database, id: string, ownerId: string, now: number) {
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'workspace',?,?,'active',?,?)",
    [id, ownerId, id, now, now],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,1)", [id]);
  for (const agent of ["claude", "codex"])
    db.run("INSERT INTO runner_agent_policy(runner_id,agent,ready) VALUES(?,?,1)", [id, agent]);
}

async function firstDelegation(
  options: { afterSignIn?: (linear: ReturnType<typeof countingLinear>) => void } = {},
) {
  const layout = await repoLayout("paws-first-delegation-");
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const clock = new FakeClock(Date.now());
  const now = () => clock.now();
  const server = countingLinear();
  const owner = putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    userId: owner,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now())),
    now: now(),
  });
  // The owner's runner is online and free the whole time. Nova may not use it.
  addRunner(db, "owners", owner, now());
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const github = createFakeGitHub();
  let gate: LinearTaskAccess | undefined;
  let orchestrator: ReturnType<typeof attachOrchestrator> | undefined;
  const linear = openLinear({
    db,
    secretsDir: path.join(layout.pawsRoot, "secrets"),
    env: { LINEAR_ACCESS_TOKEN: "fixture-token", LINEAR_CLIENT_ID: "client" },
    fetch: server.fetch.bind(server),
    beforeEvent: (event, request) => gate!.accept(event, request),
    followUp: (event) => orchestrator!.onLinearEvent(event),
    progressReporter: (event) => orchestrator!.sessionProgressReporter(event),
  });
  gate = new LinearTaskAccess(db, {
    access: linearCallerFor(linear.access!, "task-access"),
    lifecycle: linearCallerFor(linear.issueLifecycle!, "task-access"),
    oauthClientId: "client",
    appUserId: "app",
    stopSession: () => {},
  });
  // As `src/index.ts` wires them for a public dashboard.
  const assignments = createWorkspaceAssignments({
    db,
    origin: ORIGIN,
    clientId: "client",
    memberships: cacheLinearMemberships(linear.memberships!, now),
    resumeMemberships: linear.memberships!,
    lifecycle: linear.issueLifecycle!,
    tracker: linear.tracker!,
    accept: (event, signal) => gate!.accept(event, { signal }),
    continue: (event) => orchestrator!.onLinearEvent(event),
    now,
  });
  assignments.register(jobs);
  const access = createWorkspaceAccess({
    db,
    assignments,
    publicUrl: ORIGIN,
    clientId: "client",
    installedOrganization: { id: "org", name: "Workspace" },
    memberships: linear.memberships!,
    now,
    log: () => {},
    fetch: server.fetch.bind(server) as typeof fetch,
  });
  let sequence = 0;
  const launch: AgentLaunch = (agent) => {
    sequence += 1;
    const steps: FakeScript["steps"] =
      agent.purpose === "classify"
        ? [
            {
              type: "update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: '{"mode":"code"}' },
              },
            },
            { type: "end" },
          ]
        : agent.role === "reviewer"
          ? emptyReview().steps
          : agent.purpose === "prepare"
            ? [{ type: "end" }]
            : [
                { type: "fs_write", path: path.join(agent.worktree, "ok.txt"), content: "ok\n" },
                { type: "end" },
              ];
    const script = path.join(layout.root, `script-${sequence}.json`);
    writeFileSync(
      script,
      JSON.stringify({
        model: agent.role === "reviewer" ? "test-codex-model" : "test-claude-model",
        steps,
      }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, path.join(layout.root, `result-${sequence}.json`), script],
      env: process.env,
    };
  };
  orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    clock,
    tracker: linear.tracker,
    secretsDir: path.join(layout.pawsRoot, "secrets"),
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
    githubForRepository: () => ({
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(layout.bare, github),
    }),
    launch,
    linearTaskModes: true,
    linearAccess: gate,
    runnersUrl: RUNNERS_URL,
    ownerHasRunner: (itemId, agent, at) =>
      itemOwnerHasEligibleRunner(db, { itemId, agent, now: at }),
    runnerSetupNeed: (itemId, agent, at) =>
      itemOwnerRunnerSetupNeed(db, { itemId, agent, now: at }),
    eligibleRunner: (itemId, agent, at) => itemOwnerEligibleRunner(db, { itemId, agent, now: at }),
    authorizeLinearEvent: async (event) =>
      (await access.authorizeLinearEvent(event))
        ? assignments.authorize(event)
        : { outcome: "refused", reason: "Only workspace members may delegate." },
    recheckLinearEvent: async (event) =>
      access.recheckLinearEvent(event) && assignments.recheck(event),
    authorizeLinearIntake: (sessionId, spec) => assignments.authorizeIntake(sessionId, spec),
  });
  const health = startServer({
    port: 0,
    hostname: "127.0.0.1",
    webhooks: false,
    linearUsage: () => linear.usage(),
  });
  const state = () => listWorkItems(db)[0]?.state ?? null;
  /** Runs every due job and outbox row, then lets `minutes` of fake time pass with nothing due. */
  const settle = async (minutes = 1) => {
    for (let minute = 0; minute < minutes; minute++) {
      // Runners heartbeat on their own; that is a database write, not a Linear request.
      db.run("UPDATE runner SET last_seen_at=?", [clock.now()]);
      for (;;) {
        while (outbox.tick().length > 0) await outbox.idle();
        if ((await jobs.tick()) === null) break;
      }
      clock.advance(60_000);
      await Bun.sleep(1);
    }
  };
  try {
    // 1. An unknown Linear user delegates ENG-1.
    const response = await handleLinearWebhook(
      signed(
        {
          type: "AgentSessionEvent",
          action: "created",
          createdAt: new Date().toISOString(),
          agentSession: {
            ...scope,
            id: "session",
            creatorId: "newbie",
            creator: { id: "newbie", name: "Nova Newbie" },
            issue: {
              id: "issue",
              identifier: "ENG-1",
              title: "Write ok.txt",
              description: "Create ok.txt.",
              team: { id: "team" },
            },
          },
          promptContext: '<issue identifier="ENG-1"><title>Write ok.txt</title></issue>',
        },
        "created-delivery",
      ),
      "secret",
      linear.webhook,
    );
    expect(response.status).toBe(200);
    await linear.webhook.intake!.idle();
    await settle();
    const elicitation = listOutbox(db).find((row) => row.op === "elicitation");
    expect(elicitation, server.operations.join(", ")).toBeDefined();
    const held = server.total;

    // 2. Waiting most of the link's day for sign-in costs nothing.
    await settle(60);
    clock.advance(22 * 60 * 60_000);
    await settle(2);
    const waitingForSignIn = server.total - held;

    // 3. The delegator follows the link and signs in with Linear.
    const link = (elicitation!.payload as { auth: { url: string } }).auth.url;
    const start = (await access.handle(new Request(link)))!;
    expect(start.status).toBe(303);
    const provider = new URL(start.headers.get("location")!);
    const callback = (await access.handle(
      new Request(
        `${ORIGIN}/auth/linear/callback?state=${provider.searchParams.get("state")}&code=code`,
        { headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! } },
      ),
    ))!;
    expect(callback.status, await callback.clone().text()).toBe(303);
    const signedIn = server.total;
    options.afterSignIn?.(server);

    // 4. The hold resumes and intake runs. Nova has no runner yet.
    await settle(2);
    const resumed = server.total;
    const item = listWorkItems(db)[0];
    if (item === undefined)
      return {
        server,
        refused: true as const,
        resume: resumed - signedIn,
        errors: listOutbox(db)
          .map((row) => row.payload as { kind?: string; body?: string })
          .filter((payload) => payload.kind === "error")
          .map((payload) => payload.body),
        hold: db.query("SELECT status FROM workspace_assignment").get(),
        delivered: db
          .query<{ status: string }, []>(
            "SELECT status FROM outbox WHERE json_extract(payload,'$.kind')='error'",
          )
          .all()
          .map((row) => row.status),
      };
    expect(getRunnerSetupHold(db, item.id), server.operations.join(", ")).toMatchObject({
      reason: "no-runner",
    });

    // 5. Waiting a day for a runner costs nothing.
    await settle(60);
    clock.advance(23 * 60 * 60_000);
    await settle(2);
    const waitingForRunner = server.total - resumed;

    // 6. Nova's runner comes online; the task starts, runs, opens its PR and merges.
    addRunner(
      db,
      "novas",
      db
        .query<{ owner: string }, [string]>(
          "SELECT owner_user_id AS owner FROM work_item WHERE id=?",
        )
        .get(item.id)!.owner,
      clock.now(),
    );
    const deadline = Date.now() + 20_000;
    while (!["merged", "failed", "cancelled"].includes(state() ?? "")) {
      if (Date.now() > deadline) throw new Error(`The task is stuck in ${state()}`);
      await settle();
    }
    while (outbox.tick().length > 0) await outbox.idle();
    const reported = (await (await fetch(`http://127.0.0.1:${health.port}/health`)).json()) as {
      linear: { items: { item: string; requests: number }[] };
    };
    return {
      server,
      refused: false as const,
      state: state(),
      phases: {
        hold: held,
        waitingForSignIn,
        signIn: signedIn - held - waitingForSignIn,
        resume: resumed - signedIn,
        waitingForRunner,
        run: server.total - resumed - waitingForRunner,
      },
      health: reported.linear.items,
      pullRequest: github.opened.length,
    };
  } finally {
    await health.stop(true);
    await access.stop();
    await orchestrator.shutdown();
    await outbox.idle();
    db.close();
    await layout.cleanup();
  }
}

test("a first delegation from an unknown user stays within 30 Linear requests, and waiting costs none", async () => {
  const result = await firstDelegation();
  expect(result.refused).toBe(false);
  if (result.refused) return;
  const operations = result.server.operations.join("\n");
  expect(result.state, operations).toBe("merged");
  expect(result.pullRequest).toBe(1);
  expect(result.phases.waitingForSignIn, operations).toBe(0);
  expect(result.phases.waitingForRunner, operations).toBe(0);
  expect(result.server.total, JSON.stringify(result.phases)).toBeLessThanOrEqual(30);
  // The hold: the session, issue, epic and membership, the access check's issue read, the first
  // activity and the one sign-in action. The resume reuses the stored snapshot and re-reads only
  // the issue and the membership, then says once that Nova has no runner.
  expect(result.phases, operations).toEqual({
    hold: 7,
    waitingForSignIn: 0,
    signIn: 3,
    resume: 3,
    waitingForRunner: 0,
    run: 17,
  });
  // /health counts every app request toward ENG-1. Only the delegator's own OAuth code exchange
  // and identity read, made with their token, are outside the app's ledger.
  expect(result.server.item).toBe(result.server.total - 2);
  expect(result.health).toEqual([{ item: "ENG-1", requests: result.server.item }]);
}, 60_000);

for (const [change, reason, apply] of [
  [
    "the issue is reassigned",
    "This issue changed while Paws waited for you to sign in.",
    (linear: ReturnType<typeof countingLinear>) =>
      (linear.issue.assignee = { id: "someone", name: "Someone Else" }),
  ],
  [
    "the issue is closed",
    "This issue changed while Paws waited for you to sign in.",
    (linear: ReturnType<typeof countingLinear>) =>
      (linear.issue.state = { id: "done", name: "Done", type: "completed" }),
  ],
  [
    "the delegator leaves the issue's team",
    "You are not a member of this issue's Linear team.",
    (linear: ReturnType<typeof countingLinear>) => (linear.membership.teamIds = []),
  ],
  [
    "the delegator's Linear account is deactivated",
    "Your Linear account is not active.",
    (linear: ReturnType<typeof countingLinear>) => (linear.membership.active = false),
  ],
] as const)
  test(`when ${change} between sign-in and resume, the resume refuses and says why`, async () => {
    const result = await firstDelegation({ afterSignIn: apply });
    expect(result.refused).toBe(true);
    if (!result.refused) return;
    // The issue and membership re-check, then the one refusal.
    expect(result.errors).toEqual([`Paws did not start this work. ${reason}`]);
    expect(result.delivered).toEqual(["sent"]);
    // The issue re-check (and the membership re-check when the issue is unchanged), then the one
    // error activity after the delivery access check.
    expect(result.resume, result.server.operations.join("\n")).toBe(
      reason.startsWith("This issue") ? 5 : 6,
    );
    expect(result.hold).toEqual({ status: "invalid" });
  }, 30_000);
