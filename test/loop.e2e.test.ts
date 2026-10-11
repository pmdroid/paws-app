import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { GROK_AGENT_ARGS, worktreePath } from "../src/acp";
import type { FakeResult, FakeScript } from "../src/acp/testing/script";
import { createCommentMode, createFakeCommentBoard, withCommentActivities } from "../src/comments";
import { JOB_KIND, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getWorkItem,
  enqueueJob,
  listJobs,
  listCloseoutRecoveries,
  listRuns,
  migrate,
  openDatabase,
} from "../src/db";
import {
  INSTALLATION_PERMISSIONS,
  createFakeGitHub,
  fakeMergeReadiness,
  type GitHubClient,
  type GitHubResponse,
  type GitHubTokenProvider,
} from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { findOpenQuestion, getQuestion } from "../src/questions";
import {
  attachOrchestrator,
  itemPathId,
  createAcpCodexReviewer,
  KEEPALIVE_MS,
  type AgentLaunch,
} from "../src/loop";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey as string;

test("a two-item epic asks once, fixes one rejection, and merges in blocks order", async () => {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "ENG-1",
      title: "Add CSV export",
      description: null,
      subIssues: [
        { linearIssueId: "iss-2", identifier: "ENG-2", title: "Export rows" },
        { linearIssueId: "iss-3", identifier: "ENG-3", title: "Export the header" },
      ],
    },
  ]);
  tracker.deps.set("iss-2", [{ blockerLinearIssueId: "iss-2", blockedLinearIssueId: "iss-3" }]);
  const github = createFakeGitHub();
  const client = githubClient(layout.bare, github);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const results = new Map<string, string>();
  let scripts = 0;
  const launch: AgentLaunch = (input) => {
    scripts += 1;
    const scriptPath = path.join(layout.root, `script-${scripts}.json`);
    const resultPath = path.join(layout.root, `result-${scripts}.json`);
    results.set(`${input.purpose}:${sourceIdentifier(input.itemId)}`, resultPath);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        ...scriptFor(input),
        model:
          input.profile?.agent === "codex" || input.role === "reviewer"
            ? "test-codex-model"
            : "test-claude-model",
      }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, resultPath, scriptPath],
      env: process.env,
    };
  };
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client,
    },
    launch,
  });

  const interval = globalThis.setInterval;
  const keepAliveTicks: Array<() => void> = [];
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === KEEPALIVE_MS) keepAliveTicks.push(() => handler(...args));
    return interval(handler, delay, ...args);
  }) as typeof setInterval);
  let delivered = false;
  let whileAsking = "";
  let stop = false;
  const answerer = (async () => {
    for (;;) {
      if (stop) return;
      const question = tracker.questions.at(-1);
      if (question && !delivered) {
        delivered = true;
        const publicUpdates = tracker.progress.length;
        expect(keepAliveTicks.length).toBeGreaterThan(0);
        for (const tick of keepAliveTicks) tick();
        await outbox.idle();
        expect(tracker.progress).toHaveLength(publicUpdates);
        whileAsking = `${stateOf(db, "ENG-2") ?? "missing"}/${stateOf(db, "ENG-3") ?? "missing"}`;
        expect(tracker.progress.some((update) => update.kind === "response")).toBe(false);
        await orchestrator.onLinearEvent(linearEvent("prompted", "yes", null));
      }
      await Bun.sleep(20);
    }
  })();

  try {
    await orchestrator.onLinearEvent(linearEvent("created", null, null, "parent"));
    const deadline = Date.now() + 80_000;
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

    expect(whileAsking, debug(layout, db)).toBe("awaiting_input/queued");
    expect(tracker.progress.filter((update) => update.kind === "response")).toEqual([
      expect.objectContaining({
        body: expect.stringContaining("Epic complete. Merged ENG-2, ENG-3."),
      }),
    ]);
    expect(tracker.progress.at(-1)?.body).toContain("ENG-2: Wrote the export.");
    expect(tracker.progress.at(-1)?.body).toContain("ENG-3: Header is in.");
    expect(
      tracker.progress.some((update) => update.body.includes("Need a product decision.")),
    ).toBe(false);
    expect(tracker.progress.some((update) => update.body.includes("Adding the header."))).toBe(
      false,
    );
    const question = tracker.questions[0];
    expect(question?.options).toEqual(["yes", "no"]);
    expect(question?.body).toContain("Include archived rows?");
    expect(question?.body).toContain("answer in your own words");
    const asked = JSON.parse(await readFile(results.get("implement:ENG-2") ?? "", "utf8")) as {
      askTeam?: { text?: string };
    };
    expect(asked.askTeam?.text).toBe("yes");
    const kinds = new Set(tracker.progress.map((update) => update.kind));
    expect(kinds.has("thought")).toBe(true);
    expect(kinds.has("action")).toBe(true);
    expect(kinds.has("response")).toBe(true);
    expect(epicState(db), debug(layout, db)).toBe("done");
    expect(stateOf(db, "ENG-2"), debug(layout, db)).toBe("merged");
    expect(stateOf(db, "ENG-3"), debug(layout, db)).toBe("merged");
    expect(github.opened.map((pull) => pull.head)).toEqual([
      `paws/${taskPath(db, "ENG-2")}`,
      `paws/${taskPath(db, "ENG-3")}`,
    ]);
    expect(github.opened.map((pull) => pull.body.split("\n")[0])).toEqual([
      "Fixes ENG-2",
      "Fixes ENG-3",
    ]);
    expect(github.opened[0]?.body).toContain("Closeout:");
    expect(github.opened[1]?.body).toContain("Fix attempts: 1");
    expect(github.merged).toHaveLength(2);
    const completedUpdates = tracker.progress.length;
    for (const tick of keepAliveTicks) tick();
    await outbox.idle();
    expect(tracker.progress).toHaveLength(completedUpdates);
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(true);
  } finally {
    intervalSpy.mockRestore();
    stop = true;
    await answerer;
    db.close();
    await layout.cleanup();
  }
}, 90_000);

