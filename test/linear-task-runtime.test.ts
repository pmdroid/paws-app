import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { systemClock } from "../src/core";
import type { Database } from "bun:sqlite";
import type { FakeStep } from "../src/acp/testing/script";
import {
  getLinearSession,
  getTaskClassification,
  getTaskMode,
  getWorkItem,
  listArtifacts,
  migrate,
  openDatabase,
  listOutbox,
  JobLoop,
  OutboxDispatcher,
} from "../src/db";
import {
  createFakeTracker,
  createLinearFileTransfer,
  createInboxStore,
  startCatchUpPoller,
  type AcceptedLinearEvent,
  type PolledActivity,
} from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { findOpenQuestion, getQuestion } from "../src/questions";
import { tempDb, tempHome } from "./helpers";

function event(): AcceptedLinearEvent {
  return {
    dedupeKey: "session:session:created",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "session",
    issueId: "parent",
    activityId: null,
    actorId: "human",
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: JSON.stringify({
      agentSession: { creatorId: "human" },
      promptContext: "Explain how this works without changing any files.",
    }),
  };
}

function setup(
  mode: "answer" | "code" | "clarify" | "artifact",
  question = "What outcome do you want?",
  hang = false,
  artifactUpload: "ok" | "fail" | "omit" = "ok",
  resolvedMode?: "answer" | "code" | "artifact",
  database?: Database,
  plan = false,
  hangResponse = false,
  toolUpdates: readonly SessionUpdate[] = [],
  responseSteps: readonly FakeStep[] = [],
) {
  const db = database ?? tempDb();
  const home = tempHome();
  const root = join(home, "paws");
  mkdirSync(root);
  const answer = "Complete public answer. ".repeat(500);
  const launches: string[] = [];
  const traces: string[] = [];
  const launch: AgentLaunch = (input) => {
    launches.push(input.purpose);
    const script = join(home, `${launches.length}.script.json`);
    const trace = join(home, `${launches.length}.result.json`);
    traces.push(trace);
    writeFileSync(
      script,
      JSON.stringify({
        steps: [
          ...(input.purpose === "classify" ? [] : responseSteps),
          ...(hang && input.purpose === "classify" && launches.length === 1
            ? [{ type: "hang" }]
            : []),
          ...(input.purpose === "artifact" && artifactUpload !== "omit"
            ? [
                { type: "fs_write", path: "deliverable.txt", content: "Requested deliverable" },
                {
                  type: "publish_artifact",
                  path: "deliverable.txt",
                  displayName: "deliverable.txt",
                  mimeType: "text/plain",
                },
              ]
            : []),
          ...(plan && input.purpose !== "classify"
            ? [
                {
                  type: "update",
                  update: {
                    sessionUpdate: "plan",
                    entries: [
                      { content: "Read the reference", status: "completed", priority: "medium" },
                      {
                        content: "Prepare the requested result",
                        status: "in_progress",
                        priority: "high",
                      },
                    ],
                  },
                },
              ]
            : []),
          ...(hangResponse && input.purpose !== "classify" ? [{ type: "hang" }] : []),
          ...(input.purpose === "classify"
            ? []
            : toolUpdates.map((update) => ({ type: "update", update, delayMs: 30 }))),
          { type: "fs_write", path: "forbidden.txt", content: "denied" },
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text:
                  input.purpose === "classify"
                    ? JSON.stringify({
                        mode: resolvedMode && launches.length > 1 ? resolvedMode : mode,
                        question,
                      })
                    : answer,
              },
            },
          },
          { type: "end" },
        ],
      }),
    );
    return {
      command: process.execPath,
      args: [resolve(import.meta.dir, "../src/acp/testing/fake-agent.ts"), trace, script],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
    };
  };
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "ENG-1",
      title: "Explain the architecture",
      description: "Existing issue",
      subIssues: [{ linearIssueId: "child", identifier: "ENG-2", title: "Implement a feature" }],
    },
  ]);
  let uploads = 0;
  let downloads = 0;
  const files = createLinearFileTransfer({
    client: {
      async query() {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: "https://storage.example/upload?signature=private",
              assetUrl: "https://uploads.linear.app/workspace/deliverable.txt",
              headers: [],
            },
          },
        };
      },
    },
    auth: {
      async ensureFresh() {
        return "host-only-token";
      },
    },
    fetch: async (_url, request) => {
      if (request?.method !== "PUT") {
        downloads++;
        expect(new Headers(request?.headers).get("authorization")).toBe("Bearer host-only-token");
        return new Response("Private reference", { headers: { "content-type": "text/plain" } });
      }
      uploads++;
      return new Response(null, { status: artifactUpload === "fail" ? 503 : 200 });
    },
  });
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    pawsRoot: root,
    home,
    tracker,
    launch,
    linearTaskModes: true,
    files,
    secretsDir: join(root, "secrets"),
  });
  return {
    db,
    home,
    root,
    answer,
    launches,
    traces,
    tracker,
    jobs,
    outbox,
    orchestrator,
    launch,
    uploads: () => uploads,
    downloads: () => downloads,
  };
}

