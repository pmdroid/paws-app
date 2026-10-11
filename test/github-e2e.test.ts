import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { FakeScript } from "../src/acp/testing/script";
import { FakeClock, JOB_KIND, systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, getWorkItem, listJobs, migrate, openDatabase } from "../src/db";
import { createFakeGitHubComments } from "../src/ghcomments";
import type { GitHubCommentMethod } from "../src/ghcomments";
import {
  startFakeGitHubRest,
  startGitHubIssuePoller,
  type FetchLike,
  type Sleeper,
} from "../src/ghissues";
import type { FakeGitHubRest } from "../src/ghissues";
import {
  INSTALLATION_PERMISSIONS,
  createFakeGitHub,
  fakeMergeReadiness,
  type GitHubClient,
  type GitHubResponse,
} from "../src/github";
import {
  githubCreatedEvent,
  gitHostToken,
  ingestGitHubComments,
  openGitHubWork,
} from "../src/index";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, routeBySource, type AgentLaunch } from "../src/loop";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const TOKEN = "gho_test_token";

test("a GitHub epic merges three pull requests with one plain reply and one fix", async () => {
  const seed = JSON.parse(
    await readFile(new URL("../examples/paws-demo/epic/epic.json", import.meta.url), "utf8"),
  ) as DemoSeed;
  const layout = await repoLayout();
  const rest = startFakeGitHubRest();
  const clock = new FakeClock(Date.now());
  const comments = createFakeGitHubComments({ clock, selfLogin: "octocat" });
  const closed: number[] = [];
  const provider = {
    source: "oauth" as const,
    token: async () => TOKEN,
    user: async () => ({ login: "octocat", id: 1 }),
  };
  seedEpic(rest, seed);
  const githubWork = openGitHubWork({
    provider,
    owner: "pmdroid",
    repo: "paws-demo",
    repos: ["pmdroid/paws-demo"],
    fetch: routeFetch(rest, comments, closed),
    baseUrl: rest.origin,
    clock,
  });
  const prompts: string[] = [];
  const github = createFakeGitHub();
  const apiPaths: string[] = [];
  const client = githubClient(layout.bare, github, apiPaths);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  let scripts = 0;
  const launch: AgentLaunch = (input) => {
    if (input.purpose !== "prepare") prompts.push(input.prompt);
    scripts += 1;
    const scriptPath = path.join(layout.root, `gh-script-${scripts}.json`);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        ...demoScript(input),
        model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
      }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, "", scriptPath],
      env: process.env,
    };
  };
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker: githubWork.tracker,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    github: {
      appId: "",
      installationId: "",
      privateKeyPem: "",
      client,
      tokenProvider: gitHostToken(provider),
    },
    launch,
    channel: "comments",
  });
  const sleeper = heldSleeper();
  const poller = startGitHubIssuePoller({
    db,
    client: githubWork.client,
    sleeper,
    onTrigger: (event) =>
      orchestrator.onLinearEvent(githubCreatedEvent(event.issueId, event.updatedAtMs)),
    onComment: (event) =>
      ingestGitHubComments(
        githubWork.comments,
        event.issueId,
        (accepted) => orchestrator.onLinearEvent(accepted),
        (itemId, at) => {
          /* stop is covered by the comment sync; the poller does not bypass the marker */
          void itemId;
          void at;
        },
      ),
  });

  let delivered = false;
  let whileAsking = "";
  let stop = false;
  const answerer = (async () => {
    for (;;) {
      if (stop) return;
      const question = comments.comments.find((comment) =>
        comment.body.includes("Include archived rows?"),
      );
      if (question && !delivered) {
        delivered = true;
        whileAsking = ["#2", "#3", "#4"]
          .map((suffix) => stateOf(db, `paws-demo${suffix}`) ?? "missing")
          .join("/");
        clock.advance(6_000);
        comments.post({
          issueNumber: question.issueNumber,
          body: "yes",
          login: "octocat",
          association: "OWNER",
        });
        await poller.pollNow();
      }
      await Bun.sleep(20);
    }
  })();

  try {
    const appeared = Date.now() + 10_000;
    while (Date.now() < appeared && epicState(db) === null) await Bun.sleep(20);
    expect(epicState(db), debug(layout, db)).not.toBeNull();
    const deadline = Date.now() + 90_000;
    let idle = 0;
    while (Date.now() < deadline && epicState(db) !== "done") {
      const job = await jobs.tick();
      if (job === null) {
        idle += 1;
        if (idle > 3) break;
        await Bun.sleep(20);
      } else {
        idle = 0;
      }
    }
    stop = true;
    await answerer;

    expect(whileAsking, debug(layout, db)).toBe("merged/merged/awaiting_input");
    expect(epicState(db), debug(layout, db)).toBe("done");
    expect(
      ["paws-demo#2", "paws-demo#3", "paws-demo#4"].map((id) => stateOf(db, id)),
      debug(layout, db),
    ).toEqual(["merged", "merged", "merged"]);
    expect(github.opened.map((pull) => pull.head)).toEqual([
      "paws/gh-pmdroid-paws-demo-2",
      "paws/gh-pmdroid-paws-demo-3",
      "paws/gh-pmdroid-paws-demo-4",
    ]);
    expect(github.opened.map((pull) => pull.body.split("\n")[0])).toEqual([
      "Closes #2",
      "Closes #3",
      "Closes #4",
    ]);
    expect(github.opened[0]?.body).toContain("Fix attempts: 1");
    expect(prompts.some((prompt) => prompt.includes("P1") && prompt.includes("failOn"))).toBe(true);
    const history = await readFile(
      path.join(layout.pawsRoot, "runs", "gh-pmdroid-paws-demo-2", "closeout-history.jsonl"),
      "utf8",
    );
    expect(history).toContain("failOn P1");
    expect(github.merged).toHaveLength(3);
    expect(comments.commentUpdates).toBeGreaterThan(0);
    const question = comments.comments.find((comment) => comment.body.includes("<!-- paws:q:"));
    expect(question?.body).toContain("Include archived rows?");
    expect(question?.login).toBe("octocat");
    const reply = comments.comments.find((comment) => comment.body === "yes");
    expect(reply?.login).toBe("octocat");
    expect(reply?.issueNumber).toBe(question?.issueNumber);
    expect(reply?.body).not.toContain("<!--");
    expect(reply?.body.startsWith("Paws:")).toBe(false);
    expect(comments.comments.some((comment) => comment.body.includes("Epic complete."))).toBe(true);
    expect(comments.comments.some((comment) => comment.body.includes("Picked up 3"))).toBe(true);
    expect(closed).toContain(1);
    expect(apiPaths.some((apiPath) => apiPath.endsWith("/access_tokens"))).toBe(false);
    expect(apiPaths.some((apiPath) => apiPath.includes("webhook"))).toBe(false);
    expect(rest.requests.some((request) => request.path.includes("webhook"))).toBe(false);
    expect(rest.requests.some((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(github.minted).toHaveLength(0);
  } finally {
    stop = true;
    poller.stop();
    await poller.settled;
    db.close();
    await rest.stop();
    await layout.cleanup();
  }
}, 120_000);

test("linear and github issues share one queue and report to their own tracker", async () => {
  const layout = await repoLayout();
  const rest = startFakeGitHubRest();
  const clock = new FakeClock(Date.now());
  const comments = createFakeGitHubComments({ clock, selfLogin: "octocat" });
  const closed: number[] = [];
  const provider = {
    source: "oauth" as const,
    token: async () => TOKEN,
    user: async () => ({ login: "octocat", id: 1 }),
  };
  const now = new Date().toISOString();
  rest.addIssue("pmdroid", "paws-demo", {
    number: 8,
    title: "GitHub only",
    body: "One GitHub issue.",
    user: { login: "octocat", id: 1 },
    authorAssociation: "OWNER",
    labels: ["paws"],
    updatedAt: now,
  });
  const githubWork = openGitHubWork({
    provider,
    owner: "pmdroid",
    repo: "paws-demo",
    repos: ["pmdroid/paws-demo"],
    fetch: routeFetch(rest, comments, closed),
    baseUrl: rest.origin,
    clock,
    labels: true,
  });
  const linear = createFakeTracker([
    {
      linearIssueId: "lin-9",
      identifier: "ENG-9",
      title: "Linear only",
      description: null,
      subIssues: [],
    },
  ]);
  const github = createFakeGitHub();
  const client = githubClient(layout.bare, github, []);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const started: string[] = [];
  let scripts = 0;
  const launch: AgentLaunch = (input) => {
    if (input.purpose === "implement") {
      started.push(
        `${input.itemId}:${stateOf(db, "ENG-9") ?? "missing"}/${stateOf(db, "paws-demo#8") ?? "missing"}`,
      );
    }
    scripts += 1;
    const scriptPath = path.join(layout.root, `both-script-${scripts}.json`);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        ...plainScript(input),
        model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
      }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, "", scriptPath],
      env: process.env,
    };
  };
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker: routeBySource({ linear, github: githubWork.tracker }),
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    github: {
      appId: "",
      installationId: "",
      privateKeyPem: "",
      client,
      tokenProvider: gitHostToken(provider),
    },
    launch,
    channel: "comments",
  });
  const sleeper = heldSleeper();
  await orchestrator.onLinearEvent(created("lin-9"));
  const poller = startGitHubIssuePoller({
    db,
    client: githubWork.client,
    sleeper,
    onTrigger: (event) =>
      orchestrator.onLinearEvent(githubCreatedEvent(event.issueId, event.updatedAtMs)),
    onComment: () => undefined,
  });
  try {
    const appeared = Date.now() + 10_000;
    while (Date.now() < appeared && stateOf(db, "paws-demo#8") === null) await Bun.sleep(20);
    expect(stateOf(db, "ENG-9"), debug(layout, db)).toBe("queued");
    expect(stateOf(db, "paws-demo#8"), debug(layout, db)).toBe("queued");
    const deadline = Date.now() + 90_000;
    let idle = 0;
    while (
      Date.now() < deadline &&
      (stateOf(db, "ENG-9") !== "merged" || stateOf(db, "paws-demo#8") !== "merged")
    ) {
      const job = await jobs.tick();
      if (job === null) {
        idle += 1;
        if (idle > 4) break;
        await Bun.sleep(20);
      } else {
        idle = 0;
      }
    }
    expect(stateOf(db, "ENG-9"), debug(layout, db)).toBe("merged");
    expect(stateOf(db, "paws-demo#8"), debug(layout, db)).toBe("merged");
    const implement = started.filter((line) => line.startsWith("ENG-9:") || line.startsWith("gh-"));
    expect(implement[0]).toBe("ENG-9:running/queued");
    expect(implement[1]?.startsWith("gh-pmdroid-paws-demo-8:")).toBe(true);
    expect(implement[1]).toContain("merged/");
    expect(linear.progress.some((update) => update.body.includes("ENG-9"))).toBe(true);
    expect(linear.progress.some((update) => update.body.includes("paws-demo#8"))).toBe(false);
    expect(comments.comments.some((comment) => comment.body.includes("paws-demo#8"))).toBe(true);
    expect(comments.comments.some((comment) => comment.body.includes("ENG-9"))).toBe(false);
    const responses = comments.comments.filter((comment) =>
      comment.body.startsWith("Paws: Verified locally."),
    );
    expect(responses).toHaveLength(1);
    expect(
      comments.comments.some((comment) =>
        /^Paws: (?:I|Verified| locally\.|Finished \(end_turn\)\.)\n/.test(comment.body),
      ),
    ).toBe(false);
    expect(github.opened.map((pull) => pull.body.split("\n")[0])).toEqual([
      "Fixes ENG-9",
      "Closes #8",
    ]);
    expect(github.minted).toHaveLength(0);
    expect(listJobs(db).some((job) => job.queue === JOB_KIND.merge && job.status === "dead")).toBe(
      false,
    );
  } finally {
    poller.stop();
    await poller.settled;
    db.close();
    await rest.stop();
    await layout.cleanup();
  }
}, 120_000);