test("the demo epic merges three pull requests in comment mode with gh auth", async () => {
  const seed = JSON.parse(
    await readFile(new URL("../examples/paws-demo/epic/epic.json", import.meta.url), "utf8"),
  ) as DemoSeed;
  const layout = await repoLayout();
  const parentId = "lin-parent";
  const children = seed.children.map((child, index) => ({
    ...child,
    linearIssueId: `lin-${child.slug}`,
    identifier: `ENG-${index + 2}`,
  }));
  const bySlug = new Map(children.map((child) => [child.slug, child]));
  const tracker = createFakeTracker([
    {
      linearIssueId: parentId,
      identifier: "ENG-1",
      title: seed.parent.title,
      description: seed.parent.description,
      subIssues: children.map((child) => ({
        linearIssueId: child.linearIssueId,
        identifier: child.identifier,
        title: child.title,
      })),
    },
  ]);
  const edges = children.flatMap((child) =>
    child.blockedBy.map((slug) => ({
      blockerLinearIssueId: bySlug.get(slug)?.linearIssueId ?? slug,
      blockedLinearIssueId: child.linearIssueId,
    })),
  );
  for (const id of [parentId, ...children.map((child) => child.linearIssueId)]) {
    tracker.deps.set(id, edges);
  }
  const board = createFakeCommentBoard({ selfUserId: "paws" });
  const mode = createCommentMode({ board, selfUserId: "paws" });
  const comments = withCommentActivities(tracker, {
    async postProgress(update) {
      mode.bind({
        itemId: update.sessionId,
        linearIssueId: update.sessionId,
        sessionId: update.sessionId,
      });
      await mode.postProgress(update);
      await tracker.postProgress(update);
    },
    async askQuestion(question) {
      mode.bind({
        itemId: question.sessionId,
        linearIssueId: question.sessionId,
        sessionId: question.sessionId,
      });
      await mode.askQuestion(question);
    },
  });
  const github = createFakeGitHub();
  const apiPaths: string[] = [];
  const client = githubClient(layout.bare, github, apiPaths);
  const tokenProvider: GitHubTokenProvider = {
    mode: "gh",
    async tokenFor() {
      return "ghp_comment_mode";
    },
  };
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  let scripts = 0;
  const launch: AgentLaunch = (input) => {
    scripts += 1;
    const scriptPath = path.join(layout.root, `demo-script-${scripts}.json`);
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
    tracker: comments,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    github: {
      appId: "",
      installationId: "",
      privateKeyPem: "",
      client,
      tokenProvider,
    },
    launch,
    channel: "comments",
  });

  const askIssue = bySlug.get("archived-rows");
  if (askIssue === undefined) throw new Error("demo seed is missing archived-rows");
  let delivered = false;
  let whileAsking = "";
  let stop = false;
  const answerer = (async () => {
    for (;;) {
      if (stop) return;
      const question = board.comments.find(
        (comment) => comment.parentId === null && comment.body.includes("Include archived rows?"),
      );
      if (question && !delivered) {
        delivered = true;
        whileAsking = children.map((child) => stateOf(db, child.identifier) ?? "missing").join("/");
        board.post({
          issueId: question.issueId,
          parentId: question.id,
          body: "yes",
          userId: "human",
        });
        const synced = await mode.sync(question.issueId);
        for (const answer of synced.resumed) {
          await orchestrator.onLinearEvent({
            dedupeKey: `comment-answer:${answer.questionId}`,
            deliveryId: null,
            source: "poll",
            action: "prompted",
            sessionId: question.issueId,
            issueId: question.issueId,
            activityId: null,
            body: answer.answer,
            signal: null,
            updatedAtMs: Date.now(),
            payload: "{}",
          });
        }
      }
      await Bun.sleep(20);
    }
  })();

  const created = linearEvent("created", null, null, parentId);
  created.source = "poll";
  created.sessionId = parentId;
  try {
    await orchestrator.onLinearEvent(created);
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

    expect(created.source).toBe("poll");
    expect(whileAsking, debug(layout, db)).toBe("merged/merged/awaiting_input");
    expect(askIssue.title).toContain("Include archived rows?");
    const question = board.comments.find((comment) =>
      comment.body.includes("Include archived rows?"),
    );
    expect(question?.body).toContain("yes");
    expect(question?.body).toContain("no");
    expect(
      board.comments.some(
        (comment) =>
          comment.parentId === question?.id && comment.userId === "human" && comment.body === "yes",
      ),
    ).toBe(true);
    expect(epicState(db), debug(layout, db)).toBe("done");
    expect(
      children.map((child) => stateOf(db, child.identifier)),
      debug(layout, db),
    ).toEqual(["merged", "merged", "merged"]);
    expect(github.opened.map((pull) => pull.head)).toEqual([
      "paws/ENG-2",
      "paws/ENG-3",
      "paws/ENG-4",
    ]);
    expect(github.opened.map((pull) => pull.body.split("\n")[0])).toEqual([
      "Fixes ENG-2",
      "Fixes ENG-3",
      "Fixes ENG-4",
    ]);
    expect(github.opened[0]?.body).toContain("Fix attempts: 1");
    expect(github.merged).toHaveLength(3);
    expect(apiPaths.some((apiPath) => apiPath.endsWith("/access_tokens"))).toBe(false);
    expect(apiPaths.some((apiPath) => apiPath.includes("webhook"))).toBe(false);
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(true);
  } finally {
    stop = true;
    await answerer;
    db.close();
    await layout.cleanup();
  }
}, 120_000);