test("a parent discussion classifies before fanout and completes without Git, issue status, or publication", async () => {
  const f = setup("answer");
  try {
    await f.orchestrator.onLinearEvent(event());
    const session = getLinearSession(f.db, "session")!;
    const item = getWorkItem(f.db, session.activeItemId!)!;
    expect(item.linearIssueId).toBe("parent");
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(1);
    expect(getTaskMode(f.db, item.id)).toBe("answer");
    expect(f.launches).toEqual(["classify"]);
    await f.jobs.tick();
    expect(getWorkItem(f.db, item.id)?.state).toBe("completed");
    expect(f.launches).toEqual(["classify", "answer"]);
    expect(f.tracker.statuses).toEqual([]);
    expect(
      f.tracker.progress
        .filter((update) => update.kind === "response")
        .map((update) => update.body),
    ).toEqual([f.answer.trim()]);
    expect(existsSync(join(f.root, "worktrees"))).toBe(false);
    expect(existsSync(join(f.root, "mirrors"))).toBe(false);
    for (const trace of f.traces)
      expect(JSON.parse(readFileSync(trace, "utf8")).fs[0].ok).toBe(false);
    expect(getWorkItem(f.db, item.id)?.checkpoint?.wipCommit).toBeUndefined();
    await f.orchestrator.onLinearEvent(event());
    expect(f.launches).toEqual(["classify", "answer"]);
    expect(f.db.query<{ state: string }, []>("SELECT state FROM epic").get()?.state).toBe("done");
  } finally {
    f.db.close();
  }
});

test("code classification persists before child work is dispatched", async () => {
  const f = setup("code");
  try {
    await f.orchestrator.onLinearEvent(event());
    const session = getLinearSession(f.db, "session")!;
    const item = getWorkItem(f.db, session.activeItemId!)!;
    expect(item.linearIssueId).toBe("child");
    expect(getTaskMode(f.db, item.id)).toBe("code");
    expect(f.launches).toEqual(["classify"]);
    expect(f.tracker.statuses).toEqual([]);
    expect(existsSync(join(f.root, "worktrees"))).toBe(false);
  } finally {
    f.db.close();
  }
});

test("ambiguous outcomes ask for clarification before repository access", async () => {
  const f = setup("clarify", "Explain it, create a file, or change the code?");
  try {
    await f.orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const session = getLinearSession(f.db, "session")!;
    expect(getWorkItem(f.db, session.activeItemId!)?.state).toBe("awaiting_input");
    expect(f.tracker.questions[0]?.body).toBe("Explain it, create a file, or change the code?");
    expect(f.tracker.statuses).toEqual([]);
    expect(f.launches).toEqual(["classify"]);
    expect(existsSync(join(f.root, "worktrees"))).toBe(false);
  } finally {
    f.db.close();
  }
});

