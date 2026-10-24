import { generateKeyPairSync, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, migrate, openDatabase } from "../src/db";
import { createFakeGitHub } from "../src/github";
import { handleLinearWebhook, linearCallerFor, openLinear } from "../src/linear";
import { attachOrchestrator, LinearTaskAccess, type AgentLaunch } from "../src/loop";
import { githubClient, repoLayout } from "./e2e-harness";

const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
function linearServer() {
  const issue = {
    id: "issue",
    identifier: "ENG-1",
    title: "Write ok.txt",
    description: "Create ok.txt.",
    url: "https://linear.app/eng/issue/ENG-1",
    team: { id: "team" },
    project: null,
    assignee: { id: "pascal", name: "Pascal" },
    delegate: { id: "app", name: "Paws" } as { id: string; name: string } | null,
    state: { id: "todo", name: "Todo", type: "unstarted" },
    priority: 0,
  };
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
      case "IssueStart":
        return {
          issue: {
            ...issue,
            team: {
              id: issue.team.id,
              states: {
                nodes: [{ id: "doing", position: 1 }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
            labels: { nodes: [] },
            children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
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
        return {
          team: {
            states: {
              nodes: [{ id: "doing", position: 1 }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      case "StartDelegatedIssue":
        issue.state = { id: "doing", name: "In Progress", type: "started" };
        return { issueUpdate: { success: true } };
      case "IssueSnapshot":
        return {
          issue: {
            ...issue,
            children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      case "IssueRelations":
        return {
          issue: {
            id: issue.id,
            relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
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
            creator: { id: "pascal" },
            issue,
            comment: null,
            sourceComment: null,
            externalLinks: [],
            pullRequest: null,
          },
        };
      case "PawsAgentSessionHistory":
        return {
          agentSession: {
            id: variables["id"],
            activities: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      case "PawsIssueContext":
        return {
          issue: {
            ...issue,
            updatedAt: "2026-10-23T09:00:00.000Z",
            reactions: [],
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      case "PawsMergeContext":
        return { issue: { project: null, labels: { nodes: [] } } };
      case "AgentActivityByCallerId":
        return { agentActivities: { nodes: [], pageInfo: { hasNextPage: false } } };
      case "AgentActivityCreate": {
        const input = variables["input"] as { id?: string };
        return {
          agentActivityCreate: { success: true, agentActivity: { id: input.id ?? "activity" } },
        };
      }
      case "AgentSessionUpdate":
        return { agentSessionUpdate: { success: true, agentSession: { id: variables["id"] } } };
      default:
        throw new Error(`Unexpected Linear operation ${operation}`);
    }
  };
  return {
    operations,
    async fetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
      operations.push(operation);
      return Response.json({ data: answer(operation, variables ?? {}) });
    },
  };
}

test("a delegated task reads each Linear fact once before the agent's first prompt", async () => {
  const layout = await repoLayout("paws-start-budget-");
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const server = linearServer();
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const github = createFakeGitHub();
  let gate: LinearTaskAccess | undefined;
  let orchestrator: ReturnType<typeof attachOrchestrator> | undefined;
  const firstPrompt = Promise.withResolvers<Record<string, number>>();
  const linear = openLinear({
    db,
    secretsDir: path.join(layout.pawsRoot, "secrets"),
    env: { LINEAR_ACCESS_TOKEN: "fixture-token", LINEAR_CLIENT_ID: "client" },
    publicUrl: null,
    fetch: server.fetch,
    beforeEvent: (event, request) => gate!.accept(event, request),
    followUp: (event) => orchestrator!.onLinearEvent(event),
    progressReporter: (event) => orchestrator!.sessionProgressReporter(event),
  });
  const requests = () =>
    Object.fromEntries(
      Object.entries(linear.usage().callers)
        .filter(([, usage]) => usage.requests > 0)
        .map(([caller, usage]) => [caller, usage.requests]),
    );
  gate = new LinearTaskAccess(db, {
    access: linearCallerFor(linear.access!, "task-access"),
    lifecycle: linearCallerFor(linear.issueLifecycle!, "task-access"),
    oauthClientId: "client",
    appUserId: "app",
    stopSession: () => {},
  });
  const launch: AgentLaunch = (input) => {
    const message = (text: string): FakeScript["steps"][number] => ({
      type: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
    const steps: FakeScript["steps"] =
      input.purpose === "classify"
        ? [message('{"mode":"code"}'), { type: "end" }]
        : input.purpose === "implement"
          ? [{ type: "hang" }]
          : [];
    if (input.purpose === "implement") firstPrompt.resolve(requests());
    const script = path.join(layout.root, `${input.purpose}.json`);
    writeFileSync(
      script,
      JSON.stringify({
        model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
        steps,
      }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, path.join(layout.root, `${input.purpose}-result.json`), script],
      env: process.env,
    };
  };
  orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    tracker: linear.tracker,
    secretsDir: path.join(layout.pawsRoot, "secrets"),
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: githubClient(layout.bare, github),
    },
    launch,
    linearTaskModes: true,
    linearAccess: gate,
  });
  const raw = JSON.stringify({
    ...scope,
    type: "AgentSessionEvent",
    action: "created",
    createdAt: new Date().toISOString(),
    webhookTimestamp: Date.now(),
    agentSession: {
      ...scope,
      id: "session",
      creatorId: "pascal",
      issue: {
        id: "issue",
        identifier: "ENG-1",
        title: "Write ok.txt",
        description: "Create ok.txt.",
        team: { id: "team" },
      },
    },
    promptContext: '<issue identifier="ENG-1"><title>Write ok.txt</title></issue>',
  });
  let started: Promise<unknown> | undefined;
  try {
    const response = await handleLinearWebhook(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: raw,
        headers: {
          "linear-signature": createHmac("sha256", "secret").update(raw).digest("hex"),
          "linear-delivery": "created-delivery",
        },
      }),
      "secret",
      linear.webhook,
    );
    expect(response.status).toBe(200);
    await linear.webhook.intake!.idle();
    started = jobs.tick();
    const counts = await Promise.race([
      firstPrompt.promise,
      Bun.sleep(20_000).then(() => {
        throw new Error(`No first prompt after ${server.operations.join(", ")}`);
      }),
    ]);
    expect(counts, server.operations.join(", ")).toEqual({
      "task-access": 2,
      outbox: 3,
      "session-read": 1,
      context: 1,
    });
  } finally {
    await orchestrator.shutdown();
    await started;
    await outbox.idle();
    db.close();
    await layout.cleanup();
  }
}, 30_000);