test.each(["claude", "codex", "grok"])(
  "stop from Linear cancels the live %s run",
  async (implementer) => {
    const layout = await repoLayout();
    await writeFile(
      path.join(layout.pawsRoot, "config.toml"),
      `[agents]\nimplementer = "${implementer}"\n`,
    );
    const tracker = createFakeTracker([
      {
        linearIssueId: "iss-9",
        identifier: "ENG-9",
        title: "Hang",
        description: null,
        subIssues: [],
      },
    ]);
    const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    const launch: AgentLaunch = () => {
      const scriptPath = path.join(layout.root, "hang.json");
      writeFileSync(scriptPath, JSON.stringify({ steps: [{ type: "hang" }] }));
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
      tracker,
      repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
      launch,
    });
    const running = (async () => {
      await orchestrator.onLinearEvent(linearEvent("created", null, null, "iss-9"));
      await jobs.tick();
    })();
    const deadline = Date.now() + 15_000;
    while (
      Date.now() < deadline &&
      !tracker.progress.some((update) => update.body.includes("Working on ENG-9"))
    ) {
      await Bun.sleep(20);
    }
    expect(tracker.progress.some((update) => update.body.includes("Working on ENG-9"))).toBe(true);
    await orchestrator.onLinearEvent(linearEvent("prompted", null, "stop"));
    await running;
    expect(stateOf(db, "ENG-9")).toBe("cancelled");
    expect(tracker.statuses.some((update) => update.stateType === "canceled")).toBe(false);
    expect(tracker.progress.at(-1)).toMatchObject({
      kind: "response",
      body: "Stopped from Linear.",
    });
    expect(listJobs(db).some((job) => job.queue === JOB_KIND.merge)).toBe(false);
    const agents = listRuns(db).map((run) => run.agent);
    db.close();
    await layout.cleanup();
    expect(agents).toEqual([implementer]);
  },
  20_000,
);

test("an unconfigured repository halts with an error and never completes the session", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "failure",
      identifier: "ENG-99",
      title: "Failure",
      description: null,
      subIssues: [],
    },
  ]);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({ db, tracker, jobs, outbox, pawsRoot: "/unused" });
  try {
    await orchestrator.onLinearEvent(linearEvent("created", null, null, "failure"));
    await jobs.tick();
    while (outbox.tick().length > 0) await outbox.idle();
    expect(stateOf(db, "ENG-99")).toBe("failed");
    expect(
      tracker.progress.some(
        (update) => update.kind === "error" && update.body.includes("PAWS_GITHUB_REPOSITORY"),
      ),
    ).toBe(true);
    expect(tracker.progress.some((update) => update.kind === "response")).toBe(false);
    expect(tracker.progress.at(-1)?.kind).toBe("error");
  } finally {
    db.close();
  }
});

test("a missing reviewer blocks the item and needs a person", async () => {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "iss-7",
      identifier: "ENG-7",
      title: "Needs a reviewer",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const launch: AgentLaunch = (input) => {
    if (input.purpose === "review") return { command: "/bin/false", args: [] };
    const scriptPath = path.join(layout.root, "reviewer-missing.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        steps: [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }],
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
    tracker,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    launch,
  });
  try {
    await orchestrator.onLinearEvent(linearEvent("created", null, null, "iss-7"));
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline && stateOf(db, "ENG-7") !== "awaiting_input") {
      const job = await jobs.tick();
      if (job === null) await Bun.sleep(20);
    }
    expect(stateOf(db, "ENG-7"), debug(layout, db)).toBe("awaiting_input");
    expect(tracker.progress.some((update) => update.kind === "error")).toBe(false);
    expect(tracker.questions).toHaveLength(1);
    expect(listJobs(db).some((job) => job.queue === JOB_KIND.merge)).toBe(false);
    const questionBody = tracker.questions[0]?.body;
    expect(questionBody).toContain("Closeout: blocked");
    expect(questionBody).toContain("reviewer failed");
  } finally {
    db.close();
    await layout.cleanup();
  }
}, 60_000);

