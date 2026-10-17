import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
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
  bindWorkItemRepository,
  accrueAwake,
  configureWorkItem,
  getWorkItemRepository,
  listWorkItems,
  OutboxDispatcher,
  getWorkItem,
  getConfirmedRemoteMerge,
  enqueueJob,
  recoverOnStartup,
  listJobs,
  listCloseoutRecoveries,
  listRuns,
  listArtifacts,
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
import {
  createFakeTracker,
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  parseAgentEvent,
  createLinearFileTransfer,
  type AcceptedLinearEvent,
} from "../src/linear";
import { findOpenQuestion, getQuestion } from "../src/questions";
import { handleStatusRequest, parseStatusSnapshot } from "../src/web";
import {
  attachOrchestrator,
  itemPathId,
  createAcpCodexReviewer,
  KEEPALIVE_MS,
  LinearTaskAccess,
  FakeHostGitHubAuth,
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

test.each([false, true, "cap"] as const)(
  "Closeout repairs publish live progress to Linear and the dashboard, stopped: %s",
  async (stop) => {
    const layout = await repoLayout();
    const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    const tracker = createFakeTracker([
      {
        linearIssueId: "repair",
        identifier: "ENG-302",
        title: "Repair missing output",
        description: null,
        subIssues: [],
      },
    ]);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    let entered = "";
    let release = "";
    const heartbeats: (() => void)[] = [];
    const interval = globalThis.setInterval;
    const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      if (delay === KEEPALIVE_MS) heartbeats.push(handler);
      return interval(handler, delay);
    }) as typeof setInterval);
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      tracker,
      caps: { maxTurns: 80, maxAwakeMs: 3 * 60 * 60 * 1000 },
      repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
      launch(input) {
        if (input.purpose === "fix") {
          entered = path.join(input.worktree, "fix-entered");
          release = path.join(input.worktree, "fix-release");
        }
        const scriptPath = path.join(layout.root, `repair-${input.purpose}.json`);
        const script: FakeScript = {
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps:
            input.purpose === "review"
              ? emptyReview().steps
              : input.purpose === "fix"
                ? [
                    {
                      type: "update",
                      update: {
                        sessionUpdate: "plan",
                        entries: [
                          {
                            content: "Repair missing output",
                            priority: "high",
                            status: "in_progress",
                          },
                        ],
                      },
                    },
                    {
                      type: "update",
                      update: {
                        sessionUpdate: "agent_thought_chunk",
                        content: { type: "text", text: "PRIVATE_FIX_REASONING" },
                      },
                    },
                    ...["Fixing the ", "missing output."].map((text) => ({
                      type: "update" as const,
                      update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text },
                      },
                    })),
                    {
                      type: "update",
                      update: {
                        sessionUpdate: "tool_call",
                        toolCallId: "repair",
                        title: "Write repaired output",
                        status: "in_progress",
                      },
                    },
                    {
                      type: "terminal",
                      command: "bun",
                      args: [
                        "-e",
                        `await Bun.write(${JSON.stringify(entered)}, "ready"); while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(10);`,
                      ],
                    },
                    writeOk(input.worktree),
                    { type: "end" },
                  ]
                : [
                    {
                      type: "fs_write",
                      path: path.join(input.worktree, "candidate.txt"),
                      content: "needs repair",
                    },
                    { type: "end" },
                  ],
        };
        writeFileSync(scriptPath, JSON.stringify(script));
        return { command: process.execPath, args: [fakeAgent, "", scriptPath], env: process.env };
      },
    });
    let running: Promise<unknown> | undefined;
    try {
      await orchestrator.onLinearEvent(linearEvent("created", null, null, "repair"));
      running = jobs.tick();
      for (let i = 0; i < 1_000 && !existsSync(entered); i++) await Bun.sleep(10);
      expect(existsSync(entered), debug(layout, db)).toBe(true);
      const progressDeadline = performance.now() + 10_000;
      while (
        performance.now() < progressDeadline &&
        (!tracker.progress.some((update) => update.body === "Fixing the missing output.") ||
          !tracker.progress.some((update) => update.body === "Write repaired output") ||
          !tracker.sessionUpdates.some(
            (update) => update.summary === "ENG-302: fixing Closeout findings",
          ) ||
          !tracker.sessionUpdates.some((update) => update.plan?.[0]?.status === "inProgress"))
      ) {
        while (outbox.tick().length > 0) await outbox.idle();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(tracker.progress.map((update) => update.body)).toContain("Fixing the missing output.");
      expect(tracker.progress.map((update) => update.body)).toContain("Write repaired output");
      expect(tracker.progress.some((update) => /fix attempt 1 of 5/i.test(update.body))).toBe(true);
      expect(tracker.sessionUpdates.findLast((update) => update.summary)?.summary).toBe(
        "ENG-302: fixing Closeout findings",
      );
      expect(tracker.sessionUpdates.findLast((update) => update.plan)?.plan?.[0]).toEqual({
        content: "Repair missing output",
        status: "inProgress",
      });
      for (const heartbeat of heartbeats) heartbeat();
      await outbox.idle();
      expect(tracker.progress.at(-1)?.body).toContain("fix attempt 1 of 5");
      const response = await handleStatusRequest(new Request("http://localhost/api/status"), {
        db,
      });
      const parsed = parseStatusSnapshot(await response!.json());
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error("Invalid status snapshot");
      const run = parsed.snapshot.runs.find((entry) => entry.itemId === "ENG-302");
      expect(run?.activity.map((entry) => entry.text)).toContain("Fixing the missing output.");
      expect(run?.summary).toContain("fix attempt 1 of 5");
      expect(JSON.stringify(tracker.progress)).not.toContain("PRIVATE_FIX_REASONING");
      expect(JSON.stringify(parsed.snapshot)).not.toContain("PRIVATE_FIX_REASONING");
      if (stop === true) await orchestrator.onLinearEvent(linearEvent("prompted", null, "stop"));
      if (stop === "cap") {
        const item = listWorkItems(db)[0]!;
        configureWorkItem(db, item.id, { maxAwakeMs: 1_000 });
        accrueAwake(db, item.id, 0);
        accrueAwake(db, item.id, 1_000);
        expect(getWorkItem(db, item.id)?.state).toBe("failed");
        await orchestrator.onLinearEvent(linearEvent("prompted", "Continue the repair", null));
        await running;
        expect(getWorkItem(db, item.id)).toMatchObject({
          state: "queued",
          cancelRequested: false,
          awakeMs: 0,
          maxAwakeMs: 3 * 60 * 60 * 1000,
        });
        running = jobs.tick();
      }
      if (release) writeFileSync(release, "go");
      await running;
      while (outbox.tick().length > 0) await outbox.idle();
      expect(stateOf(db, "ENG-302")).toBe(stop === true ? "cancelled" : "merge_queue");
      expect(tracker.progress.some((update) => update.body.includes("Rechecking ENG-302"))).toBe(
        stop !== true,
      );
    } finally {
      writeFileSync(release, "go");
      await running;
      await orchestrator.shutdown();
      intervalSpy.mockRestore();
      db.close();
      await layout.cleanup();
    }
  },
  20000,
);

