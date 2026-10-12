import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, type RepositoryBinding } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  enqueueJob,
  getWorkItem,
  getWorkItemRepository,
  listJobs,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, repositoryAnswer, routeBySource } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { withCommentActivities } from "../src/comments";
import { tempDb, tempHome } from "./helpers";

const repositories: RepositoryBinding[] = ["one", "two", "private"].map((repo) => ({
  owner: "acme",
  repo,
  remoteUrl: `/synthetic-paws-remotes/${repo}.git`,
}));

test("repository answers select only an unambiguous offered repository", () => {
  expect(repositoryAnswer("2", repositories)).toEqual(repositories[1]!);
  expect(repositoryAnswer("please use acme/two", repositories)).toEqual(repositories[1]!);
  expect(repositoryAnswer("https://github.com/acme/two", repositories)).toEqual(repositories[1]!);
  expect(repositoryAnswer("TWO", repositories)).toEqual(repositories[1]!);
  for (const answer of [
    "acme/elsewhere",
    "acme/one or acme/two",
    "0",
    "999",
    "",
    "https://evil.test/acme/two",
  ]) {
    expect(repositoryAnswer(answer, repositories)).toBeNull();
  }
  expect(
    repositoryAnswer("two", [repositories[1]!, { ...repositories[1]!, owner: "other" }]),
  ).toBeNull();
});

function event(body: string | null = null): AcceptedLinearEvent {
  return {
    dedupeKey: body === null ? "created:session" : `answer:${body}`,
    deliveryId: null,
    source: "webhook",
    action: body === null ? "created" : "prompted",
    sessionId: "session",
    issueId: "issue",
    activityId: body === null ? null : `answer:${body}`,
    body,
    signal: null,
    updatedAtMs: 2_000,
    payload: JSON.stringify({ answeredBy: "human" }),
  };
}

function fixture(
  options: {
    channel?: "comments" | "agent-session";
    issueId?: string;
    defaultRepository?: boolean;
  } = {},
) {
  const db = tempDb();
  const pawsRoot = tempHome();
  const clock = new FakeClock(1_000);
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const tracker = createFakeTracker([
    {
      linearIssueId: options.issueId ?? "issue",
      identifier: "ENG-1",
      title: "Implement export",
      description: null,
      subIssues: [],
    },
  ]);
  tracker.repositorySuggestions.set("issue", [
    { hostname: "github.com", repositoryFullName: "acme/two", confidence: 0.99 },
  ]);
  const denied = new Set(["private"]);
  const unavailable = new Set<string>();
  const checked: string[] = [];
  let launches = 0;
  const attach = () =>
    attachOrchestrator({
      db,
      jobs,
      outbox,
      tracker,
      pawsRoot,
      clock,
      channel: options.channel,
      repository: options.defaultRepository ? repositories[0] : undefined,
      repositories: [...repositories, repositories[0]!],
      repositoryAccess: async (repository) => {
        checked.push(repository.repo);
        if (unavailable.has(repository.repo)) throw new Error("Temporary GitHub failure");
        return !denied.has(repository.repo);
      },
      launch: () => {
        launches++;
        throw new Error("Fixture stops before agent launch");
      },
    });
  return {
    db,
    pawsRoot,
    jobs,
    tracker,
    denied,
    unavailable,
    checked,
    clock,
    attach,
    launches: () => launches,
  };
}

test("an incomplete access scan retries without binding the surviving repository", async () => {
  const f = fixture();
  try {
    f.unavailable.add("two");
    await f.attach().onLinearEvent(event());
    await f.jobs.tick();
    const item = f.db.query<{ id: string }, []>("SELECT id FROM work_item").get()!;
    expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
    expect(getWorkItemRepository(f.db, item.id)).toBeNull();
    expect(findOpenQuestion(f.db, "session")).toBeNull();
    expect(listJobs(f.db).some((job) => job.status === "pending" && job.attempts === 1)).toBe(true);
    f.unavailable.clear();
    f.clock.advance(10_000);
    await f.jobs.tick();
    expect(findOpenQuestion(f.db, "session")?.options).toHaveLength(2);
    expect(getWorkItemRepository(f.db, item.id)).toBeNull();
  } finally {
    f.db.close();
  }
});

