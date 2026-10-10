import { describe, expect, test } from "bun:test";
import {
  GITHUB_POLL_ACTIVE_MS,
  GITHUB_POLL_IDLE_MS,
  createGitHubIssuesClient,
  githubTrackerConfig,
  githubWorkIsHot,
  mentionsPaws,
  startFakeGitHubRest,
  startGitHubIssuePoller,
  type FakeGitHubRest,
  type FetchLike,
  type GitHubIssuesClient,
  type GitHubTokenProvider,
  type Sleeper,
} from "../src/ghissues";
import { tempDb } from "./helpers";

const NOW = 1_700_000_000_000;

describe("github issue poll", () => {
  test("frozen tracker defaults and the @paws word boundary", () => {
    expect(githubTrackerConfig()).toEqual({
      triggerLabel: "paws",
      mention: "@paws",
      trusted: ["OWNER", "MEMBER", "COLLABORATOR"],
      repos: [],
      statusLabels: {},
    });
    expect(
      githubTrackerConfig({
        trigger_label: "paws",
        mention: "@paws",
        trusted: ["OWNER", "MEMBER", "COLLABORATOR"],
        repos: ["acme/widgets"],
        status_labels: { running: "paws:running" },
      }).repos,
    ).toEqual([{ owner: "acme", repo: "widgets" }]);
    expect(mentionsPaws("@paws", "@paws")).toBe(true);
    expect(mentionsPaws("hey @paws please", "@paws")).toBe(true);
    expect(mentionsPaws("\n@paws", "@paws")).toBe(true);
    expect(mentionsPaws("@pawsome", "@paws")).toBe(false);
    expect(mentionsPaws("x@paws", "@paws")).toBe(false);
  });

  test("waits 5s while work or a question is open and 15s while idle", async () => {
    const db = tempDb();
    expect(githubWorkIsHot(db)).toBe(false);
    db.run(
      `INSERT INTO question (id, item_id, session_id, body, status, created_at)
       VALUES ('q1', 'item-1', 'session-1', 'which?', 'open', 1)`,
    );
    expect(githubWorkIsHot(db)).toBe(true);
    db.run(
      `UPDATE question SET status = 'answered', answer = 'yes', answered_at = 2 WHERE id = 'q1'`,
    );
    expect(githubWorkIsHot(db)).toBe(false);
    db.run(
      `INSERT INTO epic (id, linear_issue_id, linear_identifier, title, state, created_at)
       VALUES ('e1', 'github:acme/widgets#1', 'widgets#1', 'Epic', 'running', 1)`,
    );
    db.run(
      `INSERT INTO work_item (
         id, epic_id, linear_issue_id, linear_identifier, title, state, branch_name, position, created_at
       ) VALUES ('w1', 'e1', 'github:acme/widgets#2', 'widgets#2', 'Two', 'queued', 'paws/widgets-2', 0, 1)`,
    );
    expect(githubWorkIsHot(db)).toBe(true);
    db.run(`UPDATE work_item SET state = 'merged' WHERE id = 'w1'`);
    expect(githubWorkIsHot(db)).toBe(false);

    const waits: number[] = [];
    const gate = gatedSleeper(waits);
    const poller = startGitHubIssuePoller({
      db,
      client: createGitHubIssuesClient({
        provider: tokenProvider(),
        config: githubTrackerConfig(),
      }),
      onTrigger() {},
      onComment() {},
      sleeper: gate.sleeper,
      now: () => NOW,
    });
    try {
      await waitFor(() => waits.length > 0);
      expect(waits[0]).toBe(GITHUB_POLL_IDLE_MS);
      expect(waits[0]).toBe(15_000);
      db.run(`UPDATE question SET status = 'open' WHERE id = 'q1'`);
      gate.release();
      await waitFor(() => waits.length > 1);
      expect(waits[1]).toBe(GITHUB_POLL_ACTIVE_MS);
      expect(waits[1]).toBe(5_000);
    } finally {
      poller.stop();
      await poller.settled;
      db.close();
    }
  });

  test("a paws label triggers within one tick and pull requests are ignored", async () => {
    const fake = startFakeGitHubRest();
    const db = tempDb();
    const updatedAt = iso(NOW);
    fake.addIssue("acme", "widgets", {
      number: 7,
      title: "Ship the label",
      labels: ["paws"],
      authorAssociation: "OWNER",
      updatedAt,
    });
    fake.addIssue("acme", "widgets", {
      number: 50,
      title: "A pull request",
      body: "please @paws",
      labels: ["paws"],
      authorAssociation: "OWNER",
      pullRequest: true,
      updatedAt,
    });
    fake.addComment("acme", "widgets", {
      id: 3,
      issueNumber: 50,
      body: "@paws",
      authorAssociation: "OWNER",
      pullRequest: true,
      updatedAt,
    });
    let tokens = 0;
    let pollsAtTrigger = 0;
    const triggers: string[] = [];
    const waits: number[] = [];
    const poller = startGitHubIssuePoller({
      db,
      client: clientFor(fake, {
        ...tokenProvider(),
        async token() {
          tokens += 1;
          return "gho_test";
        },
      }),
      onTrigger(event) {
        pollsAtTrigger = issueLists(fake).length;
        triggers.push(`${event.kind}:${event.issueId}`);
      },
      onComment() {},
      sleeper: blockingSleeper(waits),
      now: () => NOW,
      hot: () => false,
    });
    try {
      await waitFor(() => triggers.length === 1 && waits.length > 0);
      expect(pollsAtTrigger).toBe(1);
      expect(triggers).toEqual(["label:github:acme/widgets#7"]);
      expect(tokens).toBeGreaterThanOrEqual(2);
      const list = issueLists(fake)[0];
      expect(list?.search).toContain("state=open");
      expect(list?.search).toContain("sort=updated");
      expect(list?.search).toContain("since=");
      expect(list?.authorization?.startsWith("Bearer ")).toBe(true);
      expect(fake.requests.some((request) => request.path.endsWith("/pulls"))).toBe(false);
    } finally {
      poller.stop();
      await poller.settled;
      await fake.stop();
      db.close();
    }
  });

  test("@paws in a comment triggers; @pawsome and untrusted NONE do not", async () => {
    const fake = startFakeGitHubRest();
    const db = tempDb();
    const updatedAt = iso(NOW);
    fake.addIssue("acme", "widgets", {
      number: 4,
      title: "Needs a mention",
      body: "no mention here",
      authorAssociation: "OWNER",
      updatedAt,
    });
    fake.addIssue("acme", "widgets", {
      number: 8,
      title: "Body mention",
      body: "\n@paws take this",
      authorAssociation: "COLLABORATOR",
      user: { login: "helper", id: 4 },
      updatedAt,
    });
    fake.addIssue("acme", "widgets", {
      number: 9,
      title: "Authenticated author",
      labels: ["paws"],
      authorAssociation: "NONE",
      user: { login: "octocat", id: 1 },
      updatedAt,
    });
    fake.addComment("acme", "widgets", {
      id: 11,
      issueNumber: 4,
      body: "please @paws look",
      authorAssociation: "MEMBER",
      user: { login: "mina", id: 2 },
      updatedAt,
    });
    fake.addComment("acme", "widgets", {
      id: 12,
      issueNumber: 4,
      body: "the @pawsome widget",
      authorAssociation: "OWNER",
      updatedAt,
    });
    fake.addComment("acme", "widgets", {
      id: 13,
      issueNumber: 4,
      body: "@paws do it",
      authorAssociation: "NONE",
      user: { login: "rando", id: 9 },
      updatedAt,
    });
    fake.addComment("acme", "widgets", {
      id: 14,
      issueNumber: 4,
      body: "/paws stop",
      authorAssociation: "OWNER",
      updatedAt,
    });
    fake.addComment("acme", "widgets", {
      id: 15,
      issueNumber: 4,
      body: "/paws stop",
      authorAssociation: "NONE",
      user: { login: "rando", id: 9 },
      updatedAt,
    });
    const triggers: string[] = [];
    const comments: string[] = [];
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    const waits: number[] = [];
    const poller = startGitHubIssuePoller({
      db,
      client: clientFor(fake),
      onTrigger(event) {
        triggers.push(`${event.kind}:${event.issueId}:${event.commentId ?? ""}`);
      },
      onComment(event) {
        comments.push(`${event.kind}:${event.commentId}`);
      },
      sleeper: blockingSleeper(waits),
      now: () => NOW,
      hot: () => false,
    });
    try {
      await waitFor(() => waits.length > 0 && triggers.length >= 3);
      expect(triggers.sort()).toEqual([
        "label:github:acme/widgets#9:",
        "mention:github:acme/widgets#4:11",
        "mention:github:acme/widgets#8:",
      ]);
      expect(comments).toEqual(["answer:12", "stop:14"]);
      expect(warnings.some((line) => line.includes("NONE") && line.includes("rando"))).toBe(true);
      expect(triggers.some((item) => item.includes("pawsome"))).toBe(false);
    } finally {
      console.warn = original;
      poller.stop();
      await poller.settled;
      await fake.stop();
      db.close();
    }
  });

  test("the second poll sends If-None-Match and a 304 does no work", async () => {
    const fake = startFakeGitHubRest();
    const db = tempDb();
    fake.addIssue("acme", "widgets", {
      number: 7,
      title: "Labeled",
      labels: ["paws"],
      authorAssociation: "OWNER",
      updatedAt: iso(NOW),
    });
    const triggers: number[] = [];
    const waits: number[] = [];
    const poller = startGitHubIssuePoller({
      db,
      client: clientFor(fake),
      onTrigger(event) {
        triggers.push(event.number);
      },
      onComment() {},
      sleeper: blockingSleeper(waits),
      now: () => NOW,
      hot: () => false,
    });
    try {
      await waitFor(() => triggers.length === 1 && waits.length > 0);
      await poller.pollNow();
      const lists = issueLists(fake);
      const commentLists = fake.requests.filter(
        (request) =>
          request.method === "GET" && request.path === "/repos/acme/widgets/issues/comments",
      );
      expect(lists.length).toBeGreaterThanOrEqual(2);
      expect(lists[0]?.ifNoneMatch).toBeNull();
      expect(lists[1]?.ifNoneMatch).toMatch(/^"[0-9a-f]+"$/);
      expect(lists[1]?.status).toBe(304);
      expect(commentLists[1]?.ifNoneMatch).toMatch(/^"[0-9a-f]+"$/);
      expect(commentLists[1]?.status).toBe(304);
      expect(triggers).toEqual([7]);
    } finally {
      poller.stop();
      await poller.settled;
      await fake.stop();
      db.close();
    }
  });

  test("the cursor survives a restart", async () => {
    const fake = startFakeGitHubRest();
    const db = tempDb();
    fake.addIssue("acme", "widgets", {
      number: 7,
      title: "First",
      labels: ["paws"],
      authorAssociation: "OWNER",
      updatedAt: iso(NOW),
    });
    const triggers: number[] = [];
    const first = startGitHubIssuePoller({
      db,
      client: clientFor(fake),
      onTrigger(event) {
        triggers.push(event.number);
      },
      onComment() {},
      sleeper: blockingSleeper([]),
      now: () => NOW,
      hot: () => false,
    });
    try {
      await waitFor(() => triggers.length === 1);
    } finally {
      first.stop();
      await first.settled;
    }
    const saved = db
      .query<{ cursor_ms: number }, [string]>(
        `SELECT cursor_ms FROM github_poll_state WHERE repo = ? AND kind = 'issues'`,
      )
      .get("acme/widgets");
    expect(saved?.cursor_ms).toBe(NOW);

    fake.addIssue("acme", "widgets", {
      number: 8,
      title: "Too old for the saved cursor",
      labels: ["paws"],
      authorAssociation: "OWNER",
      updatedAt: iso(NOW - 30 * 60 * 1000),
    });
    fake.addIssue("acme", "widgets", {
      number: 9,
      title: "Fresh",
      labels: ["paws"],
      authorAssociation: "OWNER",
      updatedAt: iso(NOW),
    });
    const before = issueLists(fake).length;
    const second = startGitHubIssuePoller({
      db,
      client: clientFor(fake),
      onTrigger(event) {
        triggers.push(event.number);
      },
      onComment() {},
      sleeper: blockingSleeper([]),
      now: () => NOW,
      hot: () => false,
    });
    try {
      await waitFor(() => triggers.includes(9));
      const next = issueLists(fake)[before];
      const since = next === undefined ? "" : new URLSearchParams(next.search).get("since");
      expect(Date.parse(since ?? "")).toBe(NOW - 5_000);
      expect(triggers).toEqual([7, 9]);
    } finally {
      second.stop();
      await second.settled;
      await fake.stop();
      db.close();
    }
  });

  test("403 with retry-after backs off and then resumes", async () => {
    const fake = startFakeGitHubRest();
    const db = tempDb();
    fake.failNext({ status: 403, retryAfter: "30", remaining: "0" });
    fake.addIssue("acme", "widgets", {
      number: 7,
      title: "After the limit",
      labels: ["paws"],
      authorAssociation: "OWNER",
      updatedAt: iso(NOW),
    });
    const waits: number[] = [];
    const triggers: number[] = [];
    const poller = startGitHubIssuePoller({
      db,
      client: clientFor(fake),
      onTrigger(event) {
        triggers.push(event.number);
      },
      onComment() {},
      sleeper: immediateSleeper(waits),
      now: () => NOW,
      hot: () => false,
    });
    try {
      await waitFor(() => triggers.length === 1);
      poller.stop();
      await poller.settled;
      expect(waits[0]).toBe(30_000);
      expect(fake.requests.some((request) => request.status === 403)).toBe(true);
      expect(triggers).toEqual([7]);
    } finally {
      poller.stop();
      await poller.settled;
      await fake.stop();
      db.close();
    }
  });

  test("a spent rate limit holds until reset", async () => {
    const fake = startFakeGitHubRest();
    const db = tempDb();
    fake.setRate(0, NOW + 40_000);
    const waits: number[] = [];
    const poller = startGitHubIssuePoller({
      db,
      client: clientFor(fake),
      onTrigger() {},
      onComment() {},
      sleeper: blockingSleeper(waits),
      now: () => NOW,
      hot: () => false,
    });
    try {
      await waitFor(() => waits.length > 0);
      expect(waits[0]).toBe(40_000);
    } finally {
      poller.stop();
      await poller.settled;
      await fake.stop();
      db.close();
    }
  });

  test("issue list pagination follows the next link", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("page=2")) {
        return new Response(JSON.stringify([rawIssue(8, "Eight")]), {
          status: 200,
          headers: { etag: '"p2"', "x-ratelimit-remaining": "40" },
        });
      }
      return new Response(JSON.stringify([rawIssue(7, "Seven")]), {
        status: 200,
        headers: {
          etag: '"p1"',
          link: '<http://github.test/repos/acme/widgets/issues?state=open&page=2>; rel="next"',
          "x-ratelimit-remaining": "41",
        },
      });
    };
    const client = createGitHubIssuesClient({
      provider: tokenProvider(),
      config: githubTrackerConfig({ repos: ["acme/widgets"] }),
      fetch: fetchImpl,
      baseUrl: "http://github.test",
    });
    const page = await client.listOpenIssues(
      { owner: "acme", repo: "widgets" },
      new Date(NOW).toISOString(),
      null,
    );
    expect(page.items.map((issue) => issue.number)).toEqual([7, 8]);
    expect(seen).toHaveLength(2);
    expect(page.notModified).toBe(false);
  });
});

