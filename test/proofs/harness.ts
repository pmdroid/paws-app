import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { systemClock, WORK_ITEM_STATES } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  listWorkItemEventRows,
  listWorkItemsByStates,
  migrate,
  openDatabase,
} from "../../src/db";
import { createFakeTracker, type AcceptedLinearEvent, type FakeTracker } from "../../src/linear";
import {
  createFakeGitHub,
  fakeMergeReadiness,
  fakeRequiredChecks,
  type FakeGitHub,
  type GitHubClient,
} from "../../src/github";
import { attachOrchestrator, closeClosedIssueTasks, type AgentLaunch } from "../../src/loop";
import type { FakeScript, FakeStep } from "../../src/acp/testing/script";
import { workspaceAdmission } from "../fake-workspace";

export type LaunchInput = Parameters<AgentLaunch>[0];
type GitHubRequest = Parameters<GitHubClient["request"]>[0];

function guardLoopback(): string[] {
  const nativeFetch = globalThis.fetch;
  const network: string[] = [];
  globalThis.fetch = ((input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    network.push(url.href);
    if (url.hostname !== "127.0.0.1")
      throw new Error(`Non-loopback request refused: ${url.origin}`);
    return nativeFetch(input, init);
  }) as typeof fetch;
  return network;
}

async function git(...args: string[]) {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(exit, 0, `git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

const fakeAgent = resolve(import.meta.dir, "../../src/acp/testing/fake-agent.ts");
function scriptedAgent(
  dir: string,
  pawsRoot: string,
  steps: (input: LaunchInput) => FakeStep[],
): { launch: AgentLaunch; launches: LaunchInput[] } {
  const launches: LaunchInput[] = [];
  const launch: AgentLaunch = (input) => {
    launches.push(input);
    const sequence = launches.length;
    const agent = input.profile?.agent ?? (input.role === "reviewer" ? "codex" : "claude");
    const model = `test-${agent}-model`;
    const script: FakeScript = {
      model,
      models: [...new Set([model, input.profile?.model ?? model])],
      steps: [...steps(input), { type: "end", stopReason: "end_turn" }],
    };
    const scriptPath = join(dir, `agent-${sequence}.json`);
    writeFileSync(scriptPath, JSON.stringify(script));
    return {
      command: "timeout",
      args: [
        "--signal=TERM",
        "--kill-after=2s",
        "30s",
        process.execPath,
        "--no-env-file",
        fakeAgent,
        join(dir, `agent-${sequence}-result.json`),
        scriptPath,
      ],
      env: { ...process.env, PAWS_HOME: pawsRoot },
    };
  };
  return { launch, launches };
}

export type GitHubCall = { method: string; path: string; outcome: string };

function fixtureGitHub(input: { pulls: FakeGitHub; repository: string; ciPending?: boolean }): {
  client: GitHubClient;
  calls: GitHubCall[];
  closed: Set<number>;
} {
  const { pulls, repository } = input;
  const calls: GitHubCall[] = [];
  const closed = new Set<number>();
  const comments = new Map<number, { body: string; html_url: string }[]>();
  const pullJson = (number: number) => ({
    number,
    state: closed.has(number) ? "closed" : "open",
    head: { ref: pulls.opened[number - 1]!.head, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
  });
  async function respond(request: GitHubRequest) {
    const { method, path } = request;
    if (path === "/graphql") {
      const { head } = (request.body as { variables: { head: string } }).variables;
      const body = fakeMergeReadiness(head);
      if (input.ciPending) {
        body.data.repository.object.statusCheckRollup.state = "PENDING";
        body.data.repository.object.statusCheckRollup.contexts.nodes[0]!.conclusion = null;
      }
      return { status: 200, body };
    }
    const required = fakeRequiredChecks(request);
    if (required) return required;
    const number = Number(/\/(?:pulls|issues)\/(\d+)/.exec(path)?.[1]);
    if (method === "POST" && path.endsWith("/pulls")) {
      const body = request.body as { title: string; head: string; base: string; body: string };
      const pull = await pulls.open({ repository, ...body });
      return { status: 201, body: { number: pull.number, html_url: pull.url, body: body.body } };
    }
    if (method === "GET" && /\/pulls\?/.test(path)) {
      const head = new URL(path, "http://x").searchParams.get("head")?.split(":")[1];
      const open = pulls.opened
        .map((_, index) => pullJson(index + 1))
        .filter((pull) => pull.state === "open" && (!head || pull.head.ref === head));
      return { status: 200, body: open };
    }
    if (method === "GET" && path.includes("/comments"))
      return { status: 200, body: comments.get(number) ?? [] };
    if (method === "POST" && path.endsWith("/comments")) {
      const list = comments.get(number) ?? [];
      const body = (request.body as { body: string }).body;
      list.push({
        body,
        html_url: `https://github.com/${repository}/pull/${number}#c${list.length}`,
      });
      comments.set(number, list);
      return { status: 201, body: list.at(-1) };
    }
    if (method === "PATCH" && /\/pulls\/\d+$/.test(path)) {
      closed.add(number);
      return { status: 200, body: pullJson(number) };
    }
    if (method === "POST" && path.endsWith("/labels"))
      return { status: 201, body: { name: "paws" } };
    throw new Error(`Unexpected fake GitHub request: ${method} ${path}`);
  }
  const client: GitHubClient = {
    async request(request) {
      const call = { method: request.method, path: request.path, outcome: "pending" };
      calls.push(call);
      try {
        const response = await respond(request);
        call.outcome = String(response.status);
        return response;
      } catch (error) {
        call.outcome = `threw: ${error instanceof Error ? error.message : String(error)}`;
        throw error;
      }
    },
  };
  return { client, calls, closed };
}