test("an obsolete merge job cannot bind the default while a repository answer is pending", async () => {
  const f = fixture({ defaultRepository: true });
  try {
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    enqueueJob(f.db, {
      queue: "github.merge",
      payload: { itemId: question.itemId },
      now: f.clock.now(),
    });
    await f.jobs.tick();
    expect(getWorkItemRepository(f.db, question.itemId)).toBeNull();
    await orchestrator.onLinearEvent(event("acme/two"));
    await f.jobs.tick();
    expect(getWorkItemRepository(f.db, question.itemId)).toEqual(repositories[1]!);
  } finally {
    f.db.close();
  }
});

test("ambiguous configured repositories ask before any worktree or issue-state mutation", async () => {
  const f = fixture();
  try {
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    expect(question.options).toEqual([
      "https://github.com/acme/two",
      "https://github.com/acme/one",
    ]);
    expect(getWorkItem(f.db, question.itemId)?.state).toBe("awaiting_input");
    expect(f.checked).toEqual(["one", "two", "private"]);
    expect(f.tracker.repositorySuggestionRequests).toEqual([
      {
        issueId: "issue",
        agentSessionId: "session",
        candidateRepositories: [
          { hostname: "github.com", repositoryFullName: "acme/one" },
          { hostname: "github.com", repositoryFullName: "acme/two" },
        ],
      },
    ]);
    expect(f.launches()).toBe(0);
    expect(f.tracker.statuses).toEqual([]);
    expect(existsSync(join(f.pawsRoot, "worktrees"))).toBe(false);
    await orchestrator.onLinearEvent(event("please use acme/two"));
    expect(
      listJobs(f.db).some((job) => job.queue === "run.resume" && job.status === "pending"),
    ).toBe(true);
    const restored = f.attach();
    expect(restored).toBeDefined();
    await f.jobs.tick();
    expect(getWorkItemRepository(f.db, question.itemId)).toEqual(repositories[1]!);
  } finally {
    f.db.close();
  }
});

test.each(["acme/elsewhere", "acme/two"])(
  "invalid or newly inaccessible answer %s asks again",
  async (answer) => {
    const f = fixture();
    try {
      const orchestrator = f.attach();
      await orchestrator.onLinearEvent(event());
      await f.jobs.tick();
      const before = findOpenQuestion(f.db, "session")!;
      if (answer === "acme/two") f.denied.add("two");
      await orchestrator.onLinearEvent(event(answer));
      await f.jobs.tick();
      const after = findOpenQuestion(f.db, "session")!;
      expect(after.id).not.toBe(before.id);
      expect(getWorkItemRepository(f.db, before.itemId)).toBeNull();
      expect(f.launches()).toBe(0);
      if (answer === "acme/two") expect(after.options).toEqual(["https://github.com/acme/one"]);
    } finally {
      f.db.close();
    }
  },
);

test("comment-mode repository suggestions omit synthetic agent-session IDs", async () => {
  const f = fixture({ channel: "comments" });
  try {
    await f.attach().onLinearEvent(event());
    await f.jobs.tick();
    expect(f.tracker.repositorySuggestionRequests[0]?.agentSessionId).toBeUndefined();
    expect(withCommentActivities(f.tracker, f.tracker).issueRepositorySuggestions).toBeDefined();
    expect(
      routeBySource({ linear: f.tracker, github: null }).issueRepositorySuggestions,
    ).toBeDefined();
  } finally {
    f.db.close();
  }
});

test("GitHub source issues bind only their configured source repository", async () => {
  const f = fixture({ issueId: "github:acme/two#1" });
  try {
    await f
      .attach()
      .onLinearEvent({ ...event(), issueId: "github:acme/two#1", sessionId: "github:acme/two#1" });
    await f.jobs.tick();
    const row = f.db.query<{ id: string }, []>("SELECT id FROM work_item").get()!;
    expect(getWorkItemRepository(f.db, row.id)).toEqual(repositories[1]!);
    expect(f.checked).toEqual(["two"]);
    expect(f.tracker.repositorySuggestionRequests).toEqual([]);
    expect(
      f.tracker.questions.some((question) => question.body.startsWith("Which repository")),
    ).toBe(false);
  } finally {
    f.db.close();
  }
});