test.each([null, "", " \n "])(
  "a polled activity with body %j cannot block a later question reply",
  async (body) => {
    const steps: FakeStep[] = [{ type: "ask_team", question: "Which screenshot?" }];
    const f = setup(
      "answer",
      undefined,
      false,
      "ok",
      undefined,
      undefined,
      false,
      false,
      [],
      steps,
    );
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sleeping = Promise.withResolvers<void>();
    let running: Promise<unknown> | undefined;
    let poller: ReturnType<typeof startCatchUpPoller> | undefined;
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(5);
      expect(condition()).toBe(true);
    };
    try {
      await f.orchestrator.onLinearEvent(event());
      const itemId = getLinearSession(f.db, "session")!.activeItemId!;
      f.tracker.listSessionActivities = async () => {
        ready.resolve();
        await release.promise;
        return [];
      };
      running = f.jobs.tick();
      await ready.promise;
      expect(f.orchestrator.agentAlive(getWorkItem(f.db, itemId)!.currentRunId!)).toBe(true);
      expect(findOpenQuestion(f.db, "session")).toBeNull();
      const store = createInboxStore(f.db);
      store.commit({
        ...event(),
        source: "poll",
        action: "prompted",
        dedupeKey: "activity:agent-progress",
        activityId: "agent-progress",
        actorId: "app",
        body,
        payload: JSON.stringify({ actorId: "app", activityCreatedAtMs: Date.now() }),
      });
      let reply: PolledActivity | undefined;
      poller = startCatchUpPoller({
        store,
        source: {
          async poll() {
            return {
              sessions: [],
              issues: [],
              comments: [],
              activities: reply ? [reply] : [],
              budget: null,
              queried: true,
              caughtUp: true,
            };
          },
        },
        onEvent: (incoming) => f.orchestrator.onLinearEvent(incoming),
        sleeper: { wait: () => sleeping.promise, wake: () => sleeping.resolve() },
      });
      await waitFor(() => store.listUnhandled().length === 0);
      expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM linear_turn").get()?.n).toBe(
        0,
      );
      release.resolve();
      await waitFor(() => findOpenQuestion(f.db, "session") !== null);
      const question = findOpenQuestion(f.db, "session")!;
      expect(getWorkItem(f.db, itemId)?.state).toBe("awaiting_input");
      steps.length = 0;
      const answeredAt = Math.max(Date.now(), question.createdAt + 1);
      reply = {
        id: "human-answer",
        sessionId: "session",
        issueId: "parent",
        actorId: "human",
        activityCreatedAtMs: answeredAt,
        updatedAtMs: answeredAt,
        signal: null,
        body: "Capture a fresh demo-dashboard.png",
      };
      const answering = poller.pollNow();
      let answered = false;
      void answering.then(() => {
        answered = true;
      });
      await waitFor(() => answered);
      await answering;
      await running;
      expect(getQuestion(f.db, question.id)?.answer).toBe(reply.body);
      expect(store.listUnhandled()).toHaveLength(0);
      await f.jobs.tick();
      expect(getWorkItem(f.db, itemId)?.state).toBe("completed");
      expect(f.tracker.progress.filter((update) => update.kind === "response")).toHaveLength(1);
      expect(f.launches).toEqual(["classify", "answer", "classify", "answer"]);
    } finally {
      release.resolve();
      await f.orchestrator.shutdown();
      await running;
      await poller?.stop();
      f.db.close();
    }
  },
  15_000,
);

test("clarified parent code requests recover the ordered child queue and every child's guidance", async () => {
  const databasePath = join(tempHome(), "clarification.db");
  const db = openDatabase(databasePath);
  migrate(db);
  const f = setup("clarify", "What should change?", false, "ok", "code", db);
  let reopened: Database | undefined;
  try {
    const parent = f.tracker.epics.get("parent")!;
    f.tracker.epics.set("parent", {
      ...parent,
      subIssues: [
        ...parent.subIssues,
        {
          linearIssueId: "second-child",
          identifier: "ENG-3",
          title: "Build the dependent feature",
        },
      ],
    });
    f.tracker.deps.set("parent", [
      { blockerLinearIssueId: "child", blockedLinearIssueId: "second-child" },
    ]);
    await f.orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const previous = getWorkItem(db, getLinearSession(db, "session")!.activeItemId!)!;
    const answer = "Implement both child issues with the corrected chart layout.";
    await f.orchestrator.onLinearEvent({
      ...event(),
      action: "prompted",
      dedupeKey: "clarification-answer",
      activityId: "clarification-answer",
      body: answer,
    });
    await f.jobs.tick();
    const session = getLinearSession(db, "session")!;
    expect(session.epicId).not.toBe(previous.epicId);
    expect(getWorkItem(db, previous.id)?.state).toBe("cancelled");
    expect(f.launches).toEqual(["classify", "classify"]);
    const children = db
      .query<{ id: string; linear_issue_id: string; state: string }, [string]>(
        "SELECT id,linear_issue_id,state FROM work_item WHERE epic_id = ? ORDER BY position",
      )
      .all(session.epicId!);
    expect(children.map((child) => child.linear_issue_id)).toEqual(["child", "second-child"]);
    expect(
      children.every((child) => child.state === "queued" && getTaskMode(db, child.id) === "code"),
    ).toBe(true);
    expect(f.tracker.progress.filter((update) => update.kind === "response")).toEqual([]);
    const originalKey = db
      .query<{ task_key: string }, [string]>("SELECT task_key FROM epic WHERE id = ?")
      .get(previous.epicId)!.task_key;
    const resolved = getTaskClassification(db, originalKey)!;
    expect(resolved.mode).toBe("code");
    if (resolved.mode === "clarify") throw new Error("Clarification was not resolved");
    expect(getTaskClassification(db, resolved.redirect!.taskKey)).toMatchObject({
      mode: "code",
      context: expect.stringContaining(answer),
    });
    db.close();
    reopened = openDatabase(databasePath);
    migrate(reopened);
    const recovery = attachOrchestrator({
      db: reopened,
      jobs: new JobLoop(reopened, systemClock),
      outbox: new OutboxDispatcher(reopened, systemClock),
      pawsRoot: f.root,
      home: f.home,
      tracker: f.tracker,
      launch: f.launch,
      linearTaskModes: true,
    });
    await recovery.intakeLinearTask("parent", "session", originalKey);
    await recovery.onLinearEvent(event());
    expect(getLinearSession(reopened, "session")!.epicId).toBe(session.epicId);
    expect(reopened.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()!.n).toBe(
      3,
    );
    expect(f.launches).toEqual(["classify", "classify"]);
  } finally {
    (reopened ?? db).close();
  }
});

