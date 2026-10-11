import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { FakeClock, systemClock, WORK_ITEM_STATES } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  listJobs,
  listWorkItemsByStates,
  migrate,
  openDatabase,
  submitCommand,
} from "../../src/db";
import { createFakeGitHubComments, type GitHubCommentMethod } from "../../src/ghcomments";
import { startFakeGitHubRest, startGitHubIssuePoller, type FetchLike } from "../../src/ghissues";
import { createFakeGitHub, fakeMergeReadiness, type GitHubClient } from "../../src/github";
import {
  githubCreatedEvent,
  ingestGitHubComments,
  openGitHubWork,
  startPaws,
} from "../../src/index";
import { attachOrchestrator, type AgentLaunch } from "../../src/loop";
import { handleStatusRequest, parseStatusSnapshot } from "../../src/web";
import type { FakeScript, FakeStep } from "../../src/acp/testing/script";
import { probeBoundaries } from "./probes";

const root = process.env.PAWS_VERIFY_ROOT;
assert(root && realpathSync(root) === root && basename(root).startsWith("paws-verify-"));
assert.equal(realpathSync(process.env.HOME!), join(root, "home"));
assert.equal(realpathSync(process.env.KYOTOAGENT_ROOT!), join(root, "home", ".kyotoagent"));
assert.equal(process.env.PAWS_HOME, join(root, "home", ".paws"));
const mode = process.argv[2] ?? "check";
const evidenceRoot: string = root;
const nativeFetch = globalThis.fetch;
const network: string[] = [];
globalThis.fetch = ((input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  network.push(url.href);
  if (url.hostname !== "127.0.0.1") throw new Error(`Non-loopback request refused: ${url.origin}`);
  return nativeFetch(input, init);
}) as typeof fetch;
const observations: { name: string; passed: boolean; observed: unknown }[] = [];
function observe(name: string, passed: boolean, observed: unknown) {
  observations.push({ name, passed, observed });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(observed)}`);
}
function save(name: string, value: unknown) {
  writeFileSync(join(evidenceRoot, name), JSON.stringify(value, null, 2));
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
const policy = `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test", "check.test.ts"]
    timeoutSeconds: 10
  - id: review
    kind: review
    gate: beforePR
    skill: .agents/skills/local-review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
    failOn: P1
