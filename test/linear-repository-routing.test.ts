import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FakeClock, type RepositoryBinding } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  enqueueJob,
  getWorkItem,
  getWorkItemRepository,
  listJobs,
  saveConversation,
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
  expect(repositoryAnswer("acme/two", repositories)).toEqual(repositories[1]!);
  expect(repositoryAnswer("https://github.com/acme/two", repositories)).toEqual(repositories[1]!);
  expect(repositoryAnswer("TWO", repositories)).toEqual(repositories[1]!);
  for (const answer of [
    "acme/elsewhere",
    "acme/one or acme/two",
    "please use acme/two",
    "Do not use acme/one; use the first option instead.",
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
    actorId: "human",
    activityCreatedAtMs: 2_000,
    payload: JSON.stringify({ answeredBy: "human" }),
  };
}

function fixture(
  options: {
    channel?: "comments" | "agent-session";
    issueId?: string;
    defaultRepository?: boolean;
    interpretation?: { output: string; hang?: boolean; removeAccess?: string };
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
  const interpretationTraces: string[] = [];
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
      launch: (input) => {
        launches++;
        if (input.purpose === "select_repository" && options.interpretation) {
          expect(existsSync(join(pawsRoot, "worktrees"))).toBe(false);
          expect(tracker.statuses).toEqual([]);
          if (options.interpretation.removeAccess) denied.add(options.interpretation.removeAccess);
          const script = join(pawsRoot, `${launches}.script.json`);
          const trace = join(pawsRoot, `${launches}.trace.json`);
          interpretationTraces.push(trace);
          writeFileSync(
            script,
            JSON.stringify({
              steps: [
                { type: "fs_write", path: "forbidden.txt", content: "denied" },
                ...(options.interpretation.hang ? [{ type: "hang" }] : []),
                {
                  type: "update",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: options.interpretation.output },
                  },
                },
                { type: "end" },
              ],
            }),
          );
          return {
            command: process.execPath,
            args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          };
        }
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
    interpretationTraces,
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

test.each(["https://github.com/acme/two.git", "https://github.com/ACME/TWO.git"])(
  "a pasted clone URL %s selects the offered repository without interpretation",
  async (answer) => {
    const f = fixture();
    try {
      const orchestrator = f.attach();
      await orchestrator.onLinearEvent(event());
      await f.jobs.tick();
      const question = findOpenQuestion(f.db, "session")!;
      await orchestrator.onLinearEvent(event(answer));
      await f.jobs.tick();
      expect(getWorkItemRepository(f.db, question.itemId)).toEqual(repositories[1]!);
      expect(f.interpretationTraces).toEqual([]);
    } finally {
      f.db.close();
    }
  },
);

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
  const f = fixture({ interpretation: { output: '{"repositoryFullName":"acme/two"}' } });
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

test.each([
  { output: '{"repositoryFullName":"acme/one"}', selected: true },
  { output: '{"repositoryFullName":null}', selected: false },
  { output: '{"repositoryFullName":"acme/private"}', selected: false },
  { output: '{"repositoryFullName":"acme/elsewhere"}', selected: false },
  { output: "probably the second", selected: false },
])(
  "natural-language repository answers remain constrained to accessible offered choices: $output",
  async ({ output, selected }) => {
    const f = fixture({ interpretation: { output } });
    try {
      let orchestrator = f.attach();
      await orchestrator.onLinearEvent(event());
      await f.jobs.tick();
      const question = findOpenQuestion(f.db, "session")!;
      await orchestrator.onLinearEvent(event("Use the second option, the frontend one."));
      orchestrator = f.attach();
      await f.jobs.tick();
      expect(f.launches()).toBe(1);
      const trace = JSON.parse(readFileSync(f.interpretationTraces[0]!, "utf8"));
      const prompt = trace.prompts[0][0].text as string;
      expect(prompt).toContain("Use the second option, the frontend one.");
      expect(prompt).toContain('"offeredOptions":["acme/two","acme/one"]');
      expect(prompt).not.toContain("acme/private");
      expect(trace.fs[0]).toMatchObject({ op: "write", ok: false });
      expect(getWorkItemRepository(f.db, question.itemId)).toEqual(
        selected ? repositories[0]! : null,
      );
      if (!selected) {
        expect(findOpenQuestion(f.db, "session")?.id).not.toBe(question.id);
        expect(existsSync(join(f.pawsRoot, "worktrees"))).toBe(false);
        expect(f.tracker.statuses).toEqual([]);
      }
      expect(orchestrator).toBeDefined();
    } finally {
      f.db.close();
    }
  },
);

test.each([
  "Do not use acme/one; use the first option instead.",
  "Do not use acme/private; use the first option instead.",
  "Use the first option, the frontend/backend repository.",
])(
  "repository prose is interpreted without treating every named path as a choice: %s",
  async (reply) => {
    const f = fixture({ interpretation: { output: '{"repositoryFullName":"acme/two"}' } });
    try {
      const orchestrator = f.attach();
      await orchestrator.onLinearEvent(event());
      await f.jobs.tick();
      const question = findOpenQuestion(f.db, "session")!;
      await orchestrator.onLinearEvent(event(reply));
      await f.jobs.tick();
      expect(f.launches()).toBe(1);
      expect(getWorkItemRepository(f.db, question.itemId)).toEqual(repositories[1]!);
      const trace = JSON.parse(readFileSync(f.interpretationTraces[0]!, "utf8"));
      expect(trace.prompts[0][0].text).toContain(reply);
    } finally {
      f.db.close();
    }
  },
);

test("an inaccessible original option is not renumbered into a different repository", async () => {
  const f = fixture({ interpretation: { output: '{"repositoryFullName":"acme/two"}' } });
  try {
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    f.denied.add("two");
    await orchestrator.onLinearEvent(event("Use the first option."));
    await f.jobs.tick();
    expect(getWorkItemRepository(f.db, question.itemId)).toBeNull();
    expect(findOpenQuestion(f.db, "session")?.options).toEqual(["https://github.com/acme/one"]);
    const trace = JSON.parse(readFileSync(f.interpretationTraces[0]!, "utf8"));
    expect(trace.prompts[0][0].text).toContain('"offeredOptions":["acme/two","acme/one"]');
    expect(trace.prompts[0][0].text).toContain('"accessibleCandidates":["acme/one"]');
    expect(f.tracker.statuses).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("access removed during interpretation prevents binding and asks with the remaining choices", async () => {
  const f = fixture({
    interpretation: { output: '{"repositoryFullName":"acme/one"}', removeAccess: "one" },
  });
  try {
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    await orchestrator.onLinearEvent(event("Use the second option."));
    await f.jobs.tick();
    expect(f.interpretationTraces).toHaveLength(1);
    expect(getWorkItemRepository(f.db, question.itemId)).toBeNull();
    expect(findOpenQuestion(f.db, "session")?.options).toEqual(["https://github.com/acme/two"]);
    expect(existsSync(join(f.pawsRoot, "worktrees"))).toBe(false);
    expect(f.tracker.statuses).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("Stop interrupts repository interpretation before any binding or repository access", async () => {
  const f = fixture({
    interpretation: { output: '{"repositoryFullName":"acme/one"}', hang: true },
  });
  let pending: Promise<unknown> | undefined;
  try {
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    await orchestrator.onLinearEvent(event("Use the frontend one."));
    pending = f.jobs.tick();
    let started = false;
    for (let i = 0; i < 1000 && !started; i++) {
      try {
        started = JSON.parse(readFileSync(f.interpretationTraces[0]!, "utf8")).methods.includes(
          "session/prompt",
        );
      } catch {}
      if (!started) await Bun.sleep(1);
    }
    expect(started).toBe(true);
    await orchestrator.onLinearEvent({
      ...event(),
      dedupeKey: "stop",
      action: "prompted",
      signal: "stop",
    });
    await pending;
    expect(getWorkItemRepository(f.db, question.itemId)).toBeNull();
    expect(getWorkItem(f.db, question.itemId)?.state).toBe("cancelled");
    expect(f.tracker.statuses).toEqual([]);
    expect(existsSync(join(f.pawsRoot, "worktrees"))).toBe(false);
  } finally {
    await pending;
    f.db.close();
  }
}, 15000);

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

test("a persisted cleanup fence prevents another repository interpreter or selection", async () => {
  const f = fixture();
  try {
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    const item = f.db.query<{ id: string }, []>("SELECT id FROM work_item").get()!;
    saveConversation(f.db, item.id, "[]", null, true);
    await f.jobs.tick();
    expect(f.launches()).toBe(0);
    expect(findOpenQuestion(f.db, "session")).toBeNull();
    expect(getWorkItemRepository(f.db, item.id)).toBeNull();
  } finally {
    f.db.close();
  }
});
