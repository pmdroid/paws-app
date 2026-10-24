import { execFile } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { FakeScript } from "../src/acp/testing/script";
import { FakeClock } from "../src/core";
import { JobLoop, OutboxDispatcher, listWorkItems, migrate, openDatabase } from "../src/db";
import { createEvidenceStore } from "../src/evidence";
import { createFakeGitHub, fakeMergeReadiness } from "../src/github";
import {
  currentLinearCaller,
  handleLinearWebhook,
  linearCallerFor,
  openLinear,
} from "../src/linear";
import { attachOrchestrator, LinearTaskAccess, type AgentLaunch } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import {
  emptyReview,
  githubClient,
  gitIdentity,
  isMergeReadiness,
  repoLayout,
} from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const POLICY = `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test", "check.test.ts"]
    timeoutSeconds: 60
  - id: adversarial-review
    kind: review
    gate: beforePR
    skill: .agents/skills/adversarial-review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
    failOn: P1
  - id: visual-proof
    kind: evidence
    gate: beforePR
    media: [image]
    minimum: 1
    approval: human
    paths: ["shot.png"]
`;
const POLICY_WITHOUT_CHECKS = `specVersion: "0.1"
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test", "check.test.ts"]
    timeoutSeconds: 60
`;

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
  const page = { pageInfo: { hasNextPage: false, endCursor: null } };
  const counts = new Map<string, number>();
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
            creator: { id: "pascal" },
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
      case "FileUpload":
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload",
              assetUrl: "https://uploads.linear.app/workspace/evidence",
              headers: [],
            },
          },
        };
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
    counts,
    async fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
      if (!String(url).includes("api.linear.app")) return new Response(null, { status: 200 });
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
      const { caller, itemId } = currentLinearCaller();
      const key = `${itemId === undefined ? "-" : "item"} ${caller} ${operation}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);

      return Response.json({ data: answer(operation, variables ?? {}) });
    },
  };
}

async function commitOnMain(bare: string, file: string, content: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "paws-main-"));
  try {
    await exec("git", ["clone", bare, dir]);
    await gitIdentity(dir);
    await writeFile(path.join(dir, file), content);
    await exec("git", ["-C", dir, "add", "."]);
    await exec("git", ["-C", dir, "commit", "-m", `update ${file}`]);
    await exec("git", ["-C", dir, "push", "origin", "HEAD:main"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

const session = {
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
};

type Steps = FakeScript["steps"];

function toolCalls(round: number, n = 20): Steps {
  return Array.from({ length: n }, (_, index) => ({
    type: "update" as const,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: `tool-${round}-${index}`,
      title: `Read file ${index}`,
      kind: "read",
      status: "completed",
    },
  }));
}

function write(worktree: string, file: string, content = `${file}\n`): Steps[number] {
  return { type: "fs_write", path: path.join(worktree, file), content };
}

async function runTask(input: {
  policy: string;
  rounds: ((worktree: string, round: number) => Steps)[];
  ciPendingPolls?: number;
  mainMovesAtPoll?: number;
}) {
  const layout = await repoLayout("paws-lifecycle-budget-");
  await commitOnMain(layout.bare, ".agents/closeout.yaml", input.policy);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const clock = new FakeClock(Date.now());
  const server = linearServer();
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const github = createFakeGitHub();
  const client = githubClient(layout.bare, github);
  const heads = new Set<string>();
  let pull: { number: number; html_url: string } | null = null;
  let polls = 0;
  let gate: LinearTaskAccess | undefined;
  let orchestrator: ReturnType<typeof attachOrchestrator> | undefined;
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
  gate = new LinearTaskAccess(db, {
    access: linearCallerFor(linear.access!, "task-access"),
    lifecycle: linearCallerFor(linear.issueLifecycle!, "task-access"),
    oauthClientId: "client",
    appUserId: "app",
    stopSession: () => {},
  });
  const evidenceRoot = path.join(layout.pawsRoot, "evidence");
  let rounds = 0;
  let sequence = 0;
  const launch: AgentLaunch = (agent) => {
    sequence += 1;
    const round = input.rounds[Math.min(rounds, input.rounds.length - 1)]!;
    const steps: Steps =
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
            : [...round(agent.worktree, ++rounds), { type: "end" }];
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
    files: linear.files!,
    evidence: {
      store: createEvidenceStore({ db, root: evidenceRoot, now: () => clock.now() }),
      publicUrl: "https://paws.example",
      root: evidenceRoot,
    },
    secretsDir: path.join(layout.pawsRoot, "secrets"),
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: privateKey as string,
      client: {
        async request(req) {
          if (req.path.endsWith("/pulls") && req.method === "POST") {
            if (pull !== null) return { status: 422, body: {} };
            const created = await client.request(req);
            pull = created.body as { number: number; html_url: string };
            return created;
          }
          if (pull !== null && req.path.includes("/pulls?head="))
            return { status: 200, body: [{ number: pull.number }] };
          if (pull !== null && req.method === "PATCH" && req.path.endsWith(`/pulls/${pull.number}`))
            return { status: 200, body: { ...pull, body: (req.body as { body: string }).body } };
          if (!isMergeReadiness(req)) return client.request(req);
          const head = (req.body as { variables: { head: string } }).variables.head;
          heads.add(head);
          if (polls >= (input.ciPendingPolls ?? 0)) return client.request(req);
          polls += 1;
          const body = fakeMergeReadiness(head);
          body.data.repository.object.statusCheckRollup.contexts.nodes = [
            { name: "ci", conclusion: null },
          ];
          return { status: 200, body };
        },
      },
    },
    launch,
    linearTaskModes: true,
    linearAccess: gate,
  });
  const state = () => listWorkItems(db)[0]?.state ?? null;
  const deliver = async (body: Record<string, unknown>, delivery: string) => {
    const response = await handleLinearWebhook(signed(body, delivery), "secret", linear.webhook);
    expect(response.status).toBe(200);
    await linear.webhook.intake!.idle();
  };
  const asked: string[] = [];
  let mainMoved = false;
  try {
    await deliver(
      {
        type: "AgentSessionEvent",
        action: "created",
        createdAt: new Date().toISOString(),
        agentSession: session,
        promptContext: '<issue identifier="ENG-1"><title>Write ok.txt</title></issue>',
      },
      "created-delivery",
    );
    const deadline = Date.now() + 20_000;
    while (!["merged", "failed", "exhausted"].includes(state() ?? "")) {
      if (Date.now() > deadline) throw new Error(`The task is stuck in ${state()}`);
      while (outbox.tick().length > 0) await outbox.idle();
      const open = findOpenQuestion(db, "session");
      if (open !== null && !asked.includes(open.kind)) {
        asked.push(open.kind);
        await deliver(
          {
            type: "AgentSessionEvent",
            action: "prompted",
            createdAt: new Date().toISOString(),
            agentSession: session,
            agentActivity: {
              id: `answer-${asked.length}`,
              content: {
                type: "prompt",
                body: open.kind === "visual-review" ? "Accept" : "Yes, end it with a newline.",
              },
              userId: "pascal",
              createdAt: new Date(clock.now() + 1_000).toISOString(),
            },
          },
          `prompted-${asked.length}`,
        );
      }
      if (!mainMoved && input.mainMovesAtPoll !== undefined && polls >= input.mainMovesAtPoll) {
        mainMoved = true;
        await commitOnMain(layout.bare, "side.txt", "side\n");
      }
      if ((await jobs.tick()) === null) {
        clock.advance(60_000);
        await Bun.sleep(5);
      }
    }
    while (outbox.tick().length > 0) await outbox.idle();
    const perCaller: Record<string, number> = {};
    for (const [key, count] of server.counts) {
      const [owner, caller] = key.split(" ");
      if (owner !== "item") continue;
      perCaller[caller!] = (perCaller[caller!] ?? 0) + count;
    }
    return {
      state: state(),
      asked,
      polls,
      heads: heads.size,
      perCaller: Object.fromEntries(
        Object.entries(perCaller).sort(([a], [b]) => a.localeCompare(b)),
      ),
      total: Object.values(perCaller).reduce((sum, count) => sum + count, 0),
      operations: [...server.counts]
        .map(([key, count]) => `${key} ${count}`)
        .sort()
        .join("\n"),
    };
  } finally {
    await orchestrator.shutdown();
    await outbox.idle();
    db.close();
    await layout.cleanup();
  }
}

test("Linear requests for a long Closeout with an agent question and a visual review", async () => {
  const result = await runTask({
    policy: POLICY,
    rounds: [
      (_worktree, round) => [
        { type: "update_plan", steps: [{ content: "Write ok.txt", status: "inProgress" }] },
        ...toolCalls(round),
        { type: "ask_team", question: "Should ok.txt end with a newline?" },
        ...toolCalls(round + 10),
      ],
      (worktree, round) => {
        writeFileSync(path.join(worktree, "shot.png"), PNG);
        return [
          ...toolCalls(round),
          write(worktree, "draft.txt"),
          { type: "publish_artifact", path: "shot.png", checkId: "visual-proof" },
        ];
      },
      (worktree, round) => [...toolCalls(round), write(worktree, "notes.txt")],
      (worktree, round) => [...toolCalls(round), write(worktree, "ok.txt", "ok\n")],
    ],
  });
  expect(result.state, result.operations).toBe("merged");
  expect(result.asked).toEqual(["agent", "visual-review"]);
  expect(result.perCaller, result.operations).toEqual({
    context: 1,
    outbox: 13,
    "session-read": 1,
    "task-access": 7,
  });
});

test("Linear requests while CI is pending and main moves before the merge", async () => {
  const result = await runTask({
    policy: POLICY_WITHOUT_CHECKS,
    rounds: [(worktree, round) => [...toolCalls(round), write(worktree, "ok.txt", "ok\n")]],
    ciPendingPolls: 2,
    mainMovesAtPoll: 1,
  });
  expect(result.state, result.operations).toBe("merged");
  expect(result.heads).toBeGreaterThan(1);
  expect(result.perCaller, result.operations).toEqual({
    context: 1,
    outbox: 7,
    "session-read": 1,
    "task-access": 7,
  });
});