test("a bound two-item delegation asks, verifies and merges in its repository after the default changes", async () => {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "ENG-1",
      title: "Add CSV export",
      description:
        "Design: ![diagram](https://uploads.linear.app/workspace/input.png?signature=expires)",
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
  const implementationLaunches: string[] = [];
  const repository = { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare };
  const selectedRepositories: unknown[] = [];
  const launch: AgentLaunch = (input) => {
    if (input.purpose === "implement") implementationLaunches.push(sourceIdentifier(input.itemId));
    scripts += 1;
    const scriptPath = path.join(layout.root, `script-${scripts}.json`);
    const resultPath = path.join(layout.root, `result-${scripts}.json`);
    results.set(`${input.purpose}:${sourceIdentifier(input.itemId)}`, resultPath);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        ...(() => {
          const script = scriptFor(input);
          if (
            input.purpose === "implement" &&
            sourceIdentifier(input.itemId) === "ENG-2" &&
            input.prompt.includes("Handoff from the previous session.")
          )
            script.steps.splice(script.steps.length - 1, 0, {
              type: "publish_artifact",
              path: "ok.txt",
            });
          return script;
        })(),
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
  let uploadedDuringCode = false;
  let inputDownloads = 0;
  const artifactFiles = createLinearFileTransfer({
    client: {
      async query() {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload?signature=host-only",
              assetUrl: "https://uploads.linear.app/workspace/result",
              headers: [],
            },
          },
        };
      },
    },
    auth: {
      async ensureFresh() {
        return "host-only";
      },
    },
    fetch: async (_url, request) => {
      if (request?.method !== "PUT") {
        inputDownloads++;
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      }
      expect(stateOf(db, "ENG-2")).toBe("running");
      expect(github.opened).toHaveLength(0);
      expect(tracker.progress.some((update) => update.kind === "response")).toBe(false);
      uploadedDuringCode = true;
      return new Response(null, { status: 200 });
    },
  });
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker,
    linearTaskModes: true,
    files: artifactFiles,
    secretsDir: path.join(layout.pawsRoot, "secrets"),
    repository: { owner: "other", repo: "wrong", remoteUrl: path.join(layout.root, "wrong.git") },
    githubForRepository(selected) {
      selectedRepositories.push(selected);
      expect(selected).toEqual(repository);
      return { appId: "1", installationId: "2", privateKeyPem: PRIVATE_KEY, client };
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
    for (const item of listWorkItems(db)) bindWorkItemRepository(db, item.id, repository);
    const deadline = Date.now() + 80_000;
    let idle = 0;
    while (Date.now() < deadline && !delegationMerged(db)) {
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
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(false);
    expect(tracker.progress.some((update) => update.body.includes("Epic abandoned"))).toBe(false);
    expect(
      tracker.sessionUpdates.some((update) =>
        update.addedExternalUrls?.some((link) => link.label === "Pull request"),
      ),
    ).toBe(true);
    const completedPlan = tracker.sessionUpdates.findLast((update) => update.plan)?.plan;
    expect(completedPlan?.slice(-3).map((step) => step.content)).toEqual([
      "Verify changes",
      "Open pull request",
      "Merge verified changes",
    ]);
    expect(completedPlan?.every((step) => step.status === "completed")).toBe(true);

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
      prompts?: unknown[];
    };
    expect(JSON.stringify(asked.prompts)).toContain("Answer: yes");
    const kinds = new Set(tracker.progress.map((update) => update.kind));
    expect(kinds.has("thought")).toBe(true);
    expect(kinds.has("action")).toBe(true);
    expect(kinds.has("response")).toBe(false);
    expect(delegationMerged(db), debug(layout, db)).toBe(true);
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
    expect(implementationLaunches).toEqual(["ENG-2", "ENG-2", "ENG-3"]);
    expect(uploadedDuringCode).toBe(true);
    expect(inputDownloads).toBe(1);
    const inputTrace = JSON.parse(await readFile(results.get("implement:ENG-2")!, "utf8")) as {
      prompts: unknown[];
    };
    expect(JSON.stringify(inputTrace.prompts)).toContain(".paws-linear-inputs");
    expect(JSON.stringify(inputTrace.prompts)).not.toContain("signature=expires");
    const artifactItem = db
      .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_issue_id = ?")
      .get("iss-2")!;
    expect(listArtifacts(db, artifactItem.id)).toHaveLength(1);
    expect(listArtifacts(db, artifactItem.id)[0]?.state).toBe("uploaded");
    const artifactIndex = tracker.progress.findIndex((update) =>
      update.body.includes("https://uploads.linear.app/workspace/result"),
    );
    expect(artifactIndex).toBeGreaterThanOrEqual(0);
    expect(tracker.progress[artifactIndex]?.kind).toBe("thought");
    expect(selectedRepositories).toHaveLength(2);
    for (const item of listWorkItems(db)) {
      expect(getWorkItemRepository(db, item.id)).toEqual(repository);
    }
    const completedUpdates = tracker.progress.length;
    for (const tick of keepAliveTicks) tick();
    await outbox.idle();
    expect(tracker.progress).toHaveLength(completedUpdates);
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(false);
  } finally {
    intervalSpy.mockRestore();
    stop = true;
    await answerer;
    db.close();
    await layout.cleanup();
  }
}, 90_000);