`;
const reviewInstruction = "LOCAL_REVIEW_SENTINEL: verify the complete issue acceptance criteria.";
const issueBody = "ACCEPTANCE_SENTINEL: preserve archived rows when the team answers yes.";
const token = "local-fake-token";
const provider = {
  source: "oauth" as const,
  token: async () => token,
  user: async () => ({ login: "local-user", id: 1 }),
};

async function scenario(name: string, reviewerText = "[]", implementer = "claude") {
  const dir = join(evidenceRoot, name);
  const pawsRoot = join(dir, "paws");
  const bare = join(dir, "origin.git");
  const seed = join(dir, "seed");
  mkdirSync(pawsRoot, { recursive: true });
  writeFileSync(join(pawsRoot, "config.toml"), `[agents]\nimplementer = "${implementer}"\n`);
  await git("init", "--bare", "-b", "main", bare);
  await git("clone", bare, seed);
  mkdirSync(join(seed, ".agents/skills/local-review"), { recursive: true });
  writeFileSync(join(seed, ".agents/closeout.yaml"), policy);
  writeFileSync(join(seed, ".agents/skills/local-review/SKILL.md"), reviewInstruction);
  writeFileSync(
    join(seed, "check.test.ts"),
    'import { expect, test } from "bun:test";\nimport { readFileSync } from "node:fs";\ntest("acceptance", () => expect(readFileSync("result.txt", "utf8")).toBe("yes\\n"));\n',
  );
  await git("-C", seed, "add", ".");
  await git("-C", seed, "commit", "-m", "Seed local acceptance policy");
  await git("-C", seed, "push", "origin", "HEAD:main");
  const initialHead = await git("--git-dir", bare, "rev-parse", "main");
  const rest = startFakeGitHubRest();
  const clock = new FakeClock(Date.now());
  const comments = createFakeGitHubComments({ clock, selfLogin: "local-user" });
  const pulls = createFakeGitHub();
  const closed: number[] = [];
  const requests: unknown[] = [];
  const author = { login: "local-user", id: 1 };
  const children = [2, 3].map((number) => ({
    number,
    title: `Implement local item ${number}`,
    body: issueBody,
    user: author,
    authorAssociation: "OWNER",
    labels: [],
    updatedAt: new Date(clock.now()).toISOString(),
  }));
  rest.addIssue("local", "fixture", {
    number: 1,
    title: "Local epic",
    body: issueBody,
    user: author,
    authorAssociation: "OWNER",
    labels: ["paws"],
    updatedAt: new Date(clock.now()).toISOString(),
  });
  for (const child of children) rest.addIssue("local", "fixture", child);
  rest.setSubIssues("local", "fixture", 1, children);
  rest.setBlockedBy("local", "fixture", 3, [children[0]!]);
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const routeFetch: FetchLike = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    assert.equal(url.origin, rest.origin);
    const method = init?.method ?? "GET";
    requests.push({ method, path: url.pathname });
    if (method === "PATCH" && /\/issues\/\d+$/.test(url.pathname)) {
      closed.push(Number(url.pathname.split("/").at(-1)));
      return json({ state: "closed" });
    }
    if (method === "GET" && url.pathname.endsWith("/issues/comments")) {
      return json(
        comments.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: comment.login, id: 1 },
          author_association: comment.association,
          created_at: new Date(comment.createdAtMs).toISOString(),
          updated_at: new Date(comment.createdAtMs).toISOString(),
          issue_url: `${rest.origin}/repos/local/fixture/issues/${comment.issueNumber}`,
        })),
      );
    }
    if (url.pathname.includes("/comments") || url.pathname.includes("/labels")) {
      const response = await comments.request({
        method: method as GitHubCommentMethod,
        path: `${url.pathname}${url.search}`,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: {
          "content-type": "application/json",
          ...(response.link ? { link: response.link } : {}),
        },
      });
    }
    return fetch(url, init);
  };
  const work = openGitHubWork({
    provider,
    owner: "local",
    repo: "fixture",
    fetch: routeFetch,
    baseUrl: rest.origin,
    clock,
  });
  const client: GitHubClient = {
    async request(request) {
      requests.push(request);
      if (request.path === "/graphql") {
        const { head } = (request.body as { variables: { head: string } }).variables;
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      if (request.method === "POST" && request.path.endsWith("/pulls")) {
        const body = request.body as { title: string; head: string; base: string; body: string };
        const pull = await pulls.open({ repository: "local/fixture", ...body });
        return { status: 201, body: { number: pull.number, html_url: pull.url, body: body.body } };
      }
      if (request.method === "PUT" && request.path.endsWith("/merge")) {
        const body = request.body as { sha: string; commit_message?: string };
        const number = Number(request.path.split("/").at(-2));
        const branch = pulls.opened[number - 1]?.head;
        assert(branch);
        assert.equal(await git("--git-dir", bare, "rev-parse", branch), body.sha);
        await git("-C", seed, "fetch", "origin");
        await git("-C", seed, "merge", "--squash", body.sha);
        await git("-C", seed, "commit", "-m", body.commit_message ?? "Local squash");
        await git("-C", seed, "push", "origin", "HEAD:main");
        await pulls.merge({ repository: "local/fixture", number, expectedHeadSha: body.sha });
        return {
          status: 200,
          body: { merged: true, sha: await git("-C", seed, "rev-parse", "HEAD") },
        };
      }
      if (request.method === "POST" && request.path.endsWith("/labels"))
        return { status: 201, body: { name: "paws" } };
      throw new Error(`Unexpected fake GitHub request: ${request.method} ${request.path}`);
    },
  };
  const db = openDatabase(join(pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const launches: Parameters<AgentLaunch>[0][] = [];
  const launch: AgentLaunch = (input) => {
    launches.push(input);
    const sequence = launches.length;
    const chunk = (text: string): FakeStep => ({
      type: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
    const write = (file: string, content: string): FakeStep => ({
      type: "fs_write",
      path: join(input.worktree, file),
      content,
    });
    const steps: FakeStep[] =
      input.purpose === "review"
        ? [chunk(reviewerText)]
        : input.purpose === "fix"
          ? [write("result.txt", "yes\n")]
          : [
              ...["I", " will", " check", " locally."].map(chunk),
              {
                type: "update",
                update: { sessionUpdate: "tool_call", toolCallId: "check", title: "Check locally" },
              },
              ...(input.itemId.endsWith("-2")
                ? [
                    {
                      type: "ask_team" as const,
                      question: "Include archived rows?",
                      options: ["yes", "no"],
                    },
                  ]
                : []),
              write(
                "result.txt",
                name === "happy" && input.itemId.endsWith("-2") ? "broken\n" : "yes\n",
              ),
              write(`${input.itemId}.txt`, "done\n"),
              ...["Verified", " locally."].map(chunk),
            ];
    const script: FakeScript = { steps: [...steps, { type: "end", stopReason: "end_turn" }] };
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
      env: {
        ...process.env,
        PAWS_HOME: pawsRoot,
      },
    };
  };
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot,
    home: process.env.HOME,
    tracker: work.tracker,
    repository: { owner: "local", repo: "fixture", remoteUrl: bare },
    github: {
      appId: "",
      installationId: "",
      privateKeyPem: "",
      client,
      tokenProvider: { mode: "oauth", tokenFor: async () => token },
    },
    launch,
    channel: "comments",
  });
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    for (const item of listWorkItemsByStates(db, WORK_ITEM_STATES)) {
      if (["merged", "cancelled", "failed", "exhausted"].includes(item.state)) continue;
      submitCommand(db, orchestrator.bus, {
        type: "stop",
        itemId: item.id,
        source: "linear",
        requestedAt: Date.now(),
      });
    }
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const poller = startGitHubIssuePoller({
    db,
    client: work.client,
    onTrigger: (event) =>
      orchestrator.onLinearEvent(githubCreatedEvent(event.issueId, event.updatedAtMs)),
    onComment: (event) =>
      ingestGitHubComments(
        work.comments,
        event.issueId,
        (accepted) => orchestrator.onLinearEvent(accepted),
        (itemId) => {
          throw new Error(`Unexpected stop: ${itemId}`);
        },
      ),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/__fixture")
        return json({ comments: comments.comments, pulls: pulls.opened, merged: pulls.merged });
      return (
        (await handleStatusRequest(request, { db, env: {} })) ??
        new Response("Not found", { status: 404 })
      );
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  let stopped = false;
  let answered = false;
  let parked: unknown;
  const answerer = (async () => {
    for (;;) {
      if (stopped) return;
      const question = comments.comments.find((comment) => comment.body.includes("<!-- paws:q:"));
      if (question && !answered) {
        answered = true;
        parked = listWorkItemsByStates(db, WORK_ITEM_STATES).map((item) => item.state);
        const parkedStatus = await (await fetch(`${origin}/api/status`)).json();
        save(`${name}-parked.json`, parkedStatus);
        const parsed = parseStatusSnapshot(parkedStatus);
        if (name === "happy")
          observe(
            "live question exposes its source-thread handoff",
            parsed.ok && parsed.snapshot.questions.some((entry) => entry.links.length > 0),
            parsed.ok
              ? parsed.snapshot.questions.map(({ id, links }) => ({ id, links }))
              : parsed.error,
          );
        clock.advance(6_000);
        comments.post({
          issueNumber: question.issueNumber,
          body: "yes",
          login: "local-user",
          association: "OWNER",
        });
        await poller.pollNow();
      }
      await Bun.sleep(10);
    }
  })();
  try {
    const deadline = Date.now() + 60_000;
    while (listWorkItemsByStates(db, WORK_ITEM_STATES).length === 0 && Date.now() < deadline)
      await Bun.sleep(20);
    while (Date.now() < deadline) {
      if (interrupted) break;
      const items = listWorkItemsByStates(db, WORK_ITEM_STATES);
      if (
        items.some((item) => ["failed", "exhausted"].includes(item.state)) ||
        items.every((item) => item.state === "merged")
      )
        break;
      await jobs.tick();
      await Bun.sleep(20);
    }
    stopped = true;
    await answerer;
    poller.stop();
    await poller.settled;
    const snapshot = await (await fetch(`${origin}/api/status`)).json();
    assert(parseStatusSnapshot(snapshot).ok);
    const states = listWorkItemsByStates(db, WORK_ITEM_STATES).map((item) => item.state);
    const finalHead = await git("--git-dir", bare, "rev-parse", "main");
    const finalContent = await git("--git-dir", bare, "show", "main:result.txt").catch(() => null);
    const result = {
      finalContent,
      states,
      parked,
      initialHead,
      finalHead,
      launches,
      comments: comments.comments,
      pulls: pulls.opened,
      merged: pulls.merged,
      closed,
      requests,
      jobs: listJobs(db),
      snapshot,
    };
    save(`${name}.json`, result);
    if (mode === "serve" && !interrupted) {
      console.log(
        `Throwaway dashboard: ${origin}/status\nFake issue thread: ${origin}/__fixture\nPID ${process.pid}; HOME ${process.env.HOME}; root ${process.env.KYOTOAGENT_ROOT}; expires in 300 seconds.`,
      );
      await new Promise<void>((done) => {
        const timer = setTimeout(finish, 300_000);
        function finish() {
          clearTimeout(timer);
          process.off("SIGINT", finish);
          process.off("SIGTERM", finish);
          done();
        }
        process.on("SIGINT", finish);
        process.on("SIGTERM", finish);
      });
    }
    return result;
  } finally {
    stopped = true;
    await answerer;
    poller.stop();
    await poller.settled;
    await server.stop(true);
    await rest.stop();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    db.close();
  }
}

try {
  const fresh = startPaws({ PAWS_HOME: process.env.PAWS_HOME, PAWS_PORT: "0" }, { noTunnel: true });
  try {
    const origin = `http://127.0.0.1:${fresh.server.port}`;
    const rootResponse = await fetch(origin);
    const health = await (await fetch(`${origin}/health`)).json();
    const status = await (await fetch(`${origin}/api/status`)).json();
    const parsed = parseStatusSnapshot(status);
    const source = parsed.ok ? parsed.snapshot.source : null;
    const healthy =
      typeof health === "object" && health !== null && "ok" in health && health.ok === true;
    const page = await fetch(`${origin}/status`);
    const pageText = await page.text();
    const webhook = await fetch(`${origin}/webhooks/linear`, { method: "POST", body: "{}" });
    save("fresh.json", {
      rootStatus: rootResponse.status,
      health,
      status,
      pageStatus: page.status,
      webhookStatus: webhook.status,
    });
    observe(
      "fresh instance serves health, live status and built dashboard with webhooks off",
      healthy &&
        source === "live" &&
        page.ok &&
        pageText.includes("<script") &&
        webhook.status === 404,
      { health, source, pageStatus: page.status, webhookStatus: webhook.status },
    );
    observe("documented root URL opens the dashboard", rootResponse.ok, rootResponse.status);
  } finally {
    fresh.stop();
  }
  const happy = await scenario("happy");
  observe(
    "two items merge in dependency order after a question and a real failing check/fix",
    happy.states.join() === "merged,merged" &&
      happy.initialHead !== happy.finalHead &&
      happy.finalContent === "yes" &&
      happy.launches.some((run) => run.purpose === "fix") &&
      JSON.stringify(happy.parked) === '["awaiting_input","queued"]' &&
      happy.merged.length === 2,
    { states: happy.states, parked: happy.parked, merges: happy.merged.length },
  );
  observe(
    "ACP chunks form complete comments",
    happy.comments.filter((comment) => comment.body.startsWith("Paws: Verified locally."))
      .length === 2 &&
      !happy.comments.some((comment) => /^Paws: (I|Verified)\n/.test(comment.body)),
    happy.comments
      .filter((comment) => comment.body.includes("Verified"))
      .map((comment) => comment.body),
  );
  observe(
    "implementation receives issue acceptance criteria",
    happy.launches
      .filter((run) => run.purpose === "implement")
      .every((run) => run.prompt.includes(issueBody)),
    happy.launches.find((run) => run.purpose === "implement")?.prompt,
  );
  observe(
    "review receives the configured skill instructions",
    happy.launches
      .filter((run) => run.purpose === "review")
      .every((run) => run.prompt.includes(reviewInstruction)),
    happy.launches.find((run) => run.purpose === "review")?.prompt,
  );
  if (mode !== "serve") {
    await probeBoundaries(evidenceRoot, observe);
    const malformed = await scenario("malformed-review", "I could not review this change.");
    observe("malformed reviewer output blocks merging", malformed.merged.length === 0, {
      states: malformed.states,
      merges: malformed.merged.length,
    });
    const codex = await scenario("codex", "[]", "codex");
    observe(
      "advertised Codex implementer completes independent review",
      codex.states.join() === "merged,merged",
      { states: codex.states, merges: codex.merged.length },
    );
  }
} catch (error) {
  observe(
    "verification harness completed",
    false,
    error instanceof Error ? error.stack : String(error),
  );
} finally {
  save("observations.json", observations);
  save("network.json", network);
  globalThis.fetch = nativeFetch;
}
process.exitCode = observations.some((observation) => !observation.passed) ? 1 : 0;