export const ACME = {
  repository: "acme/widgets",
  issueId: "issue-acme-7",
  identifier: "ACME-7",
  sessionId: "session-acme-7",
};

export type Assertion = { name: string; passed: boolean; observed: unknown };

export type ProofContext = {
  linear: FakeTracker;
  github: ReturnType<typeof fixtureGitHub>;
  launches: LaunchInput[];
  itemState(): string | null;
  delegate(): Promise<void>;
  stopInLinear(): Promise<void>;
  cancelInLinear(): Promise<void>;
  waitFor(what: string, done: () => boolean, timeoutMs?: number): Promise<boolean>;
  expect(name: string, passed: boolean, observed?: unknown): void;
};

export type Proof = {
  covers: string[];
  summary: string;
  ciPending?: boolean;
  agent(input: LaunchInput): FakeStep[];
  run(context: ProofContext): Promise<void>;
};

const policy = `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["true"]
    timeoutSeconds: 10
`;

export async function runProof(name: string, proof: Proof, dir: string) {
  const pawsRoot = process.env.PAWS_HOME!;
  const bare = join(dir, "origin.git");
  const seed = join(dir, "seed");
  mkdirSync(pawsRoot, { recursive: true });
  writeFileSync(join(pawsRoot, "config.toml"), `[agents]\nimplementer = "claude"\n`);
  await git("init", "--bare", "-b", "main", bare);
  await git("clone", bare, seed);
  mkdirSync(join(seed, ".agents"), { recursive: true });
  writeFileSync(join(seed, ".agents/closeout.yaml"), policy);
  writeFileSync(join(seed, "README.md"), "# Acme widgets\n");
  await git("-C", seed, "add", ".");
  await git("-C", seed, "commit", "-m", "Seed acme widgets");
  await git("-C", seed, "push", "origin", "HEAD:main");
  const linear = createFakeTracker([
    {
      linearIssueId: ACME.issueId,
      identifier: ACME.identifier,
      title: "Count widgets per shelf",
      description: "Write the shelf count to widgets.txt.",
      subIssues: [],
    },
  ]);
  const github = fixtureGitHub({
    pulls: createFakeGitHub(),
    repository: ACME.repository,
    ciPending: proof.ciPending,
  });
  const db = openDatabase(join(pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const { launch, launches } = scriptedAgent(dir, pawsRoot, proof.agent);
  const [owner, repo] = ACME.repository.split("/") as [string, string];
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    pawsRoot,
    home: process.env.HOME,
    tracker: linear,
    repositories: [{ owner, repo, remoteUrl: bare }],
    githubForRepository: () => ({
      appId: "",
      installationId: "",
      privateKeyPem: "",
      client: github.client,
      tokenProvider: { mode: "token", tokenFor: async () => "proof-fake-token" },
    }),
    launch,
  });
  const actions: { at: string; action: string }[] = [];
  const assertions: Assertion[] = [];
  const items = () => listWorkItemsByStates(db, WORK_ITEM_STATES);
  const event = (action: "created" | "prompted", extra: Partial<AcceptedLinearEvent> = {}) =>
    orchestrator.onLinearEvent({
      dedupeKey: `proof-${action}-${actions.length}`,
      deliveryId: null,
      source: "webhook",
      action,
      sessionId: ACME.sessionId,
      issueId: ACME.issueId,
      activityId: null,
      body: null,
      signal: null,
      updatedAtMs: Date.now(),
      payload: "{}",
      ...extra,
    });
  const act = (action: string) => {
    actions.push({ at: new Date().toISOString(), action });
    console.log(`ACT ${action}`);
  };
  const context: ProofContext = {
    linear,
    github,
    launches,
    itemState: () => items()[0]?.state ?? null,
    async delegate() {
      act(`Delegate ${ACME.identifier} to Paws in Linear`);
      await event("created");
    },
    async stopInLinear() {
      act(`Press Stop in the ${ACME.identifier} agent session`);
      await event("prompted", { activityId: "proof-stop", signal: "stop" });
    },
    async cancelInLinear() {
      act(`Move ${ACME.identifier} to Canceled in Linear`);
      linear.issueStateTypes.set(ACME.issueId, "canceled");
      await closeClosedIssueTasks(
        db,
        {
          issueId: ACME.issueId,
          organizationId: null,
          identifier: ACME.identifier,
          stateType: "canceled",
          closedAtMs: Date.now(),
        },
        {
          notify: (command) => orchestrator.bus.emit(command),
          interrupt: (sessionId) => orchestrator.interruptLinearSession(sessionId),
        },
      );
    },
    async waitFor(what, done, timeoutMs = 60_000) {
      act(`Wait until ${what}`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (done()) return true;
        await jobs.tick();
        outbox.tick();
        await Bun.sleep(20);
      }
      return done();
    },
    expect(assertion, passed, observed = null) {
      assertions.push({ name: assertion, passed, observed });
      console.log(`${passed ? "PASS" : "FAIL"} ${assertion}: ${JSON.stringify(observed)}`);
    },
  };
  const root = process.env.PAWS_VERIFY_ROOT!;
  const home = realpathSync(process.env.HOME!);
  context.expect(
    "HOME and PAWS_HOME are under the temp root",
    !relative(root, home).startsWith("..") && !relative(root, pawsRoot).startsWith(".."),
    { root, home, pawsHome: pawsRoot },
  );
  try {
    await proof.run(context);
  } catch (error) {
    context.expect("scenario ran to the end", false, error instanceof Error ? error.stack : error);
  } finally {
    await orchestrator.shutdown();
    await outbox.idle();
  }
  const result = {
    name,
    summary: proof.summary,
    covers: proof.covers,
    passed: assertions.every((assertion) => assertion.passed),
    actions,
    linear: {
      activities: linear.progress,
      questions: linear.questions,
      issueChanges: linear.statuses,
      sessionUpdates: linear.sessionUpdates,
    },
    github: github.calls,
    transitions: items().flatMap((item) =>
      listWorkItemEventRows(db, item.id).map((row) => ({
        item: item.id,
        from: row.fromState,
        to: row.toState,
        event: row.event,
      })),
    ),
    assertions,
  };
  db.close();
  return result;
}