test("the demo delegation merges three pull requests in comment mode with gh auth", async () => {
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
            actorId: answer.answeredBy,
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
    while (Date.now() < deadline && !delegationMerged(db)) {
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
    expect(delegationMerged(db), debug(layout, db)).toBe(true);
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
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(false);
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

test.each([false, true])(
  "mixed code publication blocks an ignored artifact failure and permits a corrected retry: %s",
  async (retry) => {
    const layout = await repoLayout();
    const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    const tracker = createFakeTracker([
      {
        linearIssueId: "artifact-gap",
        identifier: "ENG-98",
        title: "Change code and return a screenshot",
        description: null,
        subIssues: [],
      },
    ]);
    const github = createFakeGitHub();
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    const resultPath = path.join(layout.root, "missing-artifact-result.json");
    const launch: AgentLaunch = (input) => {
      const script = path.join(layout.root, `artifact-${input.purpose}.json`);
      writeFileSync(
        script,
        JSON.stringify({
          model:
            input.role === "reviewer" || input.profile?.agent === "codex"
              ? "test-codex-model"
              : "test-claude-model",
          steps:
            input.purpose === "review"
              ? emptyReview().steps
              : [
                  writeOk(input.worktree),
                  { type: "publish_artifact", path: "missing.png", displayName: "Screenshot.png" },
                  ...(retry
                    ? [
                        { type: "fs_write", path: "correct.png", content: "PNG bytes" },
                        {
                          type: "publish_artifact",
                          path: "correct.png",
                          displayName: "Screenshot.png",
                        },
                      ]
                    : []),
                  { type: "end" },
                ],
        }),
      );
      return {
        command: process.execPath,
        args: [
          fakeAgent,
          input.purpose === "implement"
            ? resultPath
            : path.join(layout.root, `${input.purpose}.result.json`),
          script,
        ],
        env: process.env,
      };
    };
    let uploads = 0;
    const files = createLinearFileTransfer({
      client: {
        async query() {
          return {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: "https://storage.example/upload?signature=host-only",
                assetUrl: "https://uploads.linear.app/workspace/result",
                headers: [],
              },
            },
          };
        },
      },
      auth: {
        async ensureFresh() {
          return "host-only";
        },
      },
      fetch: async () => {
        uploads++;
        return new Response(null, { status: 200 });
      },
    });
    const orchestrator = attachOrchestrator({
      db,
      jobs,
      outbox,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      tracker,
      launch,
      files,
      secretsDir: path.join(layout.pawsRoot, "secrets"),
      repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
      github: {
        appId: "1",
        installationId: "2",
        privateKeyPem: PRIVATE_KEY,
        client: githubClient(layout.bare, github),
      },
    });
    try {
      await orchestrator.onLinearEvent(linearEvent("created", null, null, "artifact-gap"));
      for (
        let tick = 0;
        tick < 10 && !["failed", "merged"].includes(stateOf(db, "ENG-98") ?? "");
        tick++
      )
        await jobs.tick();
      const trace = JSON.parse(await readFile(resultPath, "utf8"));
      expect(
        trace.artifact,
        JSON.stringify({ trace, state: stateOf(db, "ENG-98"), progress: tracker.progress }),
      ).toBeDefined();
      expect(trace.artifact.ok).toBe(retry);
      expect(stateOf(db, "ENG-98"), debug(layout, db)).toBe(retry ? "merged" : "failed");
      expect(github.opened).toHaveLength(retry ? 1 : 0);
      expect(github.merged).toHaveLength(retry ? 1 : 0);
      expect(uploads).toBe(retry ? 1 : 0);
      if (!retry) {
        expect(listJobs(db).some((job) => job.queue === JOB_KIND.merge)).toBe(false);
        expect(tracker.progress.some((update) => update.kind === "response")).toBe(false);
        expect(
          tracker.progress.some(
            (update) => update.kind === "error" && update.body.includes("requested artifact"),
          ),
        ).toBe(true);
      }
    } finally {
      db.close();
      await layout.cleanup();
    }
  },
  20000,
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
        (update) =>
          update.kind === "error" &&
          update.body.includes("No configured GitHub repository is accessible"),
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

for (const recovery of [
  "guidance",
  "bypass",
  "stale bypass",
  "missing bypass reason",
  "unfailed bypass check",
] as const) {
  test(`Closeout ${recovery} survives restart`, async () => {
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
          : recovery === "missing bypass reason"
            ? "/paws bypass test"
            : recovery === "unfailed bypass check"
              ? "/paws bypass unrelated -- Wrong check"
              : "/paws bypass test -- Approved known fixture failure";
      const event = {
        ...linearEvent("prompted", answer, null),
        payload: JSON.stringify({ questionId: question.id, answeredBy: "pascal" }),
      };
      await runtime.orchestrator.onLinearEvent(event);
      await runtime.orchestrator.onLinearEvent(event);
      expect(getQuestion(db, question.id)?.answeredBy).toBe("pascal");
      if (recovery === "missing bypass reason" || recovery === "unfailed bypass check") {
        expect(stateOf(db, "ENG-8"), debug(layout, db)).toBe("awaiting_input");
        const replacement = findOpenQuestion(db, "ses_1")!;
        expect(replacement.id).not.toBe(question.id);
        expect(replacement.body).toContain("Use /paws bypass check-id -- your reason");
        await runtime.orchestrator.onLinearEvent({
          ...event,
          dedupeKey: `${event.dedupeKey}:old-question`,
          activityId: "old-question-reply",
          updatedAtMs: Math.max(Date.now(), replacement.createdAt + 1),
          body: "/paws bypass test -- Approved known fixture failure",
        });
        expect(getQuestion(db, replacement.id)?.status).toBe("open");
        expect(stateOf(db, "ENG-8"), debug(layout, db)).toBe("awaiting_input");
        expect(
          listJobs(db).filter(
            (job) => job.queue === JOB_KIND.resume || job.queue === JOB_KIND.reverify,
          ),
        ).toHaveLength(0);
        expect(
          listCloseoutRecoveries(db, question.itemId).find(
            (entry) => entry.questionId === replacement.id,
          )?.retryBaseline,
        ).toEqual(context.retryBaseline);
        expect(launches).toEqual(["implement", "fix"]);
        expect(github.opened).toHaveLength(0);
        expect(github.merged).toHaveLength(0);
        return;
      }
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

test("grok implementer runs the demo delegation with ask_team and one Closeout fix", async () => {
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
    while (Date.now() < deadline && !delegationMerged(db)) {
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
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(false);
    expect(tracker.progress.some((update) => update.body.includes("Epic abandoned"))).toBe(false);
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
    expect(JSON.stringify(asked.prompts)).toContain("Answer: yes");
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
    expect(delegationMerged(db), debug(layout, db)).toBe(true);
    expect(stateOf(db, "ENG-2"), debug(layout, db)).toBe("merged");
    expect(stateOf(db, "ENG-3"), debug(layout, db)).toBe("merged");
    expect(github.opened[1]?.body).toContain("Fix attempts: 1");
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(false);
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

for (const movedHead of [false, true]) {
  test(`a restarted merge re-verifies the same head after ${movedHead ? "repeated head movement" : "startup"} and merges exactly once`, async () => {
    const layout = await repoLayout();
    const tracker = createFakeTracker([
      {
        linearIssueId: "recover-merge",
        identifier: "ENG-31",
        title: "Recover a verified merge",
        description: null,
        subIssues: [],
      },
    ]);
    let db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    const github = createFakeGitHub();
    let sequence = 0;
    let reviews = 0;
    let rejectedHeads = 0;
    const originalClient = githubClient(layout.bare, github);
    const attach = () => {
      const jobs = new JobLoop(db, systemClock);
      const orchestrator = attachOrchestrator({
        db,
        jobs,
        outbox: new OutboxDispatcher(db, systemClock),
        pawsRoot: layout.pawsRoot,
        home: layout.home,
        tracker,
        repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
        github: {
          appId: "1",
          installationId: "2",
          privateKeyPem: PRIVATE_KEY,
          client: {
            async request(request) {
              if (movedHead && request.path === "/graphql" && rejectedHeads < 2) {
                rejectedHeads++;
                return { status: 200, body: fakeMergeReadiness("c".repeat(40)) };
              }
              return originalClient.request(request);
            },
          },
        },
        launch(input) {
          if (input.purpose === "review") reviews++;
          const script = path.join(layout.root, `merge-restart-${++sequence}.json`);
          writeFileSync(
            script,
            JSON.stringify({
              model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
              steps:
                input.purpose === "review"
                  ? emptyReview().steps
                  : [writeOk(input.worktree), { type: "end" }],
            }),
          );
          return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
        },
      });
      return { jobs, orchestrator };
    };
    try {
      const first = attach();
      await first.orchestrator.onLinearEvent(linearEvent("created", null, null, "recover-merge"));
      await first.jobs.tick();
      const item = listWorkItems(db)[0]!;
      const original = listJobs(db).find((job) => job.queue === JOB_KIND.merge)!;
      expect(item.state).toBe("merge_queue");
      expect(reviews).toBe(1);
      expect(github.merged).toHaveLength(0);
      db.close();
      db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
      recoverOnStartup(db);
      const restarted = attach();
      await restarted.jobs.tick();
      const retry = listJobs(db).find(
        (job) => job.queue === JOB_KIND.merge && job.status === "pending",
      );
      expect(retry, debug(layout, db)).toBeDefined();
      expect(retry!.id).not.toBe(original.id);
      expect(retry!.payload).toMatchObject({ head: item.checkpoint!.wipCommit });
      expect(listJobs(db).find((job) => job.id === original.id)?.status).toBe("cancelled");
      for (let tick = 0; tick < 5; tick++) await restarted.jobs.tick();
      expect(getWorkItem(db, item.id)?.state, debug(layout, db)).toBe("merged");
      expect(github.merged).toHaveLength(1);
      expect(rejectedHeads).toBe(movedHead ? 2 : 0);
      expect(
        listJobs(db).filter((job) => job.queue === JOB_KIND.merge && job.status === "done"),
      ).toHaveLength(movedHead ? 3 : 1);
      expect((await exec("git", ["--git-dir", layout.bare, "show", "main:ok.txt"])).stdout).toBe(
        "ok\n",
      );
      await restarted.jobs.tick();
      expect(github.merged).toHaveLength(1);
    } finally {
      db.close();
      await layout.cleanup();
    }
  }, 30_000);
}

const REBASE_INSTRUCTION =
  "The pull request no longer rebases cleanly onto main. Fetch the latest main, rebase this branch onto it, resolve every conflict so the change still does what the issue asks, and run the checks again.";
const REBASE_THOUGHT = "Main moved and the branch conflicts. Sent it back to the agent to rebase.";

test("a conflicting rebase sends the item back to the agent and then merges", async () => {
  const result = await runRebaseConflict("resolve");
  expect(result.state, result.detail).toBe("merged");
  expect(result.merged, result.detail).toBe(1);
  expect(
    result.thoughts.filter((body) => body === REBASE_THOUGHT),
    result.detail,
  ).toEqual([REBASE_THOUGHT]);
  expect(
    result.prompts.filter((prompt) => prompt.includes(REBASE_INSTRUCTION)),
    result.detail,
  ).toHaveLength(1);
  expect(result.handoffs, result.detail).toEqual([REBASE_INSTRUCTION]);
  expect(result.returnPhases, result.detail).toEqual(["running"]);
}, 90_000);

test("a rebased and re-verified merge still passes the GitHub App integration", async () => {
  let checks = 0;
  const host = Object.assign(new FakeHostGitHubAuth(), {
    integration: {
      check: async () => {
        checks += 1;
        return true;
      },
      administrators: () => [],
      recoveryUrl: "http://127.0.0.1:8787/status",
      identity: () => "human",
    },
  });
  host.account = { id: 7, login: "owner" };
  const identity = {
    GIT_AUTHOR_NAME: "Paws Test",
    GIT_AUTHOR_EMAIL: "paws-test@example.invalid",
    GIT_COMMITTER_NAME: "Paws Test",
    GIT_COMMITTER_EMAIL: "paws-test@example.invalid",
  };
  const previous = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
  Object.assign(process.env, identity);
  let result: Awaited<ReturnType<typeof runRebaseConflict>>;
  try {
    result = await runRebaseConflict("clean", host);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  expect(result.state, result.detail).toBe("merged");
  expect(result.merged, result.detail).toBe(1);
  expect(checks).toBeGreaterThan(0);
}, 120_000);

test("the active task merges while a later task in its session also waits to merge", async () => {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent-pair",
      identifier: "ENG-80",
      title: "Two independent changes",
      description: null,
      subIssues: [
        { linearIssueId: "pair-a", identifier: "ENG-81", title: "Write a.txt" },
        { linearIssueId: "pair-b", identifier: "ENG-82", title: "Write b.txt" },
      ],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const github = createFakeGitHub();
  const client = githubClient(layout.bare, github);
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
      client: {
        async request(req) {
          const response = await client.request(req);
          if (req.path !== "/graphql" || stateOf(db, "ENG-82") === "merge_queue") return response;
          const body = fakeMergeReadiness(
            (req.body as { variables: { head: string } }).variables.head,
          );
          body.data.repository.object.statusCheckRollup.state = "PENDING";
          return { status: 200, body };
        },
      },
    },
    launch(input) {
      sequence += 1;
      const scriptPath = path.join(layout.root, `pair-${sequence}.json`);
      const resultPath =
        input.purpose === "implement" ? path.join(layout.root, `pair-result-${sequence}.json`) : "";
      const file = sourceIdentifier(input.itemId) === "ENG-81" ? "a.txt" : "b.txt";
      const steps: FakeScript["steps"] =
        input.purpose === "implement"
          ? [
              { type: "fs_write", path: path.join(input.worktree, file), content: "done\n" },
              { type: "end" },
            ]
          : emptyReview().steps;
      writeFileSync(
        scriptPath,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps,
        }),
      );
      return {
        command: process.execPath,
        args: [fakeAgent, resultPath, scriptPath],
        env: process.env,
      };
    },
  });
  try {
    await commitOnMain(layout.bare, "ok\n");
    await orchestrator.onLinearEvent(linearEvent("created", null, null, "parent-pair"));
    const deadline = Date.now() + 80_000;
    while (Date.now() < deadline && stateOf(db, "ENG-81") !== "merge_queue") {
      if ((await jobs.tick()) === null) await Bun.sleep(25);
    }
    db.run("UPDATE work_item SET state = 'merge_queue' WHERE linear_identifier = 'ENG-82'");
    while (Date.now() < deadline && !["merged", "failed"].includes(stateOf(db, "ENG-81")!)) {
      if ((await jobs.tick()) === null) await Bun.sleep(25);
    }
    expect(stateOf(db, "ENG-81"), debug(layout, db)).toBe("merged");
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}, 120_000);

test("the agent's open_pull_request title and description open the pull request", async () => {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "pr-tool",
      identifier: "ENG-90",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const github = createFakeGitHub();
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
      sequence += 1;
      const scriptPath = path.join(layout.root, `pr-tool-${sequence}.json`);
      const resultPath =
        input.purpose === "implement"
          ? path.join(layout.root, `pr-tool-result-${sequence}.json`)
          : "";
      const steps: FakeScript["steps"] =
        input.purpose === "implement"
          ? [
              writeOk(input.worktree),
              {
                type: "open_pull_request",
                title: "Add ok.txt for the seeded check",
                body: "Writes ok.txt.\n\nVerified with test -f ok.txt.",
              },
              { type: "end" },
            ]
          : emptyReview().steps;
      writeFileSync(
        scriptPath,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps,
        }),
      );
      return {
        command: process.execPath,
        args: [fakeAgent, resultPath, scriptPath],
        env: process.env,
      };
    },
  });
  try {
    await orchestrator.onLinearEvent(linearEvent("created", null, null, "pr-tool"));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !["merged", "failed"].includes(stateOf(db, "ENG-90") ?? "")) {
      if ((await jobs.tick()) === null) await Bun.sleep(25);
    }
    expect(stateOf(db, "ENG-90"), debug(layout, db)).toBe("merged");
    expect(github.opened[0]?.title).toBe("Add ok.txt for the seeded check");
    expect(github.opened[0]?.body).toStartWith(
      "Fixes ENG-90\n\nWrites ok.txt.\n\nVerified with test -f ok.txt.\n\nCloseout: accepted",
    );
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}, 120_000);