for (const recovery of ["guidance", "bypass", "stale bypass"] as const) {
  test(`Closeout ${recovery} survives restart and resumes the correct work`, async () => {
    const layout = await repoLayout();
    const seed = path.join(layout.root, "seed");
    await writeFile(
      path.join(seed, ".agents", "closeout.yaml"),
      JSON.stringify({
        specVersion: "0.1",
        retry: { maxFailedAttemptsPerItem: 2, scope: "task" },
        items: [
          {
            id: "test",
            kind: "command",
            gate: "beforePR",
            exec: ["sh", "-c", "test -f ok.txt"],
            timeoutSeconds: 30,
          },
        ],
      }),
    );
    await exec("git", ["-C", seed, "add", "."]);
    await exec("git", ["-C", seed, "commit", "-m", "bounded recovery policy"]);
    await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
    const tracker = createFakeTracker([
      {
        linearIssueId: "iss-8",
        identifier: "ENG-8",
        title: "Recover Closeout",
        description: null,
        subIssues: [],
      },
    ]);
    const github = createFakeGitHub();
    const client = githubClient(layout.bare, github);
    const dbPath = path.join(layout.pawsRoot, "paws.db");
    let db = openDatabase(dbPath);
    migrate(db);
    const launches: string[] = [];
    const prompts: string[] = [];
    const launch: AgentLaunch = (input) => {
      launches.push(input.purpose);
      prompts.push(input.prompt);
      const scriptPath = path.join(layout.root, `recovery-${launches.length}.json`);
      const guided =
        recovery === "guidance" &&
        launches.filter((purpose) => purpose === "implement").length === 2;
      writeFileSync(
        scriptPath,
        JSON.stringify({
          steps: [
            {
              type: "fs_write",
              path: path.join(input.worktree, guided ? "ok.txt" : `attempt-${launches.length}.txt`),
              content: "done\n",
            },
            { type: "end", stopReason: "end_turn" },
          ],
        }),
      );
      return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
    };
    const attach = () => {
      const jobs = new JobLoop(db, systemClock);
      const outbox = new OutboxDispatcher(db, systemClock);
      const orchestrator = attachOrchestrator({
        db,
        jobs,
        outbox,
        pawsRoot: layout.pawsRoot,
        home: layout.home,
        tracker,
        launch,
        repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
        github: { appId: "1", installationId: "2", privateKeyPem: PRIVATE_KEY, client },
      });
      return { jobs, orchestrator };
    };
    try {
      let runtime = attach();
      await runtime.orchestrator.onLinearEvent(linearEvent("created", null, null, "iss-8"));
      await runtime.jobs.tick();
      expect(stateOf(db, "ENG-8"), debug(layout, db)).toBe("awaiting_input");
      expect(launches).toEqual(["implement", "fix"]);
      expect(github.merged).toHaveLength(0);
      const question = findOpenQuestion(db, "ses_1")!;
      const context = listCloseoutRecoveries(db, question.itemId)[0]!;
      expect(context.failedChecks).toEqual(["test"]);
      expect(context.retryBaseline).toHaveLength(2);
      expect(question.body).toContain("same Closeout retry limit");
      db.close();
      db = openDatabase(dbPath);
      runtime = attach();
      expect(findOpenQuestion(db, "ses_1")?.id).toBe(question.id);
      if (recovery === "stale bypass") {
        const worktree = worktreePath(layout.pawsRoot, taskPath(db, "ENG-8"));
        await gitIdentity(worktree);
        await exec("git", ["-C", worktree, "commit", "--allow-empty", "-m", "candidate changed"]);
      }
      const answer =
        recovery === "guidance"
          ? "Create ok.txt to satisfy the command"
          : "/paws bypass test -- Approved known fixture failure";
      const event = {
        ...linearEvent("prompted", answer, null),
        payload: JSON.stringify({ questionId: question.id, answeredBy: "pascal" }),
      };
      await runtime.orchestrator.onLinearEvent(event);
      await runtime.orchestrator.onLinearEvent(event);
      expect(getQuestion(db, question.id)?.answeredBy).toBe("pascal");
      expect(
        listJobs(db).filter(
          (job) => job.queue === (recovery === "guidance" ? JOB_KIND.resume : JOB_KIND.reverify),
        ),
      ).toHaveLength(1);
      for (let tick = 0; tick < 5; tick += 1) {
        if ((await runtime.jobs.tick()) === null) break;
      }
      if (recovery === "stale bypass") {
        expect(stateOf(db, "ENG-8"), debug(layout, db)).toBe("awaiting_input");
        expect(github.merged).toHaveLength(0);
        expect(findOpenQuestion(db, "ses_1")?.id).not.toBe(question.id);
      } else {
        expect(stateOf(db, "ENG-8"), debug(layout, db)).toBe("merged");
        expect(github.merged).toHaveLength(1);
        expect(launches).toEqual(
          recovery === "guidance" ? ["implement", "fix", "implement"] : ["implement", "fix"],
        );
        expect(listCloseoutRecoveries(db, question.itemId)[0]?.retryBaseline).toEqual(
          context.retryBaseline,
        );
        if (recovery === "guidance") expect(prompts.at(-1)).toContain(answer);
        if (recovery === "bypass") {
          expect(github.opened[0]?.body).toContain("approved by pascal");
          expect(github.opened[0]?.body).toContain("Approved known fixture failure");
        }
      }
    } finally {
      db.close();
      await layout.cleanup();
    }
  }, 60_000);
}