type ProofResult = Awaited<ReturnType<typeof runProof>>;

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

function markdown(result: ProofResult): string {
  const list = (rows: string[]) => (rows.length ? rows.map((row) => `- ${row}`) : ["- none"]);
  return [
    `# Proof: ${result.name} — ${result.passed ? "PASS" : "FAIL"}`,
    "",
    result.summary,
    "",
    `Covers: ${result.covers.map((glob) => `\`${glob}\``).join(", ")}`,
    "",
    "## What was done",
    ...list(result.actions.map((entry) => entry.action)),
    "",
    "## Linear activity",
    ...list([
      ...result.linear.activities.map((entry) => `${entry.kind}: ${oneLine(entry.body)}`),
      ...result.linear.questions.map((entry) => `question: ${oneLine(entry.body)}`),
    ]),
    "",
    "## Linear issue changes",
    ...list(
      result.linear.issueChanges.map((entry) => `${entry.linearIssueId} → ${entry.stateType}`),
    ),
    "",
    "## GitHub calls",
    ...list(result.github.map((call) => `${call.method} ${call.path} → ${call.outcome}`)),
    "",
    "## Work item transitions",
    ...list(result.transitions.map((row) => `${row.from} → ${row.to} (${row.event})`)),
    "",
    "## Assertions",
    ...list(
      result.assertions.map((entry) => `${entry.passed ? "PASS" : "**FAIL**"} ${entry.name}`),
    ),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const name = process.argv[2]!;
  const root = process.env.PAWS_VERIFY_ROOT;
  assert(root && realpathSync(root) === root && basename(root).startsWith("paws-verify-"));
  const evidence = process.env.PAWS_EVIDENCE_DIR!;
  const network = guardLoopback();
  const proof = (await import(`./${name}.ts`)).default as Proof;
  const result = await runProof(name, proof, root);
  const bundle = { ...result, network };
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `proof-${name}.json`), JSON.stringify(bundle, null, 2));
  writeFileSync(join(evidence, `proof-${name}.md`), markdown(result));
  process.exit(result.passed ? 0 : 1);
}