test("a CI failure sends the task back to its agent and the fixed head merges", async () => {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "ci-fail",
      identifier: "ENG-91",
      title: "Write ok.txt",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const github = createFakeGitHub();
  const client = githubClient(layout.bare, github);
  const failedHeads = new Set<string>();
  const prompts: string[] = [];
  let sequence = 0;
  let implements_ = 0;
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
      client: {
        async request(req) {
          if (req.path !== "/graphql") return client.request(req);
          const head = (req.body as { variables: { head: string } }).variables.head;
          if (failedHeads.size > 0 && !failedHeads.has(head)) return client.request(req);
          failedHeads.add(head);
          const body = fakeMergeReadiness(head);
          Object.assign(body.data.repository.object.statusCheckRollup, {
            state: "FAILURE",
            contexts: {
              checkRunCount: 1,
              statusContextCount: 0,
              nodes: [{ name: "test", conclusion: "FAILURE", detailsUrl: "https://ci.example/1" }],
            },
          });
          return { status: 200, body };
        },
      },
    },
    launch(input) {
      sequence += 1;
      const scriptPath = path.join(layout.root, `ci-${sequence}.json`);
      const resultPath =
        input.purpose === "implement" ? path.join(layout.root, `ci-result-${sequence}.json`) : "";
      if (input.purpose === "implement") {
        implements_ += 1;
        prompts.push(input.prompt);
      }
      const steps: FakeScript["steps"] =
        input.purpose === "implement"
          ? [writeOk(input.worktree, `ok-${implements_}\n`), { type: "end" }]
          : emptyReview().steps;
      writeFileSync(
        scriptPath,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps,
        }),
      );
      return {
        command: process.execPath,
        args: [fakeAgent, resultPath, scriptPath],
        env: process.env,
      };
    },
  });
  try {
    await orchestrator.onLinearEvent(linearEvent("created", null, null, "ci-fail"));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !["merged", "failed"].includes(stateOf(db, "ENG-91") ?? "")) {
      if ((await jobs.tick()) === null) await Bun.sleep(25);
    }
    expect(stateOf(db, "ENG-91"), debug(layout, db)).toBe("merged");
    expect(implements_).toBe(2);
    expect(prompts[1]).toContain("- test (https://ci.example/1)");
    expect(tracker.progress.map((update) => update.body)).toContain(
      "CI failed (test). Sent it back to the agent to fix.",
    );
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}, 120_000);