function tokenProvider(): GitHubTokenProvider {
  return {
    source: "oauth",
    async token() {
      return "gho_test";
    },
    async user() {
      return { login: "octocat", id: 1 };
    },
  };
}

function clientFor(
  fake: FakeGitHubRest,
  provider: GitHubTokenProvider = tokenProvider(),
): GitHubIssuesClient {
  return createGitHubIssuesClient({
    provider,
    config: githubTrackerConfig({ repos: ["acme/widgets"] }),
    baseUrl: fake.origin,
  });
}

function issueLists(fake: FakeGitHubRest) {
  return fake.requests.filter(
    (request) => request.method === "GET" && request.path === "/repos/acme/widgets/issues",
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function rawIssue(number: number, title: string): Record<string, unknown> {
  return {
    number,
    title,
    body: null,
    user: { login: "octocat", id: 1 },
    author_association: "OWNER",
    labels: [{ name: "paws" }],
    updated_at: iso(NOW),
    html_url: `https://github.com/acme/widgets/issues/${number}`,
  };
}

function blockingSleeper(waits: number[]): Sleeper {
  let resolveWait: (() => void) | null = null;
  return {
    wait(ms) {
      waits.push(ms);
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

function immediateSleeper(waits: number[]): Sleeper {
  return {
    wait(ms) {
      waits.push(ms);
      return Promise.resolve();
    },
    wake() {},
  };
}

function gatedSleeper(waits: number[]): { sleeper: Sleeper; release(): void } {
  let resolveWait: (() => void) | null = null;
  return {
    sleeper: {
      wait(ms) {
        waits.push(ms);
        return new Promise((resolve) => {
          resolveWait = resolve;
        });
      },
      wake() {
        resolveWait?.();
        resolveWait = null;
      },
    },
    release() {
      resolveWait?.();
      resolveWait = null;
    },
  };
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 2_000) throw new Error("timed out waiting for github poll");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