test("clarifying a parent discussion as an answer keeps its children undispatched", async () => {
  const f = setup("clarify", "What should I explain?", false, "ok", "answer");
  try {
    await f.orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const answeredAt = Math.max(Date.now(), findOpenQuestion(f.db, "session")!.createdAt + 1);
    await f.orchestrator.onLinearEvent({
      ...event(),
      action: "prompted",
      dedupeKey: "answer",
      activityId: "answer",
      activityCreatedAtMs: answeredAt,
      updatedAtMs: answeredAt,
      body: "Explain the parent architecture.",
    });
    await f.jobs.tick();
    expect(f.launches).toEqual(["classify", "classify", "answer"]);
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()!.n).toBe(1);
    expect(getWorkItem(f.db, getLinearSession(f.db, "session")!.activeItemId!)?.state).toBe(
      "completed",
    );
    expect(f.tracker.statuses).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("Stop cancels and joins classification before any task can be created", async () => {
  const f = setup("answer", "unused", true);
  try {
    const started = f.orchestrator.onLinearEvent(event()).then(
      () => null,
      (error: unknown) => error,
    );
    for (let i = 0; i < 1_000 && f.launches.length === 0; i++) await Bun.sleep(1);
    expect(f.launches).toEqual(["classify"]);
    await f.orchestrator.onLinearEvent({
      ...event(),
      dedupeKey: "activity:stop",
      action: "prompted",
      signal: "stop",
    });
    expect(await started).toBeNull();
    expect(getLinearSession(f.db, "session")?.stoppedAt).not.toBeNull();
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(0);
    expect(f.tracker.progress.filter((update) => update.kind === "response")).toMatchObject([
      { body: "Stopped from Linear." },
    ]);
    await f.orchestrator.onLinearEvent({
      ...event(),
      dedupeKey: "activity:stop",
      action: "prompted",
      signal: "stop",
    });
    expect(f.tracker.progress.filter((update) => update.kind === "response")).toHaveLength(1);
    expect(f.launches).toEqual(["classify"]);
    expect(existsSync(join(f.root, "worktrees"))).toBe(false);
  } finally {
    f.db.close();
  }
}, 15_000);

test.each(["ok", "fail", "omit"] as const)(
  "artifact-only outcome requires a successful upload: %s",
  async (upload) => {
    const f = setup("artifact", "unused", false, upload);
    try {
      await f.orchestrator.onLinearEvent(event());
      const session = getLinearSession(f.db, "session")!;
      const itemId = session.activeItemId!;
      expect(getTaskMode(f.db, itemId)).toBe("artifact");
      await f.jobs.tick();
      expect(f.launches).toEqual(["classify", "artifact"]);
      expect(f.tracker.statuses).toEqual([]);
      expect(existsSync(join(f.root, "worktrees"))).toBe(false);
      const responses = f.tracker.progress.filter((update) => update.kind === "response");
      if (upload === "ok") {
        expect(f.uploads()).toBe(1);
        expect(getWorkItem(f.db, itemId)?.state).toBe("completed");
        expect(listArtifacts(f.db, itemId)[0]?.state).toBe("uploaded");
        expect(responses).toHaveLength(1);
        expect(responses[0]?.body).toContain(f.answer.trim());
        expect(responses[0]?.body).toContain(
          "https://uploads.linear.app/workspace/deliverable.txt",
        );
        const fileIndex = f.tracker.progress.findIndex((update) =>
          update.body.includes("[deliverable.txt]"),
        );
        expect(fileIndex).toBeGreaterThanOrEqual(0);
        expect(fileIndex).toBeLessThan(
          f.tracker.progress.findIndex((update) => update.kind === "response"),
        );
      } else {
        expect(getWorkItem(f.db, itemId)?.state).toBe("failed");
        expect(responses).toHaveLength(0);
      }
    } finally {
      f.db.close();
    }
  },
);

test.each(["answer", "artifact"] as const)(
  "%s work materializes private input files before ACP without Git provisioning",
  async (mode) => {
    const f = setup(mode);
    try {
      const incoming = event();
      incoming.payload = JSON.stringify({
        agentSession: { creatorId: "human" },
        promptContext:
          "Use [reference](https://uploads.linear.app/workspace/reference.txt?signature=private)",
      });
      await f.orchestrator.onLinearEvent(incoming);
      const session = getLinearSession(f.db, "session")!;
      await f.jobs.tick();
      expect(getWorkItem(f.db, session.activeItemId!)?.state).toBe("completed");
      expect(f.downloads()).toBe(1);
      const trace = JSON.parse(readFileSync(f.traces.at(-1)!, "utf8"));
      const prompt = JSON.stringify(trace.prompts);
      expect(prompt).toContain(".paws-linear-inputs");
      expect(prompt).not.toContain("signature=private");
      expect(existsSync(join(f.root, "mirrors"))).toBe(false);
      expect(existsSync(join(f.root, "worktrees"))).toBe(false);
      const inputs = f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM linear_input").get();
      expect(inputs?.n).toBe(1);
      expect(f.tracker.statuses).toEqual([]);
    } finally {
      f.db.close();
    }
  },
);

test("Stop during dependency loading cannot commit or queue the classified task", async () => {
  const f = setup("answer");
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<[]>();
  f.tracker.listDeps = async () => {
    ready.resolve();
    return release.promise;
  };
  try {
    const intake = f.orchestrator.onLinearEvent(event());
    await ready.promise;
    await f.orchestrator.onLinearEvent({
      ...event(),
      dedupeKey: "stop-during-intake",
      action: "prompted",
      signal: "stop",
    });
    release.resolve([]);
    await intake;
    expect(getLinearSession(f.db, "session")?.stoppedAt).not.toBeNull();
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(0);
    expect(f.launches).toEqual(["classify"]);
    expect(f.tracker.progress.some((update) => update.kind === "error")).toBe(false);
  } finally {
    release.resolve([]);
    f.db.close();
  }
});

test("Stop during the intake announcement cancels the already associated task", async () => {
  const f = setup("answer");
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const post = f.tracker.postProgress.bind(f.tracker);
  f.tracker.postProgress = async (update, options) => {
    if (update.kind === "thought" && update.body === "Picked up ENG-1.") {
      ready.resolve();
      await release.promise;
    }
    return post(update, options);
  };
  try {
    const intake = f.orchestrator.onLinearEvent(event());
    await ready.promise;
    const itemId = getLinearSession(f.db, "session")?.activeItemId;
    expect(itemId).toBeString();
    const stopping = f.orchestrator.onLinearEvent({
      ...event(),
      dedupeKey: "stop-during-announcement",
      action: "prompted",
      signal: "stop",
    });
    for (let i = 0; i < 100 && getWorkItem(f.db, itemId!)?.state !== "cancelled"; i++)
      await Bun.sleep(1);
    expect(getWorkItem(f.db, itemId!)?.state).toBe("cancelled");
    release.resolve();
    await stopping;
    await intake;
    expect(f.launches).toEqual(["classify"]);
    expect(f.tracker.progress.some((update) => update.kind === "error")).toBe(false);
  } finally {
    release.resolve();
    f.db.close();
  }
});

test.each(["answer", "artifact"] as const)(
  "%s runtime publishes ACP plans and durable completion metadata",
  async (mode) => {
    const f = setup(mode, "unused", false, "ok", undefined, undefined, true);
    try {
      await f.orchestrator.onLinearEvent(event());
      await f.jobs.tick();
      expect(f.tracker.sessionUpdates.findLast((update) => update.plan)?.plan).toEqual([
        { content: "Read the reference", status: "completed" },
        { content: "Prepare the requested result", status: "completed" },
      ]);
      expect(f.tracker.sessionUpdates.findLast((update) => update.summary)?.summary).toBe(
        "ENG-1: completed",
      );
      expect(
        f.tracker.sessionUpdates
          .flatMap((update) => update.plan ?? [])
          .some((step) => /pull request|Merge|Verify changes/.test(step.content)),
      ).toBe(false);
      expect(
        f.tracker.sessionUpdates.every(
          (update) => !("mode" in update) && !("identifier" in update),
        ),
      ).toBe(true);
      expect(getWorkItem(f.db, getLinearSession(f.db, "session")!.activeItemId!)?.state).toBe(
        "completed",
      );
    } finally {
      f.db.close();
    }
  },
);

test("Stop fences pending answer plans and prevents completed session metadata", async () => {
  const f = setup("answer", "unused", false, "ok", undefined, undefined, true, true);
  try {
    await f.orchestrator.onLinearEvent(event());
    const running = f.jobs.tick();
    for (
      let i = 0;
      i < 1000 &&
      !listOutbox(f.db, "session").some((row) =>
        JSON.stringify(row.payload).includes("Read the reference"),
      );
      i++
    )
      await Bun.sleep(1);
    expect(
      listOutbox(f.db, "session").some((row) =>
        JSON.stringify(row.payload).includes("Read the reference"),
      ),
    ).toBe(true);
    await f.orchestrator.onLinearEvent({
      ...event(),
      dedupeKey: "stop-answer-plan",
      action: "prompted",
      signal: "stop",
    });
    await running;
    expect(
      listOutbox(f.db, "session")
        .filter((row) => row.op.startsWith("linear.session."))
        .every((row) => row.status === "dropped"),
    ).toBe(true);
    expect(f.tracker.sessionUpdates.some((update) => update.summary === "ENG-1: completed")).toBe(
      false,
    );
    expect(getWorkItem(f.db, getLinearSession(f.db, "session")!.activeItemId!)?.state).toBe(
      "cancelled",
    );
  } finally {
    f.db.close();
  }
}, 15000);

test.each(["answer", "artifact"] as const)(
  "%s ACP tool details reach Linear with transient starts and durable results",
  async (mode) => {
    const f = setup(mode, undefined, false, "ok", undefined, undefined, false, false, [
      {
        sessionUpdate: "tool_call",
        toolCallId: "private-tool-identifier",
        kind: "execute",
        title: "Check the requested output",
        status: "in_progress",
        rawInput: { command: "bun test output.test.ts", token: "must-not-be-published" },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "private-tool-identifier",
        status: "completed",
        rawOutput: { stdout: "Output verified", exitCode: 0 },
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Private reasoning must not reach Linear" },
      },
    ]);
    const delivery = setInterval(() => f.outbox.tick(), 1);
    try {
      await f.orchestrator.onLinearEvent(event());
      await f.jobs.tick();
      await f.outbox.idle();
      const actions = f.tracker.progress.filter(
        (update) => update.action?.action === "Check the requested output",
      );
      expect(actions).toHaveLength(2);
      expect(actions[0]?.ephemeral).toBe(true);
      expect(actions[0]?.action?.parameter).toContain("bun test output.test.ts");
      expect(actions[1]?.action?.parameter).toBe(actions[0]?.action?.parameter);
      expect(actions[1]?.action?.result).toContain("Output verified");
      expect(actions[1]?.ephemeral).not.toBe(true);
      expect(JSON.stringify(f.tracker.progress)).not.toContain("must-not-be-published");
      expect(JSON.stringify(f.tracker.progress)).not.toContain("Private reasoning");
      expect(
        f.tracker.progress
          .filter((update) => update.kind === "response")
          .every((update) => !update.ephemeral),
      ).toBe(true);
      expect(f.tracker.progress.findLast((update) => update.kind === "response")?.body).toContain(
        f.answer.trim(),
      );
    } finally {
      clearInterval(delivery);
      await f.outbox.idle();
      f.db.close();
    }
  },
);