test("after 3 rebase conflict returns the item fails", async () => {
  const result = await runRebaseConflict("repeat");
  expect(result.state, result.detail).toBe("failed");
  expect(result.merged, result.detail).toBe(0);
  expect(
    result.thoughts.filter((body) => body === REBASE_THOUGHT),
    result.detail,
  ).toHaveLength(3);
  expect(result.handoffs, result.detail).toEqual([
    REBASE_INSTRUCTION,
    REBASE_INSTRUCTION,
    REBASE_INSTRUCTION,
  ]);
  expect(
    result.prompts.filter((prompt) => prompt.includes(REBASE_INSTRUCTION)),
    result.detail,
  ).toHaveLength(3);
  expect(result.thoughts, result.detail).toContain("rebase conflict");
}, 120_000);

test("a rebase_failed merge fails the item", async () => {
  const result = await runRebaseConflict("rebase-failed");
  expect(result.state, result.detail).toBe("failed");
  expect(result.merged, result.detail).toBe(0);
  expect(
    result.thoughts.filter((body) => body === REBASE_THOUGHT),
    result.detail,
  ).toEqual([]);
  expect(result.handoffs, result.detail).toEqual([]);
  expect(
    result.prompts.some((prompt) => prompt.includes(REBASE_INSTRUCTION)),
    result.detail,
  ).toBe(false);
  expect(result.thoughts, result.detail).toContain("rebase failed");
}, 60_000);

async function runRebaseConflict(
  mode: "resolve" | "repeat" | "rebase-failed" | "clean",
  githubAuth?: FakeHostGitHubAuth,
): Promise<{
  state: string | null;
  thoughts: string[];
  prompts: string[];
  handoffs: string[];
  returnPhases: (string | null)[];
  merged: number;
  detail: string;
}> {
  const layout = await repoLayout();
  const identifier =
    mode === "resolve"
      ? "ENG-70"
      : mode === "repeat"
        ? "ENG-71"
        : mode === "clean"
          ? "ENG-73"
          : "ENG-72";
  const tracker = createFakeTracker([
    {
      linearIssueId: `rebase-${mode}`,
      identifier,
      title: "Rebase onto main",
      description: null,
      subIssues: [],
    },
  ]);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const github = createFakeGitHub();
  const implementResults: string[] = [];
  let sequence = 0;
  let implementTurns = 0;
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
    ...(githubAuth ? { githubAuth } : {}),
    launch(input) {
      sequence += 1;
      const scriptPath = path.join(layout.root, `rebase-${mode}-${sequence}.json`);
      const resultPath =
        input.purpose === "implement"
          ? path.join(layout.root, `rebase-${mode}-result-${sequence}.json`)
          : "";
      if (resultPath) implementResults.push(resultPath);
      let steps: FakeScript["steps"];
      if (input.purpose === "review" || input.purpose === "prepare") steps = emptyReview().steps;
      else if (mode === "resolve" && implementTurns > 0) steps = rebaseOntoMainSteps();
      else steps = [writeOk(input.worktree, `agent-${implementTurns}\n`), { type: "end" }];
      if (input.purpose === "implement") implementTurns += 1;
      writeFileSync(
        scriptPath,
        JSON.stringify({
          model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
          steps,
        }),
      );
      return {
        command: process.execPath,
        args: [fakeAgent, resultPath, scriptPath],
        env: process.env,
      };
    },
  });
  try {
    await orchestrator.onLinearEvent(linearEvent("created", null, null, `rebase-${mode}`));
    await jobs.tick();
    expect(stateOf(db, identifier), debug(layout, db)).toBe("merge_queue");
    if (mode === "rebase-failed") {
      await commitOnMain(layout.bare, "side\n", "side.txt");
      await installRebaseHook(layout.pawsRoot);
    } else if (mode === "clean") await commitOnMain(layout.bare, "side\n", "side.txt");
    else await commitOnMain(layout.bare, "from-main\n");
    const returnPhases: (string | null)[] = [];
    let idle = 0;
    for (let turn = 0; turn < 40;) {
      const state = stateOf(db, identifier);
      if (state === "merged" || state === "failed") break;
      const job = await jobs.tick();
      const next = stateOf(db, identifier);
      if (state === "merge_queue" && next === "running")
        returnPhases.push(checkpointPhaseOf(db, identifier));
      if (job !== null) turn += 1;
      if (job !== null || next !== state) idle = 0;
      else if (idle++ < 2400) await Bun.sleep(25);
      else break;
    }
    while (outbox.tick().length > 0) await outbox.idle();
    const prompts: string[] = [];
    for (const file of implementResults) {
      if (!existsSync(file)) continue;
      prompts.push(
        JSON.stringify((JSON.parse(await readFile(file, "utf8")) as FakeResult).prompts ?? []),
      );
    }
    return {
      state: stateOf(db, identifier),
      thoughts: tracker.progress.map((update) => update.body),
      prompts,
      handoffs: listJobs(db)
        .filter((job) => job.queue === JOB_KIND.resume)
        .map((job) => (job.payload as { handoff?: string }).handoff ?? ""),
      returnPhases,
      merged: github.merged.length,
      detail: debug(layout, db),
    };
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    db.close();
    await layout.cleanup();
  }
}

function rebaseOntoMainSteps(): FakeScript["steps"] {
  return [
    {
      type: "terminal",
      command: "sh",
      args: [
        "-c",
        [
          "export GIT_EDITOR=true",
          "export GIT_SEQUENCE_EDITOR=true",
          "onto=origin/main",
          "if git rev-parse --verify --quiet refs/paws/upstream-main >/dev/null 2>&1; then",
          "onto=refs/paws/upstream-main",
          "fi",
          'git_c() { git -c user.email=paws-test@example.com -c user.name=Paws -c commit.gpgsign=false -c core.editor=true "$@"; }',
          'if ! git_c rebase "$onto"; then',
          "printf 'ok\\n' > ok.txt",
          "git add ok.txt",
          "git_c rebase --continue",
          "fi",
        ].join("\n"),
      ],
    },
    { type: "end", stopReason: "end_turn" },
  ];
}

