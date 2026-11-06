import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FakeClock, type RepositoryBinding } from "../src/core";
import {
  refreshRepositoryCatalog,
  JobLoop,
  OutboxDispatcher,
  enqueueJob,
  getWorkItem,
  getWorkItemRepository,
  getWorkItemRepositoryChoice,
  listJobs,
  listOutbox,
  listWorkspaceRepositories,
  saveConversation,
  type WorkItemRecord,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import {
  attachOrchestrator,
  FakeGitHubIntegration,
  GitHubInstallationCheck,
  type GitHubIntegration,
  hintedRepository,
  repositoryAnswer,
  teamRepositoryDenial,
} from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { tempDb, tempHome } from "./helpers";
import { workspaceAdmission, workspaceDispatch } from "./fake-workspace";

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
    issueId?: string;
    auth?: GitHubIntegration;
    interpretation?: { output: string; hang?: boolean; removeAccess?: string };
    confidence?: number;
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
    {
      hostname: "github.com",
      repositoryFullName: "acme/two",
      confidence: options.confidence ?? 0.5,
    },
  ]);
  const denied = new Set(["private"]);
  const unavailable = new Set<string>();
  const checked: string[] = [];
  let launches = 0;
  const interpretationTraces: string[] = [];
  const attach = () =>
    attachOrchestrator({
      db,
      admission: workspaceAdmission(db),
      jobs,
      outbox,
      tracker,
      pawsRoot,
      clock,
      githubInstallation: options.auth,
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

test("a natural-language repository choice survives an installation wait and restart before access or binding", async () => {
  const host = new FakeGitHubIntegration();
  host.installed = false;
  const f = fixture({
    auth: host,
    interpretation: { output: '{"repositoryFullName":"acme/two"}' },
  });
  let orchestrator = f.attach();
  try {
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const repositoryQuestion = findOpenQuestion(f.db, "session")!;
    expect(f.checked).toEqual([]);
    expect(f.tracker.statuses).toEqual([]);
    await orchestrator.onLinearEvent(event("Use the backend one, acme/two."));
    await f.jobs.tick();
    const authQuestion = findOpenQuestion(f.db, "session")!;
    expect(authQuestion.id).not.toBe(repositoryQuestion.id);
    expect(getWorkItemRepositoryChoice(f.db, repositoryQuestion.itemId)).toEqual(repositories[1]!);
    expect(getWorkItemRepository(f.db, repositoryQuestion.itemId)).toBeNull();
    expect(f.launches()).toBe(1);
    expect(f.checked).toEqual([]);
    expect(existsSync(join(f.pawsRoot, "worktrees"))).toBe(false);
    await orchestrator.shutdown();
    orchestrator = f.attach();
    await orchestrator.recoverGitHubAuth();
    expect(getWorkItemRepository(f.db, repositoryQuestion.itemId)).toBeNull();
    host.installed = true;
    await orchestrator.recoverGitHubAuth();
    await f.jobs.tick();
    expect(getWorkItemRepository(f.db, repositoryQuestion.itemId)).toEqual(repositories[1]!);
    expect(f.checked).toEqual(["two"]);
    expect(f.launches()).toBe(1);
  } finally {
    await orchestrator.shutdown();
    f.db.close();
  }
});

test("a ready installation cannot bind a provisionally chosen inaccessible repository", async () => {
  const host = new FakeGitHubIntegration();
  const f = fixture({ auth: host });
  const orchestrator = f.attach();
  try {
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    await orchestrator.onLinearEvent(event("acme/private"));
    await f.jobs.tick();
    expect(getWorkItemRepository(f.db, question.itemId)).toBeNull();
    expect(f.checked).toEqual(["private"]);
    expect(findOpenQuestion(f.db, "session")?.id).not.toBe(question.id);
    expect(f.tracker.statuses).toEqual([]);
    expect(f.launches()).toBe(0);
  } finally {
    await orchestrator.shutdown();
    f.db.close();
  }
});

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
    expect(
      listJobs(f.db).some(
        (job) =>
          job.status === "pending" &&
          (job.attempts === 1 || (job.payload as { reason?: string }).reason === "follow_up"),
      ),
    ).toBe(true);
    f.unavailable.clear();
    f.clock.advance(10_000);
    workspaceDispatch(f.db, { now: f.clock.now() });
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

test("an obsolete merge job cannot bind a repository while a repository answer is pending", async () => {
  const f = fixture();
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
    expect(question.kind).toBe("repository");
    expect(question.options).toEqual([
      "https://github.com/acme/two",
      "https://github.com/acme/one",
    ]);
    expect(getWorkItem(f.db, question.itemId)?.state).toBe("awaiting_input");
    expect(f.checked).toEqual(["one", "two", "private"]);
    const request = {
      issueId: "issue",
      candidateRepositories: [
        { hostname: "github.com", repositoryFullName: "acme/one" },
        { hostname: "github.com", repositoryFullName: "acme/two" },
      ],
    };
    expect(f.tracker.repositorySuggestionRequests).toEqual([request, request, request]);
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

test("a confident Linear suggestion binds the repository without a question", async () => {
  const f = fixture({ confidence: 0.95 });
  try {
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    expect(
      f.db.query("SELECT 1 FROM question WHERE body LIKE 'Which repository%'").get(),
    ).toBeNull();
    const itemId = (f.db.query("SELECT id FROM work_item").get() as { id: string }).id;
    expect(getWorkItemRepository(f.db, itemId)).toEqual(repositories[1]!);
    expect(f.tracker.progress.map((update) => update.body)).toContain("Working in acme/two.");
  } finally {
    f.db.close();
  }
});

test("a failed Linear suggestion read is retried before asking", async () => {
  const f = fixture({ confidence: 0.95 });
  try {
    const read = f.tracker.issueRepositorySuggestions.bind(f.tracker);
    let calls = 0;
    f.tracker.issueRepositorySuggestions = async (input, options) => {
      calls += 1;
      if (calls === 1) throw new Error("Linear GraphQL: RATELIMITED");
      return read(input, options);
    };
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    expect(
      f.db.query("SELECT 1 FROM question WHERE body LIKE 'Which repository%'").get(),
    ).toBeNull();
    const itemId = (f.db.query("SELECT id FROM work_item").get() as { id: string }).id;
    expect(getWorkItemRepository(f.db, itemId)).toEqual(repositories[1]!);
  } finally {
    f.db.close();
  }
});

test("a retried repository selection reuses the hints and suggestions it already read", async () => {
  const f = fixture({ confidence: 0.95 });
  try {
    const readHints = f.tracker.issueRepositoryHints!.bind(f.tracker);
    let hintReads = 0;
    f.tracker.issueRepositoryHints = async (issueId, options) => {
      hintReads += 1;
      return readHints(issueId, options);
    };
    const readSuggestions = f.tracker.issueRepositorySuggestions.bind(f.tracker);
    let suggestionReads = 0;
    f.tracker.issueRepositorySuggestions = async (input, options) => {
      suggestionReads += 1;
      if (suggestionReads === 3) f.unavailable.add("two");
      return readSuggestions(input, options);
    };
    await f.attach().onLinearEvent(event());
    await f.jobs.tick();
    const itemId = (f.db.query("SELECT id FROM work_item").get() as { id: string }).id;
    expect(getWorkItemRepository(f.db, itemId)).toBeNull();
    expect([hintReads, suggestionReads]).toEqual([1, 3]);
    f.unavailable.clear();
    f.clock.advance(10_000);
    workspaceDispatch(f.db, { now: f.clock.now() });
    await f.jobs.tick();
    expect(getWorkItemRepository(f.db, itemId)).toEqual(repositories[1]!);
    expect([hintReads, suggestionReads]).toEqual([1, 3]);
  } finally {
    f.db.close();
  }
});

test("noisy Linear suggestions are sampled and the best clear leader binds", async () => {
  const f = fixture();
  try {
    const answers = [
      [{ hostname: "github.com", repositoryFullName: "acme/one", confidence: 0.58 }],
      [
        { hostname: "github.com", repositoryFullName: "acme/two", confidence: 0.7 },
        { hostname: "github.com", repositoryFullName: "acme/one", confidence: 0.58 },
      ],
      [{ hostname: "github.com", repositoryFullName: "acme/one", confidence: 0.58 }],
    ];
    f.tracker.issueRepositorySuggestions = async () => answers.shift()!;
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    expect(
      f.db.query("SELECT 1 FROM question WHERE body LIKE 'Which repository%'").get(),
    ).toBeNull();
    const itemId = (f.db.query("SELECT id FROM work_item").get() as { id: string }).id;
    expect(getWorkItemRepository(f.db, itemId)).toEqual(repositories[1]!);
    expect(answers).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("close Linear suggestions ask with the top three repositories", async () => {
  const f = fixture({ confidence: 0.95 });
  try {
    f.denied.delete("private");
    f.tracker.repositorySuggestions.set("issue", [
      { hostname: "github.com", repositoryFullName: "acme/two", confidence: 0.85 },
      { hostname: "github.com", repositoryFullName: "acme/one", confidence: 0.8 },
    ]);
    await refreshRepositoryCatalog(f.db, async () => [
      {
        owner: "acme",
        repo: "four",
        remoteUrl: "/synthetic-paws-remotes/four.git",
        defaultBranch: "main",
      },
    ]);
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    expect(findOpenQuestion(f.db, "session")!.options).toEqual([
      "https://github.com/acme/two",
      "https://github.com/acme/one",
      "https://github.com/acme/private",
    ]);
    expect(
      f.tracker.repositorySuggestionRequests[0]!.candidateRepositories.map(
        (candidate) => candidate.repositoryFullName,
      ),
    ).toContain("acme/four");
  } finally {
    f.db.close();
  }
});

test("a repository the app can access is chosen from Linear's suggestion without configuring it", async () => {
  const f = fixture();
  try {
    await refreshRepositoryCatalog(f.db, async () => [
      {
        owner: "acme",
        repo: "four",
        remoteUrl: "/synthetic-paws-remotes/four.git",
        defaultBranch: "main",
      },
    ]);
    f.tracker.repositorySuggestions.set("issue", [
      { hostname: "github.com", repositoryFullName: "acme/four", confidence: 0.95 },
    ]);
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    expect(
      f.db.query("SELECT 1 FROM question WHERE body LIKE 'Which repository%'").get(),
    ).toBeNull();
    expect(
      f.tracker.repositorySuggestionRequests[0]!.candidateRepositories.map(
        (candidate) => candidate.repositoryFullName,
      ),
    ).toEqual(["acme/one", "acme/two", "acme/four"]);
    const itemId = (f.db.query("SELECT id FROM work_item").get() as { id: string }).id;
    expect(getWorkItemRepository(f.db, itemId)).toEqual({
      owner: "acme",
      repo: "four",
      remoteUrl: "/synthetic-paws-remotes/four.git",
    });
    expect(f.checked).toEqual(["one", "two", "private", "four"]);
  } finally {
    f.db.close();
  }
});

test("a confident suggestion passes an integration that checks the item's repository", async () => {
  const host = new FakeGitHubIntegration({
    authorize: async (item: WorkItemRecord) => getWorkItemRepository(f.db, item.id) !== null,
  });
  const f = fixture({ auth: host, confidence: 0.95 });
  try {
    await f.attach().onLinearEvent(event());
    await f.jobs.tick();
    const item = f.db.query("SELECT id, state FROM work_item").get() as {
      id: string;
      state: string;
    };
    expect(item.state).not.toBe("cancelled");
    expect(getWorkItemRepository(f.db, item.id)).toEqual(repositories[1]!);
  } finally {
    f.db.close();
  }
});

/** The host's repository rule over the fake workspace: the session's team and the chosen repository. */
function teamRepositoryIntegration(db: ReturnType<typeof tempDb>) {
  const decisions: unknown[] = [];
  const integration = new FakeGitHubIntegration({
    authorize: async (item: WorkItemRecord) => {
      const scope = db
        .query<{ workspaceId: string; teamId: string }, [string]>(
          `SELECT w.id AS workspaceId,s.team_id AS teamId FROM linear_session s
           JOIN workspace w ON w.linear_organization_id=s.organization_id WHERE s.session_id=?`,
        )
        .get(item.sessionKey ?? "");
      const repository =
        getWorkItemRepository(db, item.id) ?? getWorkItemRepositoryChoice(db, item.id);
      const decision =
        scope && repository ? (teamRepositoryDenial(db, item, scope, repository) ?? true) : false;
      decisions.push(decision);
      return decision;
    },
  });
  return Object.assign(integration, { decisions });
}

for (const source of ["a repo label", "a confident Linear suggestion"] as const) {
  test(`an unmapped team's delegation binds a catalog repository from ${source} and starts`, async () => {
    let integration: ReturnType<typeof teamRepositoryIntegration> | undefined;
    const f = fixture({
      confidence: 0.95,
      get auth() {
        return integration;
      },
    });
    integration = teamRepositoryIntegration(f.db);
    try {
      await refreshRepositoryCatalog(f.db, async () => [
        {
          owner: "acme",
          repo: "four",
          remoteUrl: "/synthetic-paws-remotes/four.git",
          defaultBranch: "main",
        },
      ]);
      if (source === "a repo label") {
        f.tracker.repositoryHints.set("issue", hints({ issueLabels: ["acme/four"] }));
        f.tracker.repositorySuggestions.set("issue", []);
      } else
        f.tracker.repositorySuggestions.set("issue", [
          { hostname: "github.com", repositoryFullName: "acme/four", confidence: 0.95 },
        ]);
      await f.attach().onLinearEvent(event());
      await f.jobs.tick();
      const item = f.db.query("SELECT id, state FROM work_item").get() as {
        id: string;
        state: string;
      };
      expect(listWorkspaceRepositories(f.db, "workspace")).toEqual([]);
      expect(item.state).not.toBe("cancelled");
      expect(getWorkItemRepository(f.db, item.id)).toEqual({
        owner: "acme",
        repo: "four",
        remoteUrl: "/synthetic-paws-remotes/four.git",
      });
      expect(integration.decisions.length).toBeGreaterThan(0);
      expect(integration.decisions.every((decision) => decision === true)).toBe(true);
      expect(
        f.db.query("SELECT 1 FROM question WHERE body LIKE 'Which repository%'").get(),
      ).toBeNull();
      expect(f.tracker.progress.map((update) => update.body)).toContain("Working in acme/four.");
      if (source === "a repo label") expect(f.tracker.repositorySuggestionRequests).toEqual([]);
    } finally {
      f.db.close();
    }
  });
}

test("a bound repository outside the team's new links is explained once, not cancelled from Linear", async () => {
  let integration: ReturnType<typeof teamRepositoryIntegration> | undefined;
  const f = fixture({
    get auth() {
      return integration;
    },
  });
  integration = teamRepositoryIntegration(f.db);
  const check = new GitHubInstallationCheck(f.db, integration, () => f.clock.now());
  try {
    await refreshRepositoryCatalog(f.db, async () => [
      {
        owner: "acme",
        repo: "four",
        remoteUrl: "/synthetic-paws-remotes/four.git",
        defaultBranch: "main",
      },
    ]);
    f.tracker.repositoryHints.set("issue", hints({ issueLabels: ["acme/four"] }));
    await f.attach().onLinearEvent(event());
    await f.jobs.tick();
    const id = (f.db.query("SELECT id FROM work_item").get() as { id: string }).id;
    expect(getWorkItemRepository(f.db, id)?.repo).toBe("four");
    f.db.run(
      "INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES('workspace','acme/one','team')",
    );
    const signal = new AbortController().signal;
    expect(await check.ensure(getWorkItem(f.db, id)!, "publication", signal, { fresh: true })).toBe(
      false,
    );
    expect(await check.ensure(getWorkItem(f.db, id)!, "publication", signal, { fresh: true })).toBe(
      false,
    );
    expect(getWorkItem(f.db, id)?.state).toBe("cancelled");
    const responses = listOutbox(f.db)
      .filter((entry) => entry.delivery === "stop")
      .map((entry) => (entry.payload as { body: string }).body);
    expect(responses).toEqual(["acme/four isn't mapped to ENG in Paws."]);
  } finally {
    check.close();
    f.db.close();
  }
});

const hints = (
  overrides: Partial<
    Record<"mentions" | "issueLabels" | "parentLabels" | "projectLabels", string[]>
  >,
) => ({
  mentions: [],
  issueLabels: [],
  parentLabels: [],
  projectLabels: [],
  ...overrides,
});

test("repository hints follow mention, issue, parent, then project precedence", () => {
  const [one, two, third] = repositories as [
    RepositoryBinding,
    RepositoryBinding,
    RepositoryBinding,
  ];
  expect(hintedRepository(repositories, hints({}))).toBeNull();
  expect(
    hintedRepository(
      repositories,
      hints({ mentions: ["acme/one", "ACME/Two"], issueLabels: ["acme/private"] }),
    ),
  ).toEqual({ bind: two });
  expect(
    hintedRepository(
      repositories,
      hints({
        issueLabels: ["acme/private"],
        parentLabels: ["acme/one"],
        projectLabels: ["acme/two"],
      }),
    ),
  ).toEqual({ bind: third });
  expect(
    hintedRepository(
      repositories,
      hints({ parentLabels: ["acme/one"], projectLabels: ["acme/two"] }),
    ),
  ).toEqual({ bind: one });
  expect(hintedRepository(repositories, hints({ projectLabels: ["acme/two"] }))).toEqual({
    bind: two,
  });
  expect(hintedRepository(repositories, hints({ issueLabels: ["acme/two", "acme/one"] }))).toEqual({
    ask: [two, one],
  });
  expect(
    hintedRepository(
      repositories,
      hints({ mentions: ["acme/missing"], projectLabels: ["acme/one"] }),
    ),
  ).toEqual({ bind: one });
});

test("a repo label on the issue binds without asking or reading suggestions", async () => {
  const f = fixture();
  try {
    f.tracker.repositoryHints.set(
      "issue",
      hints({ issueLabels: ["acme/one"], projectLabels: ["acme/two"] }),
    );
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    expect(
      f.db.query("SELECT 1 FROM question WHERE body LIKE 'Which repository%'").get(),
    ).toBeNull();
    const itemId = (f.db.query("SELECT id FROM work_item").get() as { id: string }).id;
    expect(getWorkItemRepository(f.db, itemId)).toEqual(repositories[0]!);
    expect(f.tracker.repositorySuggestionRequests).toEqual([]);
    expect(f.checked).toContain("one");
  } finally {
    f.db.close();
  }
});

test("two repo labels on the issue ask with just those repositories", async () => {
  const f = fixture({ confidence: 0.95 });
  try {
    f.denied.delete("private");
    f.tracker.repositoryHints.set("issue", hints({ issueLabels: ["acme/private", "acme/one"] }));
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    expect(findOpenQuestion(f.db, "session")!.options).toEqual([
      "https://github.com/acme/private",
      "https://github.com/acme/one",
    ]);
  } finally {
    f.db.close();
  }
});

test("a repo hint naming an inaccessible repository falls back to suggestions", async () => {
  const f = fixture({ confidence: 0.95 });
  try {
    f.tracker.repositoryHints.set("issue", hints({ issueLabels: ["acme/private"] }));
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const itemId = (f.db.query("SELECT id FROM work_item").get() as { id: string }).id;
    expect(getWorkItemRepository(f.db, itemId)).toEqual(repositories[1]!);
  } finally {
    f.db.close();
  }
});

test("Linear's suggestions break a tie between two repo labels", async () => {
  const f = fixture();
  try {
    f.denied.delete("private");
    f.tracker.repositoryHints.set("issue", hints({ issueLabels: ["acme/private", "acme/one"] }));
    f.tracker.repositorySuggestions.set("issue", [
      { hostname: "github.com", repositoryFullName: "acme/one", confidence: 0.9 },
      { hostname: "github.com", repositoryFullName: "acme/two", confidence: 0.95 },
    ]);
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    expect(
      f.db.query("SELECT 1 FROM question WHERE body LIKE 'Which repository%'").get(),
    ).toBeNull();
    const itemId = (f.db.query("SELECT id FROM work_item").get() as { id: string }).id;
    expect(getWorkItemRepository(f.db, itemId)).toEqual(repositories[0]!);
    expect(
      f.tracker.repositorySuggestionRequests[0]!.candidateRepositories.map(
        (candidate) => candidate.repositoryFullName,
      ),
    ).toEqual(["acme/private", "acme/one"]);
  } finally {
    f.db.close();
  }
});

test("an answered repository question labels the issue with that repository", async () => {
  const f = fixture();
  try {
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const question = findOpenQuestion(f.db, "session")!;
    await orchestrator.onLinearEvent(event("acme/two"));
    await f.jobs.tick();
    expect(getWorkItemRepository(f.db, question.itemId)).toEqual(repositories[1]!);
    const rows = f.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM outbox WHERE op='linear.repository_label'",
      )
      .all();
    expect(rows.map((row) => JSON.parse(row.payload))).toEqual([
      { issueId: "issue", repository: "acme/two" },
    ]);
  } finally {
    f.db.close();
  }
});

test("a repository bound from a hint or a suggestion writes no label", async () => {
  const f = fixture({ confidence: 0.95 });
  try {
    const orchestrator = f.attach();
    await orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    expect(f.db.query("SELECT 1 FROM outbox WHERE op='linear.repository_label'").get()).toBeNull();
  } finally {
    f.db.close();
  }
});