test("grok implementer runs the demo epic with ask_team and one Closeout fix", async () => {
  const layout = await repoLayout();
  const argvLog = path.join(layout.root, "grok-argv.log");
  const wrapper = path.join(layout.root, "grok-wrapper");
  await writeFile(
    path.join(layout.pawsRoot, "config.toml"),
    `[agents]\nimplementer = "grok"\n\n[agents.grok]\npath = ${JSON.stringify(wrapper)}\nallow_api_key = false\n`,
  );
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "ENG-1",
      title: "Add CSV export",
      description: null,
      subIssues: [
        { linearIssueId: "iss-2", identifier: "ENG-2", title: "Export rows" },
        { linearIssueId: "iss-3", identifier: "ENG-3", title: "Export the header" },
      ],
    },
  ]);
  tracker.deps.set("iss-2", [{ blockerLinearIssueId: "iss-2", blockedLinearIssueId: "iss-3" }]);
  const github = createFakeGitHub();
  const client = githubClient(layout.bare, github);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const results = new Map<string, string>();
  let scripts = 0;
  const launch: AgentLaunch = (input) => {
    scripts += 1;
    const scriptPath = path.join(layout.root, `grok-script-${scripts}.json`);
    const resultPath = path.join(layout.root, `grok-result-${scripts}.json`);
    results.set(`${input.purpose}:${sourceIdentifier(input.itemId)}`, resultPath);
    const script = scriptFor(input);
    if (input.role === "implementer") {
      script.authMethods = [{ id: "cached_token", name: "Cached login" }];
    }
    writeFileSync(
      scriptPath,
      JSON.stringify({
        ...script,
        model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
      }),
    );
    writeFileSync(
      wrapper,
      `#!/bin/sh\n` +
        `printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n` +
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAgent)} ${JSON.stringify(resultPath)} ${JSON.stringify(scriptPath)} "$@"\n`,
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      XAI_API_KEY: "xai-should-not-leak",
      GH_TOKEN: "gh-should-not-leak",
      SSH_AUTH_SOCK: "/tmp/ssh-should-not-leak",
      AWS_SECRET_ACCESS_KEY: "aws-should-not-leak",
    };
    if (input.role === "reviewer") {
      return { command: process.execPath, args: [fakeAgent, resultPath, scriptPath], env };
    }
    return { env };
  };
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
    github: {
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client,
    },
    launch,
  });

  let delivered = false;
  let whileAsking = "";
  let stop = false;
  const answerer = (async () => {
    for (;;) {
      if (stop) return;
      const question = tracker.questions.at(-1);
      if (question && !delivered) {
        delivered = true;
        whileAsking = `${stateOf(db, "ENG-2") ?? "missing"}/${stateOf(db, "ENG-3") ?? "missing"}`;
        expect(tracker.progress.some((update) => update.kind === "response")).toBe(false);
        await orchestrator.onLinearEvent(linearEvent("prompted", "yes", null));
      }
      await Bun.sleep(20);
    }
  })();

  try {
    await orchestrator.onLinearEvent(linearEvent("created", null, null, "parent"));
    const deadline = Date.now() + 80_000;
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

    expect(whileAsking, debug(layout, db)).toBe("awaiting_input/queued");
    expect(tracker.progress.filter((update) => update.kind === "response")).toEqual([
      expect.objectContaining({
        body: expect.stringContaining("Epic complete. Merged ENG-2, ENG-3."),
      }),
    ]);
    expect(tracker.progress.at(-1)?.body).toContain("ENG-2: Wrote the export.");
    expect(tracker.progress.at(-1)?.body).toContain("ENG-3: Header is in.");
    expect(
      tracker.progress.some((update) => update.body.includes("Need a product decision.")),
    ).toBe(false);
    expect(tracker.progress.some((update) => update.body.includes("Adding the header."))).toBe(
      false,
    );
    expect(tracker.questions[0]?.options).toEqual(["yes", "no"]);
    const asked = JSON.parse(
      await readFile(results.get("implement:ENG-2") ?? "", "utf8"),
    ) as FakeResult;
    expect(asked.askTeam?.text).toBe("yes");
    expect(asked.authenticate).toEqual({ methodId: "cached_token" });
    expect(asked.cwd).toBe(worktreePath(layout.pawsRoot, taskPath(db, "ENG-2")));
    expect(asked.env).toMatchObject({
      xaiApiKey: false,
      ghToken: false,
      sshAuthSock: false,
      aws: false,
    });
    expect(JSON.stringify(asked)).not.toContain("xai-should-not-leak");
    const fixed = JSON.parse(await readFile(results.get("fix:ENG-3") ?? "", "utf8")) as FakeResult;
    expect(fixed.authenticate).toEqual({ methodId: "cached_token" });
    const reviewed = JSON.parse(
      await readFile(results.get("review:ENG-3") ?? "", "utf8"),
    ) as FakeResult;
    expect(reviewed.methods).not.toContain("authenticate");
    const spawned = (await readFile(argvLog, "utf8")).trim().split("\n");
    expect(spawned.length).toBeGreaterThan(0);
    for (const line of spawned) {
      expect(line).toBe(GROK_AGENT_ARGS.join(" "));
      expect(line).not.toContain("always-approve");
      expect(line).not.toContain("yolo");
    }
    expect(epicState(db), debug(layout, db)).toBe("done");
    expect(stateOf(db, "ENG-2"), debug(layout, db)).toBe("merged");
    expect(stateOf(db, "ENG-3"), debug(layout, db)).toBe("merged");
    expect(github.opened[1]?.body).toContain("Fix attempts: 1");
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(true);
  } finally {
    stop = true;
    await answerer;
    db.close();
    await layout.cleanup();
  }
}, 90_000);

const invalidReviews: Array<{
  name: string;
  text: string;
  stopReason?: "refusal" | "cancelled" | "max_tokens" | "max_turn_requests";
}> = [
  { name: "failure prose", text: "I could not review this change." },
  { name: "empty reply", text: "" },
  { name: "malformed JSON", text: "[{]" },
  { name: "wrong JSON type", text: "{}" },
  { name: "invalid finding", text: '[{"severity":"P1"}]' },
  {
    name: "mixed findings",
    text: JSON.stringify([
      { severity: "P2", location: "file.ts", explanation: "Observed", evidence: "Diff" },
      {},
    ]),
  },
  {
    name: "empty finding field",
    text: JSON.stringify([
      { severity: "P1", location: "", explanation: "Observed", evidence: "Diff" },
    ]),
  },
  {
    name: "extra finding field",
    text: JSON.stringify([
      {
        severity: "P1",
        location: "file.ts",
        explanation: "Observed",
        evidence: "Diff",
        extra: true,
      },
    ]),
  },
  { name: "refusal", text: "[]", stopReason: "refusal" },
  { name: "cancellation", text: "[]", stopReason: "cancelled" },
  { name: "token limit", text: "[]", stopReason: "max_tokens" },
  { name: "turn limit", text: "[]", stopReason: "max_turn_requests" },
];

for (const review of invalidReviews) {
  test(`ACP review ${review.name} blocks publication and merge`, async () => {
    const layout = await repoLayout();
    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "ENG-1",
        title: "Add export",
        description: null,
        subIssues: [{ linearIssueId: "iss-2", identifier: "ENG-2", title: "Export rows" }],
      },
    ]);
    const github = createFakeGitHub();
    const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    let reviews = 0;
    let launches = 0;
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      tracker,
      repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
      github: {
        appId: "1",
        installationId: "2",
        privateKeyPem: PRIVATE_KEY,
        client: githubClient(layout.bare, github),
      },
      launch(input) {
        launches += 1;
        const scriptPath = path.join(layout.root, `review-script-${launches}.json`);
        const script: FakeScript =
          input.purpose === "review"
            ? {
                steps: [
                  {
                    type: "update",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: review.text },
                    },
                  },
                  { type: "end", stopReason: review.stopReason ?? "end_turn" },
                ],
              }
            : { steps: [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }] };
        if (input.purpose === "review") reviews += 1;
        writeFileSync(
          scriptPath,
          JSON.stringify({
            ...script,
            model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          }),
        );
        return {
          command: process.execPath,
          args: [fakeAgent, "", scriptPath],
          env: process.env,
        };
      },
    });
    try {
      await orchestrator.onLinearEvent(linearEvent("created", null, null, "parent"));
      for (let ticks = 0; ticks < 20; ticks += 1) {
        if ((await jobs.tick()) === null) break;
      }
      expect(reviews, debug(layout, db)).toBeGreaterThan(0);
      expect(github.opened, debug(layout, db)).toHaveLength(0);
      expect(github.merged, debug(layout, db)).toHaveLength(0);
      expect(stateOf(db, "ENG-2"), debug(layout, db)).not.toBe("merged");
    } finally {
      db.close();
      await layout.cleanup();
    }
  }, 30_000);
}

test("ACP review timeout rejects a partial clean array", async () => {
  const layout = await repoLayout();
  const scriptPath = path.join(layout.root, "timeout-review.json");
  const script: FakeScript = {
    steps: [
      {
        type: "update",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[]" } },
      },
      { type: "hang" },
    ],
  };
  writeFileSync(scriptPath, JSON.stringify(script));
  const reviewer = createAcpCodexReviewer({
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    timeoutMs: 500,
    launch: () => ({
      command: process.execPath,
      args: [fakeAgent, "", scriptPath],
      env: process.env,
    }),
  });
  try {
    const head = (await exec("git", ["--git-dir", layout.bare, "rev-parse", "main"])).stdout.trim();
    await expect(
      reviewer.review({
        worktree: path.join(layout.root, "seed"),
        taskId: "timeout-review",
        itemId: "adversarial-review",
        base: head,
        head,
        candidate: { session: "implementer", model: "claude", provider: "anthropic" },
      }),
    ).rejects.toThrow("timeout");
  } finally {
    await layout.cleanup();
  }
}, 15_000);

type DemoSeed = {
  parent: { title: string; description: string };
  children: Array<{ slug: string; title: string; blockedBy: string[] }>;
};

for (const sameModel of [true, false]) {
  test(`configured Codex role models ${sameModel ? "block identical models before implementation" : "use project overrides and retain their candidate snapshot"}`, async () => {
    const layout = await repoLayout();
    const configPath = path.join(layout.pawsRoot, "config.toml");
    writeFileSync(
      configPath,
      `[agents.defaults.implementer]\nagent = "claude"\nmodel = "unused-default"\n[agents.defaults.reviewer]\nagent = "codex"\nmodel = "unused-default"\n[agents.projects."pmdroid/paws-demo".implementer]\nagent = "codex"\nmodel = "model-a"\n[agents.projects."pmdroid/paws-demo".reviewer]\nagent = "codex"\nmodel = "${sameModel ? "model-a" : "model-b"}"\n`,
    );
    if (sameModel) writeFileSync(configPath, `[agents]\nimplementer = "codex"\n`);
    const tracker = createFakeTracker([
      {
        linearIssueId: "profile-item",
        identifier: "ENG-20",
        title: "Profile routing",
        description: null,
        subIssues: [],
      },
    ]);
    const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    const github = createFakeGitHub();
    const launches: Array<{ purpose: string; profile: unknown }> = [];
    let sequence = 0;
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      tracker,
      repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
      github: {
        appId: "1",
        installationId: "2",
        privateKeyPem: PRIVATE_KEY,
        client: githubClient(layout.bare, github),
      },
      launch(input) {
        launches.push({ purpose: input.purpose, profile: input.profile });
        const scriptPath = path.join(layout.root, `profile-${++sequence}.json`);
        const script: FakeScript = {
          model: "model-a",
          models: ["model-a", "model-b"],
          steps:
            input.purpose === "review"
              ? emptyReview().steps
              : [writeOk(input.worktree), { type: "end" }],
        };
        writeFileSync(scriptPath, JSON.stringify(script));
        if (input.purpose === "implement")
          writeFileSync(configPath, `[agents]\nimplementer = "grok"\n`);
        return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
      },
    });
    try {
      await orchestrator.onLinearEvent(linearEvent("created", null, null, "profile-item"));
      for (let tick = 0; tick < 20; tick += 1) if ((await jobs.tick()) === null) break;
      if (sameModel) {
        expect(stateOf(db, "ENG-20"), debug(layout, db)).toBe("awaiting_input");
        expect(launches.every((launch) => launch.purpose === "prepare")).toBe(true);
        expect(tracker.progress.some((update) => update.kind === "error")).toBe(false);
        expect(tracker.questions[0]?.body).toContain("different reviewer model");
        expect(github.opened).toHaveLength(0);
      } else {
        expect(stateOf(db, "ENG-20"), debug(layout, db)).toBe("merged");
        expect(launches.find((launch) => launch.purpose === "implement")?.profile).toEqual({
          agent: "codex",
          model: "model-a",
        });
        expect(
          launches
            .filter((launch) => launch.purpose === "review")
            .every(
              (launch) =>
                JSON.stringify(launch.profile) ===
                JSON.stringify({ agent: "codex", model: "model-b" }),
            ),
        ).toBe(true);
      }
    } finally {
      db.close();
      await layout.cleanup();
    }
  }, 30_000);
}

for (const savedState of ["verifying", "merge_queue"] as const) {
  test(`upgraded ${savedState} candidate without model evidence asks for fresh implementation`, async () => {
    const layout = await repoLayout();
    const tracker = createFakeTracker([
      {
        linearIssueId: "legacy-item",
        identifier: "ENG-30",
        title: "Upgrade candidate",
        description: null,
        subIssues: [],
      },
    ]);
    const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    const github = createFakeGitHub();
    const launched: string[] = [];
    const implementerProfiles: unknown[] = [];
    let sequence = 0;
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      tracker,
      repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
      github: {
        appId: "1",
        installationId: "2",
        privateKeyPem: PRIVATE_KEY,
        client: githubClient(layout.bare, github),
      },
      launch(input) {
        launched.push(input.purpose);
        if (input.purpose === "implement") implementerProfiles.push(input.profile);
        const scriptPath = path.join(layout.root, `legacy-${++sequence}.json`);
        writeFileSync(
          scriptPath,
          JSON.stringify({
            model:
              input.profile?.model ??
              (input.role === "reviewer" ? "test-codex-model" : "test-claude-model"),
            steps:
              input.purpose === "review"
                ? emptyReview().steps
                : [writeOk(input.worktree), { type: "end" }],
          }),
        );
        return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
      },
    });
    try {
      await orchestrator.onLinearEvent(linearEvent("created", null, null, "legacy-item"));
      await jobs.tick();
      const item = db
        .query<{ id: string; current_run_id: string }, []>(
          "SELECT id, current_run_id FROM work_item",
        )
        .get()!;
      const initialRun = item.current_run_id;
      await rm(path.join(layout.pawsRoot, "runs", initialRun, "agent-profile.json"));
      db.run("DELETE FROM job WHERE queue = ?", [JOB_KIND.merge]);
      db.run("UPDATE work_item SET state = ? WHERE id = ?", [savedState, item.id]);
      const beforeHandoff = launched.length;
      enqueueJob(db, {
        queue: savedState === "verifying" ? JOB_KIND.reverify : JOB_KIND.merge,
        payload: { itemId: item.id },
        now: systemClock.now(),
      });
      await jobs.tick();
      expect(stateOf(db, "ENG-30"), debug(layout, db)).toBe("awaiting_input");
      expect(launched).toHaveLength(beforeHandoff);
      expect(tracker.progress.some((update) => update.kind === "error")).toBe(false);
      expect(tracker.questions).toHaveLength(1);
      expect(tracker.questions[0]?.body).toContain("no recorded ACP session model");
      expect(github.opened).toHaveLength(0);
      expect(github.merged).toHaveLength(0);
      const question = findOpenQuestion(db, "ses_1")!;
      expect(question.body).toContain("no recorded ACP session model");
      expect(question.body).not.toContain("Checks you can bypass");
      writeFileSync(
        path.join(layout.pawsRoot, "config.toml"),
        `[agents.defaults.implementer]\nagent = "codex"\nmodel = "test-new-implementer"\n[agents.defaults.reviewer]\nagent = "codex"\nmodel = "test-codex-model"\n`,
      );
      await orchestrator.onLinearEvent({
        ...linearEvent("prompted", "Restart implementation using the configured profiles", null),
        payload: JSON.stringify({ questionId: question.id, answeredBy: "pascal" }),
      });
      for (let tick = 0; tick < 10; tick += 1) if ((await jobs.tick()) === null) break;
      expect(stateOf(db, "ENG-30"), debug(layout, db)).toBe("merged");
      expect(getWorkItem(db, item.id)?.currentRunId).not.toBe(initialRun);
      expect(launched.filter((purpose) => purpose === "implement")).toHaveLength(2);
      expect(github.merged).toHaveLength(1);
      expect(implementerProfiles.at(-1)).toEqual({ agent: "codex", model: "test-new-implementer" });
    } finally {
      db.close();
      await layout.cleanup();
    }
  }, 30_000);
}

function emptyReview(): FakeScript {
  return {
    steps: [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "[]" },
        },
      },
      { type: "end", stopReason: "end_turn" },
    ],
  };
}

function writeOk(worktree: string, content = "ok\n"): FakeScript["steps"][number] {
  return { type: "fs_write", path: path.join(worktree, "ok.txt"), content };
}

function demoScript(input: { purpose: string; itemId: string; worktree: string }): FakeScript {
  if (input.purpose === "review") return emptyReview();
  if (input.purpose === "fix") {
    return { steps: [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }] };
  }
  if (input.itemId === "ENG-4") {
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
        { type: "end", stopReason: "end_turn" },
      ],
    };
  }
  return {
    steps: [
      {
        type: "fs_write",
        path: path.join(input.worktree, `${input.itemId}.txt`),
        content: "done\n",
      },
      { type: "end", stopReason: "end_turn" },
    ],
  };
}

function scriptFor(input: { purpose: string; itemId: string; worktree: string }): FakeScript {
  if (input.purpose === "review") return emptyReview();
  if (input.purpose === "fix") {
    return {
      steps: [writeOk(input.worktree, "header\n"), { type: "end", stopReason: "end_turn" }],
    };
  }
  if (sourceIdentifier(input.itemId) === "ENG-2") {
    return {
      steps: [
        {
          type: "update",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Need a product decision." },
          },
        },
        {
          type: "update",
          update: { sessionUpdate: "tool_call", toolCallId: "write-export", title: "Write export" },
        },
        {
          type: "ask_team",
          question: "Include archived rows?",
          options: ["yes", "no"],
        },
        {
          type: "fs_write",
          path: path.join(input.worktree, "export.txt"),
          content: "archived=yes\n",
        },
        writeOk(input.worktree),
        {
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Wrote the export." },
          },
        },
        { type: "end", stopReason: "end_turn" },
      ],
    };
  }
  return {
    steps: [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Adding the header." },
        },
      },
      {
        type: "update",
        update: { sessionUpdate: "tool_call", toolCallId: "write-header", title: "Write header" },
      },
      {
        type: "fs_write",
        path: path.join(input.worktree, "header.txt"),
        content: "column\n",
      },
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Header is in." },
        },
      },
      { type: "end", stopReason: "end_turn" },
    ],
  };
}

function linearEvent(
  action: "created" | "prompted",
  body: string | null,
  signal: string | null,
  issueId: string | null = null,
): AcceptedLinearEvent {
  return {
    dedupeKey: `${action}:${issueId ?? body ?? signal ?? "x"}`,
    deliveryId: null,
    source: "webhook",
    action,
    sessionId: "ses_1",
    issueId,
    activityId: action === "prompted" ? "act-1" : null,
    body,
    signal,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}

function githubClient(
  bare: string,
  github: ReturnType<typeof createFakeGitHub>,
  seen: string[] = [],
): GitHubClient {
  let n = 0;
  return {
    async request(req): Promise<GitHubResponse> {
      seen.push(req.path);
      if (req.path === "/graphql") {
        const { head } = (req.body as { variables: { head: string } }).variables;
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      if (req.path.endsWith("/access_tokens")) {
        n += 1;
        await github.mintInstallationToken({
          installationId: "2",
          repository: "pmdroid/paws-demo",
        });
        return {
          status: 201,
          body: {
            token: `ghs_e2e_${n}`,
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            repository_selection: "selected",
            repositories: [{ name: "paws-demo", full_name: "pmdroid/paws-demo" }],
            permissions: { ...INSTALLATION_PERMISSIONS, metadata: "read" },
          },
        };
      }
      if (req.method === "POST" && req.path.endsWith("/labels")) {
        if (req.path.includes("/issues/")) return { status: 200, body: [{ name: "paws" }] };
        return { status: 201, body: { name: "paws" } };
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
        const sha = await squashBranch(bare, body.sha ?? "", body);
        return { status: 200, body: { sha, merged: true } };
      }
      return { status: 404, body: {} };
    },
  };
}

async function squashBranch(
  bare: string,
  expected: string,
  body: { sha?: string; commit_message?: string },
): Promise<string> {
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
    await exec("git", ["-C", tmp, "commit", "-m", body.commit_message ?? "squash"]);
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
  const root = await mkdtemp(path.join(tmpdir(), "paws-e2e-"));
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

const SEEDED_TEST = `import { expect, spyOn, test } from "bun:test";
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

function sourceIdentifier(taskId: string): string {
  return taskId.replace(/-[0-9A-Z]{26}$/, "");
}

function taskPath(db: Database, identifier: string): string {
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_identifier = ?")
    .get(identifier);
  if (!row) throw new Error("Fixture task missing");
  return itemPathId(getWorkItem(db, row.id)!);
}