async function commitOnMain(bare: string, content: string, file = "ok.txt"): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "paws-main-"));
  try {
    await exec("git", ["clone", bare, dir]);
    await gitIdentity(dir);
    await writeFile(path.join(dir, file), content);
    await exec("git", ["-C", dir, "add", file]);
    await exec("git", ["-C", dir, "commit", "-m", "main moves"]);
    await exec("git", ["-C", dir, "push", "origin", "HEAD:main"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function installRebaseHook(pawsRoot: string): Promise<void> {
  const mirror = path.join(pawsRoot, "repos", "pmdroid", "paws-demo.git");
  const hooks = path.join(mirror, "hooks");
  await mkdir(hooks, { recursive: true });
  const hook = path.join(hooks, "pre-rebase");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await exec("chmod", ["755", hook]);
  await exec("git", ["--git-dir", mirror, "config", "core.hooksPath", hooks]);
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

function demoScript(input: {
  purpose: string;
  itemId: string;
  worktree: string;
  prompt: string;
}): FakeScript {
  if (input.purpose === "review") return emptyReview();
  if (input.purpose === "fix") {
    return { steps: [writeOk(input.worktree), { type: "end", stopReason: "end_turn" }] };
  }
  if (input.itemId === "ENG-4") {
    if (input.prompt.includes("Handoff from the previous session.")) {
      return {
        steps: [
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
          type: "ask_team",
          question: "Include archived rows?",
          options: ["yes", "no"],
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

function scriptFor(input: {
  purpose: string;
  itemId: string;
  worktree: string;
  prompt: string;
}): FakeScript {
  if (input.purpose === "classify")
    return {
      steps: [
        {
          type: "update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: '{"mode":"code"}' },
          },
        },
        { type: "end" },
      ],
    };
  if (input.purpose === "review") return emptyReview();
  if (input.purpose === "fix") {
    return {
      steps: [writeOk(input.worktree, "header\n"), { type: "end", stopReason: "end_turn" }],
    };
  }
  if (sourceIdentifier(input.itemId) === "ENG-2") {
    if (input.prompt.includes("Handoff from the previous session.")) {
      return {
        steps: [
          {
            type: "update",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "write-export",
              title: "Write export",
            },
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
            content: { type: "text", text: "Need a product decision." },
          },
        },
        {
          type: "ask_team",
          question: "Include archived rows?",
          options: ["yes", "no"],
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
    actorId: action === "prompted" ? "human-1" : null,
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

function checkpointPhaseOf(db: Database, identifier: string): string | null {
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_identifier = ?")
    .get(identifier);
  return row ? (getWorkItem(db, row.id)?.checkpoint?.phase ?? null) : null;
}

function stateOf(db: Database, identifier: string): string | null {
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_identifier = ?")
    .get(identifier);
  if (!row) return null;
  return getWorkItem(db, row.id)?.state ?? null;
}

function delegationMerged(db: Database): boolean {
  const items = db.query<{ state: string }, []>("SELECT state FROM work_item").all();
  return items.length > 0 && items.every((item) => item.state === "merged");
}

function debug(layout: { pawsRoot: string }, db: Database): string {
  try {
    const jobs = listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`);
    const items = db
      .query<{ linear_identifier: string; state: string }, []>(
        "SELECT linear_identifier, state FROM work_item ORDER BY position",
      )
      .all();
    return JSON.stringify({ paws: layout.pawsRoot, items, jobs });
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

for (const race of ["token", "merge", "followup"] as const) {
  test(`Stop during GitHub ${race} publication preserves verified external truth`, async () => {
    const layout = await repoLayout();
    const tracker = createFakeTracker([
      {
        linearIssueId: "publication",
        identifier: "ENG-50",
        title: "Guard publication",
        description: null,
        subIssues: [],
      },
    ]);
    const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    const jobs = new JobLoop(db, systemClock);
    const outbox = new OutboxDispatcher(db, systemClock);
    const github = createFakeGitHub();
    const original = githubClient(layout.bare, github);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
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
        tokenProvider: {
          mode: "oauth",
          async tokenFor(purpose) {
            if (race === "token" && purpose === "push") {
              reached.resolve();
              await release.promise;
            }
            return "synthetic-token";
          },
        },
        client: {
          async request(request) {
            const response = await original.request(request);
            if (race !== "token" && request.method === "PUT") {
              reached.resolve();
              await release.promise;
            }
            return response;
          },
        },
      },
      launch(input) {
        const script = path.join(layout.root, `publication-${++sequence}.json`);
        writeFileSync(
          script,
          JSON.stringify({
            model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
            steps:
              input.purpose === "review"
                ? emptyReview().steps
                : [writeOk(input.worktree), { type: "end" }],
          }),
        );
        return { command: process.execPath, args: [fakeAgent, "", script], env: process.env };
      },
    });
    try {
      await orchestrator.onLinearEvent(linearEvent("created", null, null, "publication"));
      await jobs.tick();
      const item = db.query<{ id: string }, []>("SELECT id FROM work_item").get()!;
      expect(getWorkItem(db, item.id)?.state).toBe("merge_queue");
      const publication = jobs.tick();
      await reached.promise;
      const stopped = orchestrator.onLinearEvent(
        race === "followup"
          ? linearEvent("prompted", "Also implement a different follow-up", null, "publication")
          : linearEvent("prompted", null, "stop"),
      );
      if (race !== "followup")
        for (let i = 0; i < 1_000 && getWorkItem(db, item.id)?.state !== "cancelled"; i++)
          await Bun.sleep(1);
      if (race !== "followup") expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
      else await Bun.sleep(10);
      release.resolve();
      await publication;
      await stopped;
      expect(getWorkItem(db, item.id)?.state).toBe(race === "followup" ? "merged" : "cancelled");
      if (race === "followup") {
        const items = db
          .query<{ id: string; state: string }, []>("SELECT id, state FROM work_item")
          .all();
        expect(items).toHaveLength(2);
        expect(items.find((entry) => entry.id !== item.id)?.state).toBe("queued");
      }
      expect(tracker.statuses.some((status) => status.stateType === "completed")).toBe(false);
      if (race === "token") {
        expect(github.opened).toEqual([]);
        expect(github.merged).toEqual([]);
        expect(getConfirmedRemoteMerge(db, item.id)).toBeNull();
      } else {
        expect(github.merged).toHaveLength(1);
        const sha = (
          await exec("git", ["--git-dir", layout.bare, "rev-parse", "main"])
        ).stdout.trim();
        expect(getConfirmedRemoteMerge(db, item.id)).toMatchObject({
          repositoryOwner: "pmdroid",
          repositoryName: "paws-demo",
          pullNumber: 1,
          mergeSha: sha,
        });
      }
    } finally {
      release.resolve();
      await orchestrator.shutdown();
      db.close();
      await layout.cleanup();
    }
  }, 30_000);
}

test("a Linear correction interrupts code, returns a screenshot, and completes after verified merge through Linear", async () => {
  const layout = await repoLayout();
  let db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Draw the corrected chart",
      description: "Create the chart and its screenshot.",
      subIssues: [],
    },
  ]);
  const github = createFakeGitHub();
  const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
  const access = createFakeLinearAccessReads({
    installation: scope,
    sessions: [{ ...scope, sessionId: "ses_1", issueId: "issue", teamId: "team" }],
    teams: ["team"],
  });
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "issue",
    teamId: "team",
    assigneeId: "pascal",
    delegateId: null,
    stateType: "unstarted",
  });
  const revoked: string[] = [];
  let gate: LinearTaskAccess;
  let jobs = new JobLoop(db, systemClock);
  let outbox = new OutboxDispatcher(db, systemClock);
  const traces: string[] = [];
  let implementations = 0;
  let uploaded = false;
  const implementationTraces: string[] = [];
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAADJ0lEQVR42u3csbHCMBBFUbfgjA4oQQGRSlBL1EAHbsKVEUMBJDJivFrOzG3g4T2jH/1lvVwlTdriJ5AAlgSwJIAlgCUBLAlgSQBLAEsCWBLAEsCSAJYEsCSAJYAlASwJYEkASwB/7rHt7/yyEsCSAJYABlgCWBLAkgCWAAZYAlgSwBLA3wIutUnqygsseYEBlgCWBLCydbs/IwQwwAIYYAEMMMACGGCABTDAAAtggAUwwAALYIABFsAASwADLIABBlgAAwywAAZYAAMMsAAGGGABDLAEMMACGGCABTDAAAtggAUwwAALYIABFsAAAyyAARbAAAMsgAEGWAADLAEMsAAGGGABDDDAAjgz4FKbegty2WaelRfY0zTB0+QF9ic0wAADDDDAAAMMsMs2E2ABDDDAAAMMMMAAmwmwXDbAAAMMMMAAAwwwwAC7bDMBFsAAAwwwwAADDDDAAAPsss0EGGCAAQYYYIABBhhgMwGWywYYYIABBhhggAEGGGCXbSbAAhhggAEGGGCAAQYYYIBdtpkAAwwwwAADDDDAAANsJsBy2QADDDDAAE8G2GWbCTDALttMgAF22WamB1xqG1iQTz52lJm5Zx7IC+xpMtMLDLDLNhNgn9xMgAF22WYCDLDLNhNggF22mQD75GYCDLDLNhNggF22mQADbKaZALtsMwEG2GWbCTDALttMgH1yMwEG2GWbCTDALttMgAF22WYC7JObCTDALttMgAF22WYCDLCZZgLsss0EGGCXbSbAALtsMwH2yc0EGGCXbSbAALtsMwEG2GWbCbBPbibAALtsMwEG2GWbCTDAZgIMsMs2E2CAXbaZAHcCLrUNLMgnHzvKzNwzD+QF9jSZ6QUG2GWbCbBPbibAALtsMwEG2GWbCTDALttMgH1yMwEG2GWbCTDALttMgAE200yAXbaZAAPsss0EGGCXbSbAPrmZAAPsss0EGGCXbSbAALtsMwH2yc0EGGCXbSbAsf8nlvQPhQAsaeIXWBLAkgCWAJYEsCSAJQEsASwJYEkASwBLAlgSwJIAlgCWBLAkgCUBLAEsCWBJAEsASwJY0g97Ae4LgLPej1NpAAAAAElFTkSuQmCC";
  const files = createLinearFileTransfer({
    client: {
      async query() {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload",
              assetUrl: "https://uploads.linear.app/chart.png",
              headers: [],
            },
          },
        };
      },
    },
    auth: {
      async ensureFresh() {
        return "host-only";
      },
    },
    fetch: async (_url, request) => {
      expect(request?.method).toBe("PUT");
      expect(stateOf(db, "ENG-1")).toBe("running");
      expect(github.opened).toHaveLength(0);
      expect(tracker.progress.some((update) => update.kind === "response")).toBe(false);
      expect(Buffer.from(await new Response(request?.body).arrayBuffer())).toEqual(
        Buffer.from(png, "base64"),
      );
      uploaded = true;
      return new Response(null, { status: 200 });
    },
  });
  const launch: AgentLaunch = (input) => {
    const message = (text: string): FakeScript["steps"][number] => ({
      type: "update",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
    const steps: FakeScript["steps"] =
      input.purpose === "classify"
        ? [message('{"mode":"code"}'), { type: "end" }]
        : input.purpose === "review"
          ? emptyReview().steps
          : [];
    if (input.purpose === "implement") {
      implementations++;
      if (input.prompt.includes("corrected chart layout"))
        steps.push(
          { type: "fs_write", path: "ok.txt", content: "corrected chart" },
          {
            type: "terminal",
            command: "bun",
            cwd: input.worktree,
            args: ["-e", `await Bun.write('chart.png', Buffer.from('${png}', 'base64'))`],
          },
          {
            type: "publish_artifact",
            path: "chart.png",
            displayName: "chart.png",
            mimeType: "image/png",
            attachToIssue: true,
          },
          message("Created the corrected chart and screenshot."),
          { type: "end" },
        );
      else if (input.prompt.includes("Use larger labels"))
        steps.push(
          message("The chart color was chosen."),
          { type: "fs_write", path: "before-correction.txt", content: "retained" },
          { type: "hang" },
        );
      else if (input.prompt.includes("Handoff from the previous session."))
        steps.push(
          {
            type: "ask_team",
            question: "How should the chart labels look?",
            options: [
              { label: "Original labels", value: "original" },
              { label: "Compact labels", value: "compact" },
            ],
            context: "Freeform label guidance is also welcome.",
          },
          { type: "end" },
        );
      else
        steps.push(
          { type: "fs_write", path: "before-restart.txt", content: "retained across restart" },
          {
            type: "ask_team",
            question: "Which color should the chart use?",
            options: [
              { label: "Ocean blue", value: "blue" },
              { label: "Leaf green", value: "green" },
            ],
          },
          { type: "end" },
        );
    }
    const script = path.join(layout.root, `acceptance-${traces.length}.json`);
    const result = path.join(layout.root, `acceptance-${traces.length}-result.json`);
    traces.push(result);
    if (input.purpose === "implement") implementationTraces.push(result);
    writeFileSync(
      script,
      JSON.stringify({
        model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
        steps,
      }),
    );
    return { command: process.execPath, args: [fakeAgent, result, script], env: process.env };
  };
  const createOrchestrator = () => {
    gate = new LinearTaskAccess(db, {
      access: access.adapter,
      lifecycle,
      oauthClientId: scope.oauthClientId,
      appUserId: scope.appUserId,
      stopSession: (sessionId) => {
        revoked.push(sessionId);
      },
      interruptSession: (sessionId) => orchestrator.interruptLinearSession(sessionId),
    });
    return attachOrchestrator({
      db,
      jobs,
      outbox,
      tracker,
      files,
      secretsDir: path.join(layout.pawsRoot, "secrets"),
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      repository: { owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare },
      github: {
        appId: "1",
        installationId: "2",
        privateKeyPem: PRIVATE_KEY,
        client: githubClient(layout.bare, github),
      },
      launch,
      linearTaskModes: true,
      linearAccess: gate,
    });
  };
  let orchestrator = createOrchestrator();
  const event = (key: string, body: string | null): AcceptedLinearEvent => {
    const createdAt = Math.max(Date.now(), (findOpenQuestion(db, "ses_1")?.createdAt ?? 0) + 1);
    return parseAgentEvent(
      JSON.stringify({
        type: "AgentSessionEvent",
        action: body === null ? "created" : "prompted",
        ...scope,
        agentSession: {
          id: "ses_1",
          creatorId: "pascal",
          issue: { id: "issue", team: { id: "team" } },
        },
        ...(body === null
          ? {}
          : {
              agentActivity: {
                id: key,
                userId: "pascal",
                createdAt: new Date(createdAt).toISOString(),
                content: { type: "prompt", body },
              },
            }),
      }),
      `delivery:${key}`,
      createdAt,
    )!;
  };
  const sendEvent = async (key: string, body: string | null) => {
    const incoming = event(key, body);
    expect(await gate.accept(incoming)).toBe(true);
    await orchestrator.onLinearEvent(incoming);
  };
  let earlyAnswer: Promise<void> | undefined;
  let earlyQuestionId: string | undefined;
  let earlyAnswerState: string | undefined;
  const askQuestion = tracker.askQuestion;
  tracker.askQuestion = async (question, options) => {
    await askQuestion(question, options);
    if (tracker.questions.length === 1) {
      earlyQuestionId = findOpenQuestion(db, "ses_1")!.id;
      earlyAnswer = sendEvent("color-answer", "blue");
      for (
        let attempt = 0;
        attempt < 100 && getQuestion(db, earlyQuestionId)?.status !== "answered";
        attempt++
      )
        await Bun.sleep(1);
      earlyAnswerState = getQuestion(db, earlyQuestionId)?.status;
    }
  };
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 500 && !condition(); i++) await Bun.sleep(10);
    expect(
      condition(),
      debug(layout, db) +
        JSON.stringify({
          implementations,
          traces,
          questions: tracker.questions,
          progress: tracker.progress,
        }),
    ).toBe(true);
  };
  let initial: Promise<unknown> | undefined;
  try {
    await sendEvent("created", null);
    initial = jobs.tick();
    await waitFor(() => tracker.questions.length === 1);
    await initial;
    await jobs.tick();
    await waitFor(() => tracker.questions.length === 2);
    await earlyAnswer;
    expect(earlyAnswerState).toBe("answered");
    expect(getQuestion(db, earlyQuestionId!)).toMatchObject({
      answer: "blue",
      answeredBy: "pascal",
    });
    expect(github.opened).toHaveLength(0);
    expect(tracker.questions[0]?.options).toEqual([
      { label: "Ocean blue", value: "blue" },
      { label: "Leaf green", value: "green" },
    ]);
    await orchestrator.shutdown();
    await initial;
    await outbox.idle();
    db.close();
    db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
    migrate(db);
    jobs = new JobLoop(db, systemClock);
    outbox = new OutboxDispatcher(db, systemClock);
    orchestrator = createOrchestrator();
    expect(findOpenQuestion(db, "ses_1")?.options).toEqual([
      { label: "Original labels", value: "original" },
      { label: "Compact labels", value: "compact" },
    ]);
    const recoveredQuestionId = findOpenQuestion(db, "ses_1")!.id;
    const reopenedDashboard = await handleStatusRequest(
      new Request("http://127.0.0.1/api/linear/conversations"),
      { db, staticDir: null },
    );
    expect(await reopenedDashboard!.json()).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          id: "ses_1",
          questions: expect.arrayContaining([
            expect.objectContaining({ id: recoveredQuestionId, state: "open" }),
          ]),
        }),
      ]),
    });
    expect(getQuestion(db, earlyQuestionId!)).toMatchObject({
      answer: "blue",
      answeredBy: "pascal",
    });
    await sendEvent("color-answer", "blue");
    expect(findOpenQuestion(db, "ses_1")?.id).toBe(recoveredQuestionId);
    await sendEvent("label-answer", "Use larger labels and keep the blue color.");
    expect(getQuestion(db, recoveredQuestionId)).toMatchObject({
      answer: "Use larger labels and keep the blue color.",
      answeredBy: "pascal",
      status: "answered",
    });
    initial = jobs.tick();
    const task = db.query<{ id: string }, []>("SELECT id FROM work_item").get()!;
    const workspace = worktreePath(layout.pawsRoot, itemPathId(getWorkItem(db, task.id)!));
    await waitFor(() => existsSync(path.join(workspace, "before-correction.txt")));
    await sendEvent("correction", "Use the corrected chart layout and include a screenshot.");
    await initial;
    for (let tick = 0; tick < 10 && stateOf(db, "ENG-1") !== "merged"; tick++) await jobs.tick();
    expect(implementations).toBe(4);
    expect(revoked).toEqual([]);
    expect(lifecycle.started.length).toBeGreaterThan(0);
    expect(
      lifecycle.started.every((start) => start.issueId === "issue" && start.actorId === "pascal"),
    ).toBe(true);
    expect(lifecycle.issue.assigneeId).toBe("pascal");
    expect(lifecycle.issue.delegateId).toBe("app");
    expect(tracker.statuses.every((update) => update.linearIssueId === "issue")).toBe(true);
    expect(tracker.questions).toHaveLength(2);
    expect(
      (await exec("git", ["--git-dir", layout.bare, "show", "main:before-correction.txt"])).stdout,
    ).toBe("retained");
    expect(
      (await exec("git", ["--git-dir", layout.bare, "show", "main:before-restart.txt"])).stdout,
    ).toBe("retained across restart");
    expect(uploaded).toBe(true);
    expect(tracker.attachments).toEqual([
      {
        id: expect.any(String),
        issueId: "issue",
        title: "chart.png",
        url: "https://uploads.linear.app/chart.png",
      },
    ]);
    expect(github.opened).toHaveLength(1);
    expect(github.merged).toHaveLength(1);
    expect(stateOf(db, "ENG-1"), debug(layout, db)).toBe("merged");
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(false);
    expect(tracker.progress.some((update) => update.kind === "response")).toBe(false);
    const dashboard = await handleStatusRequest(
      new Request("http://127.0.0.1/api/linear/conversations"),
      { db, staticDir: null },
    );
    expect(dashboard?.status).toBe(200);
    expect(await dashboard!.json()).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          id: "ses_1",
          items: expect.arrayContaining([
            expect.objectContaining({ id: task.id, state: "merged" }),
          ]),
          messages: expect.arrayContaining([
            expect.objectContaining({
              kind: "prompt",
              text: "Use the corrected chart layout and include a screenshot.",
            }),
          ]),
          artifacts: [
            expect.objectContaining({
              displayName: "chart.png",
              state: "uploaded",
              href: expect.stringMatching(/^\/api\/linear\/artifacts\//),
            }),
          ],
          questions: expect.arrayContaining([
            expect.objectContaining({
              id: recoveredQuestionId,
              state: "answered",
              answer: "Use larger labels and keep the blue color.",
            }),
          ]),
        }),
      ]),
    });
    const artifactIndex = tracker.progress.findIndex((update) =>
      update.body.includes("https://uploads.linear.app/chart.png"),
    );
    expect(artifactIndex).toBeGreaterThanOrEqual(0);
    expect(tracker.progress[artifactIndex]?.kind).toBe("thought");
    expect(listArtifacts(db, task.id)).toHaveLength(1);
    expect(listArtifacts(db, task.id)[0]).toMatchObject({
      state: "uploaded",
      mimeType: "image/png",
      displayName: "chart.png",
      sizeBytes: Buffer.from(png, "base64").byteLength,
      assetUrl: "https://uploads.linear.app/chart.png",
    });
    expect(getQuestion(db, earlyQuestionId!)).toMatchObject({
      status: "answered",
      answer: "blue",
    });
    expect(findOpenQuestion(db, "ses_1")).toBeNull();
    const recovered = JSON.parse(await readFile(implementationTraces[2]!, "utf8"));
    expect(JSON.stringify(recovered.prompts)).toContain(
      "Use larger labels and keep the blue color.",
    );
    for (const choice of ["Original labels", "original", "Compact labels", "compact"])
      expect(JSON.stringify(recovered.prompts)).toContain(choice);
    expect(JSON.stringify(recovered.prompts)).toContain("Freeform label guidance is also welcome.");
    const resumed = JSON.parse(await readFile(implementationTraces[3]!, "utf8"));
    expect(JSON.stringify(resumed.prompts)).toContain("blue");
    expect(JSON.stringify(resumed.prompts)).toContain("The chart color was chosen.");
    expect(JSON.stringify(resumed.prompts)).toContain("corrected chart layout");
    expect(JSON.stringify(resumed)).not.toContain("host-only");
  } finally {
    await orchestrator.shutdown();
    await initial;
    await outbox.idle();
    db.close();
    await layout.cleanup();
  }
}, 30000);