function seedEpic(rest: FakeGitHubRest, seed: DemoSeed): void {
  const now = new Date().toISOString();
  const author = { login: "octocat", id: 1 };
  rest.addIssue("pmdroid", "paws-demo", {
    number: 1,
    title: seed.parent.title,
    body: seed.parent.description,
    user: author,
    authorAssociation: "OWNER",
    labels: ["paws"],
    updatedAt: now,
  });
  const children = seed.children.map((child, index) => ({
    number: index + 2,
    title: child.title,
    body: child.title,
    user: author,
    authorAssociation: "OWNER" as const,
    labels: [] as string[],
    updatedAt: now,
  }));
  for (const child of children) rest.addIssue("pmdroid", "paws-demo", child);
  rest.setSubIssues("pmdroid", "paws-demo", 1, children);
  rest.setBlockedBy("pmdroid", "paws-demo", 3, [children[0]!]);
  rest.setBlockedBy("pmdroid", "paws-demo", 4, [children[1]!]);
}

function routeFetch(
  rest: FakeGitHubRest,
  comments: ReturnType<typeof createFakeGitHubComments>,
  closed: number[],
): FetchLike {
  const native = globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PATCH" && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname)) {
      const number = Number(url.pathname.split("/").at(-1));
      closed.push(number);
      return jsonResponse(200, { number, state: "closed" });
    }
    if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues\/comments$/.test(url.pathname)) {
      return jsonResponse(
        200,
        comments.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: comment.login, id: comment.id },
          author_association: comment.association,
          created_at: new Date(comment.createdAtMs).toISOString(),
          updated_at: new Date(comment.createdAtMs).toISOString(),
          issue_url: `https://api.github.com/repos/pmdroid/paws-demo/issues/${comment.issueNumber}`,
          html_url: `https://github.com/pmdroid/paws-demo/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
        })),
      );
    }
    if (url.pathname.includes("/comments") || url.pathname.includes("/labels")) {
      let parsed: unknown;
      if (typeof init?.body === "string" && init.body.length > 0) parsed = JSON.parse(init.body);
      const response = await comments.request({
        method: method as GitHubCommentMethod,
        path: `${url.pathname}${url.search}`,
        ...(parsed === undefined ? {} : { body: parsed }),
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-ratelimit-remaining": "5000",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      };
      if (response.link) headers.link = response.link;
      return new Response(JSON.stringify(response.body), { status: response.status, headers });
    }
    return native(`${rest.origin}${url.pathname}${url.search}`, init);
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "5000",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
}

function heldSleeper(): Sleeper {
  let resolveWait: (() => void) | null = null;
  return {
    wait() {
      return new Promise((resolve) => {
        resolveWait = resolve;
      });
    },
    wake() {
      const resolve = resolveWait;
      resolveWait = null;
      resolve?.();
    },
  };
}

const P1_FINDING = JSON.stringify([
  {
    severity: "P1",
    location: "src/export.ts",
    explanation: "export drops every row",
    evidence: "the seeded test fails until the fix lands",
  },
]);

type DemoSeed = {
  parent: { title: string; description: string };
  children: Array<{ slug: string; title: string; blockedBy: string[] }>;
};

function reviewText(worktree: string, p1: boolean): string {
  if (p1 && !existsSync(path.join(worktree, "fixed.txt"))) return P1_FINDING;
  return "[]";
}

function reviewScript(text: string): FakeScript {
  return {
    steps: [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
      { type: "end", stopReason: "end_turn" },
    ],
  };
}

function demoScript(input: { purpose: string; itemId: string; worktree: string }): FakeScript {
  if (input.purpose === "review") {
    return reviewScript(reviewText(input.worktree, input.itemId.endsWith("-2")));
  }
  if (input.purpose === "fix") {
    return {
      steps: [
        {
          type: "fs_write",
          path: path.join(input.worktree, "fixed.txt"),
          content: "fixed\n",
        },
        {
          type: "fs_write",
          path: path.join(input.worktree, "ok.txt"),
          content: "ok\n",
        },
        { type: "end", stopReason: "end_turn" },
      ],
    };
  }
  if (input.itemId.endsWith("-4")) {
    return {
      steps: [
        {
          type: "ask_team",
          question: "Include archived rows?",
          options: ["yes", "no"],
        },
        {
          type: "fs_write",
          path: path.join(input.worktree, "archived.txt"),
          content: "yes\n",
        },
        {
          type: "fs_write",
          path: path.join(input.worktree, "ok.txt"),
          content: "ok\n",
        },
        { type: "end", stopReason: "end_turn" },
      ],
    };
  }
  return {
    steps: [
      {
        type: "fs_write",
        path: path.join(input.worktree, "ok.txt"),
        content: "ok\n",
      },
      {
        type: "fs_write",
        path: path.join(input.worktree, `${input.itemId}.txt`),
        content: "done\n",
      },
      { type: "end", stopReason: "end_turn" },
    ],
  };
}

function plainScript(input: { purpose: string; itemId: string; worktree: string }): FakeScript {
  if (input.purpose === "review") return reviewScript("[]");
  return {
    steps: [
      ...["I", " will check the issue."].map((text) => ({
        type: "update" as const,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      })),
      {
        type: "update",
        update: { sessionUpdate: "tool_call", toolCallId: "check", title: "Check locally" },
      },
      {
        type: "fs_write",
        path: path.join(input.worktree, "ok.txt"),
        content: "ok\n",
      },
      {
        type: "fs_write",
        path: path.join(input.worktree, `${input.itemId}.txt`),
        content: "done\n",
      },
      ...["Verified", " locally."].map((text) => ({
        type: "update" as const,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      })),
      { type: "end", stopReason: "end_turn" },
    ],
  };
}

function created(issueId: string): AcceptedLinearEvent {
  return {
    dedupeKey: `created:${issueId}`,
    deliveryId: null,
    source: "poll",
    action: "created",
    sessionId: issueId,
    issueId,
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}

function githubClient(
  bare: string,
  github: ReturnType<typeof createFakeGitHub>,
  seen: string[],
): GitHubClient {
  return {
    async request(req): Promise<GitHubResponse> {
      seen.push(req.path);
      if (req.path === "/graphql") {
        const { head } = (req.body as { variables: { head: string } }).variables;
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      if (req.path.endsWith("/access_tokens")) {
        await github.mintInstallationToken({
          installationId: "2",
          repository: "pmdroid/paws-demo",
        });
        return {
          status: 201,
          body: {
            token: "ghs_should_not_be_used",
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            permissions: INSTALLATION_PERMISSIONS,
          },
        };
      }
      if (req.method === "POST" && req.path.endsWith("/pulls")) {
        const body = req.body as { title: string; head: string; base: string; body: string };
        const opened = await github.open({
          repository: "pmdroid/paws-demo",
          title: body.title,
          head: body.head,
          base: body.base,
          body: body.body,
        });
        return {
          status: 201,
          body: { number: opened.number, html_url: opened.url, body: body.body },
        };
      }
      if (req.method === "PUT" && req.path.endsWith("/merge")) {
        const body = req.body as { sha?: string };
        const number = Number(req.path.split("/").at(-2));
        await github.merge({
          repository: "pmdroid/paws-demo",
          number,
          expectedHeadSha: body.sha ?? "",
        });
        const sha = await squashBranch(bare, body.sha ?? "");
        return { status: 200, body: { sha, merged: true } };
      }
      if (req.method === "POST" && req.path.endsWith("/labels")) {
        return { status: 201, body: { name: "paws" } };
      }
      return { status: 404, body: {} };
    },
  };
}

async function squashBranch(bare: string, expected: string): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "paws-squash-"));
  try {
    await exec("git", ["clone", bare, tmp]);
    await gitIdentity(tmp);
    const listed = (
      await exec("git", [
        "-C",
        tmp,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/remotes/origin/paws",
      ])
    ).stdout.trim();
    const match = listed.split("\n").find((line) => line.startsWith(`${expected} `));
    if (!match) throw new Error(`no pushed branch at ${expected}`);
    const ref = match.slice(expected.length).trim();
    await exec("git", ["-C", tmp, "merge", "--squash", ref]);
    await exec("git", ["-C", tmp, "commit", "-m", "squash"]);
    await exec("git", ["-C", tmp, "push", "origin", "HEAD:main"]);
    return (await exec("git", ["-C", tmp, "rev-parse", "HEAD"])).stdout.trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function repoLayout(): Promise<{
  root: string;
  bare: string;
  pawsRoot: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-gh-e2e-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await gitIdentity(seed);
  await seedCloseoutPolicy(seed);
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  return {
    root,
    bare,
    pawsRoot,
    home,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function gitIdentity(dir: string): Promise<void> {
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

const CLOSEOUT_POLICY = `specVersion: "0.1"
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
`;

const REVIEW_SKILL = `---
name: adversarial-review
description: Review the candidate. Report findings. Do not decide acceptance.
---

# Review

Report findings. An empty list means the change is fine.
`;

const SEEDED_TEST = `import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

test("seeded check", () => {
  expect(existsSync("ok.txt")).toBe(true);
  if (existsSync("header.txt")) {
    expect(readFileSync("ok.txt", "utf8").includes("header")).toBe(true);
  }
});
`;

async function seedCloseoutPolicy(seed: string): Promise<void> {
  await mkdir(path.join(seed, ".agents", "skills", "adversarial-review"), { recursive: true });
  await writeFile(path.join(seed, ".agents", "closeout.yaml"), CLOSEOUT_POLICY);
  await writeFile(
    path.join(seed, ".agents", "skills", "adversarial-review", "SKILL.md"),
    REVIEW_SKILL,
  );
  await writeFile(path.join(seed, "check.test.ts"), SEEDED_TEST);
  await writeFile(path.join(seed, "README.md"), "paws demo\n");
}

function stateOf(db: Database, identifier: string): string | null {
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_identifier = ?")
    .get(identifier);
  if (!row) return null;
  return getWorkItem(db, row.id)?.state ?? null;
}

function epicState(db: Database): string | null {
  return db.query<{ state: string }, []>("SELECT state FROM epic LIMIT 1").get()?.state ?? null;
}

function debug(layout: { pawsRoot: string }, db: Database): string {
  try {
    const jobs = listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`);
    const items = db
      .query<{ linear_identifier: string; state: string }, []>(
        "SELECT linear_identifier, state FROM work_item ORDER BY position",
      )
      .all();
    return JSON.stringify({ paws: layout.pawsRoot, epic: epicState(db), items, jobs });
  } catch {
    return "db closed";
  }
}
