import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { expect, test } from "bun:test";
import { asc, count, eq, sql } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parentTaskKeySql, systemClock } from "../src/core";
import type { FakeStep } from "../src/acp/testing/script";
import {
  getLinearSession,
  getTaskClassification,
  getTaskMode,
  getWorkItem,
  listArtifacts,
  openPawsStore,
  listOutbox,
  JobLoop,
  OutboxDispatcher,
  type Db,
} from "../src/db";
import {
  createFakeTracker,
  createLinearFileTransfer,
  createLinearTracker,
  createInboxStore,
  startCatchUpPoller,
  type AcceptedLinearEvent,
  type PolledActivity,
} from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { elicitationBody, findOpenQuestion, getQuestion } from "../src/questions";
import { answerPg as answerAsked } from "./questions";
import { seed } from "./dialects";
import { workspaceAdmission } from "./fake-workspace";
import { tempHome } from "./helpers";
import { copyMigratedPglite, tempStore } from "./pglite";

const countRows = async (db: Db, table: "workItem" | "linearTurn") =>
  (await db.run((q) => q.one(q.orm.select({ n: count() }).from(q.t[table]))))!.n;

async function persistedStore(dir: string): Promise<{ db: Db; close(): Promise<void> }> {
  const opened = await openPawsStore({ url: null, pgliteDir: dir });
  return { db: opened.store, close: () => opened.close() };
}

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

async function setup(
  mode: "answer" | "code" | "clarify" | "artifact",
  question = "What outcome do you want?",
  hang = false,
  artifactUpload: "ok" | "fail" | "omit" = "ok",
  resolvedMode?: "answer" | "code" | "artifact",
  database?: Db,
  plan = false,
  hangResponse = false,
  toolUpdates: readonly SessionUpdate[] = [],
  responseSteps: readonly FakeStep[] = [],
) {
  const opened = database === undefined ? await tempStore() : null;
  const db = database ?? opened!.db;
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
    store: db,
    admission: workspaceAdmission(db),
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
    close: async () => {
      await orchestrator.shutdown();
      await opened?.close();
    },
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
  const f = await setup("answer");
  try {
    await f.orchestrator.onLinearEvent(event());
    const session = (await getLinearSession(f.db, "session"))!;
    const item = (await getWorkItem(f.db, session.activeItemId!))!;
    expect(item.linearIssueId).toBe("parent");
    expect(await countRows(f.db, "workItem")).toBe(1);
    expect(await getTaskMode(f.db, item.id)).toBe("answer");
    expect(f.launches).toEqual(["classify"]);
    await f.jobs.tick();
    expect((await getWorkItem(f.db, item.id))?.state).toBe("completed");
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
    expect((await getWorkItem(f.db, item.id))?.checkpoint?.wipCommit).toBeUndefined();
    await f.orchestrator.onLinearEvent(event());
    expect(f.launches).toEqual(["classify", "answer"]);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("completed");
    expect(await countRows(f.db, "workItem")).toBe(1);
  } finally {
    await f.close();
  }
});

test("code classification persists before child work is dispatched", async () => {
  const f = await setup("code");
  try {
    await f.orchestrator.onLinearEvent(event());
    const session = (await getLinearSession(f.db, "session"))!;
    const item = (await getWorkItem(f.db, session.activeItemId!))!;
    expect(item.linearIssueId).toBe("child");
    expect(await getTaskMode(f.db, item.id)).toBe("code");
    expect(f.launches).toEqual(["classify"]);
    expect(f.tracker.statuses).toEqual([]);
    expect(existsSync(join(f.root, "worktrees"))).toBe(false);
  } finally {
    await f.close();
  }
});

test("ambiguous outcomes ask for clarification before repository access", async () => {
  const f = await setup("clarify", "Explain it, create a file, or change the code?");
  try {
    await f.orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const session = (await getLinearSession(f.db, "session"))!;
    expect((await getWorkItem(f.db, session.activeItemId!))?.state).toBe("awaiting_input");
    expect(f.tracker.questions[0]?.body).toBe(
      elicitationBody("Explain it, create a file, or change the code?"),
    );
    expect(f.tracker.statuses).toEqual([]);
    expect(f.launches).toEqual(["classify"]);
    expect(existsSync(join(f.root, "worktrees"))).toBe(false);
  } finally {
    await f.close();
  }
});

const waitOnAnotherQuestion = (db: Db) =>
  seed(db, (q) =>
    q.orm.insert(q.t.question).values({
      id: "waiting",
      itemId: "other",
      sessionId: "session",
      kind: "runner-wait",
      body: "Move or keep waiting?",
      status: "open",
      createdAt: 1,
    }),
  );

const questionOf = async (db: Db, itemId: string) => {
  const row = await db.run((q) =>
    q.one(
      q.orm
        .select({ id: q.t.question.id })
        .from(q.t.question)
        .where(eq(q.t.question.itemId, itemId)),
    ),
  );
  return (await getQuestion(db, row!.id))!;
};

test("a clarification asked while the session waits on another question queues behind it", async () => {
  const f = await setup("clarify", "Explain it, create a file, or change the code?");
  try {
    waitOnAnotherQuestion(f.db);
    await f.orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const itemId = (await getLinearSession(f.db, "session"))!.activeItemId!;
    expect((await getWorkItem(f.db, itemId))?.state).toBe("awaiting_input");
    expect(await questionOf(f.db, itemId)).toMatchObject({
      kind: "clarification",
      status: "queued",
    });
    expect(f.tracker.questions).toEqual([]);
    await answerAsked(f.db, {
      sessionId: "session",
      deliveryId: "keep-waiting",
      body: "Keep waiting",
      answeredBy: "human",
    });
    expect((await questionOf(f.db, itemId)).status).toBe("open");
    const asked = await questionOf(f.db, itemId);
    expect(
      (await listOutbox(f.db)).filter(
        (row) => row.op === "elicitation" && row.idempotencyKey.endsWith(asked.id),
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("ask_team while the session waits on another question queues the agent's question", async () => {
  const f = await setup(
    "answer",
    undefined,
    false,
    "ok",
    undefined,
    undefined,
    false,
    false,
    [],
    [{ type: "ask_team", question: "Which screenshot?" }],
  );
  try {
    waitOnAnotherQuestion(f.db);
    await f.orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const itemId = (await getLinearSession(f.db, "session"))!.activeItemId!;
    expect((await getWorkItem(f.db, itemId))?.state).toBe("awaiting_input");
    expect(await questionOf(f.db, itemId)).toMatchObject({
      kind: "agent",
      status: "queued",
      body: "Which screenshot?",
    });
    expect(f.tracker.questions).toEqual([]);
  } finally {
    await f.orchestrator.shutdown();
    await f.close();
  }
});

test.each([null, "", " \n "])(
  "a polled activity with body %j cannot block a later question reply",
  async (body) => {
    const steps: FakeStep[] = [{ type: "ask_team", question: "Which screenshot?" }];
    const f = await setup(
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
    const waitFor = async (condition: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !(await condition())) await Bun.sleep(5);
      expect(await condition()).toBe(true);
    };
    try {
      await f.orchestrator.onLinearEvent(event());
      const itemId = (await getLinearSession(f.db, "session"))!.activeItemId!;
      f.tracker.listSessionActivities = async () => {
        ready.resolve();
        await release.promise;
        return [];
      };
      running = f.jobs.tick();
      await ready.promise;
      expect(f.orchestrator.agentAlive((await getWorkItem(f.db, itemId))!.currentRunId!)).toBe(
        true,
      );
      expect(await findOpenQuestion(f.db, "session")).toBeNull();
      const store = createInboxStore(f.db);
      await store.commit({
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
      await waitFor(async () => (await store.listUnhandled()).length === 0);
      expect(await countRows(f.db, "linearTurn")).toBe(0);
      release.resolve();
      await waitFor(async () => (await findOpenQuestion(f.db, "session")) !== null);
      const question = (await findOpenQuestion(f.db, "session"))!;
      expect((await getWorkItem(f.db, itemId))?.state).toBe("awaiting_input");
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
      expect((await getQuestion(f.db, question.id))?.answer).toBe(reply.body);
      expect(await store.listUnhandled()).toHaveLength(0);
      await f.jobs.tick();
      expect((await getWorkItem(f.db, itemId))?.state).toBe("completed");
      expect(f.tracker.progress.filter((update) => update.kind === "response")).toHaveLength(1);
      expect(f.launches).toEqual(["classify", "answer", "classify", "answer"]);
    } finally {
      release.resolve();
      await f.orchestrator.shutdown();
      await running;
      await poller?.stop();
      await f.close();
    }
  },
  15_000,
);

test("clarified parent code requests recover the ordered child queue and every child's guidance", async () => {
  const databasePath = join(tempHome(), "clarification");
  await copyMigratedPglite(databasePath);
  const first = await persistedStore(databasePath);
  const db = first.db;
  const f = await setup("clarify", "What should change?", false, "ok", "code", db);
  let reopened: { db: Db; close(): Promise<void> } | undefined;
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
    const previous = (await getWorkItem(
      db,
      (await getLinearSession(db, "session"))!.activeItemId!,
    ))!;
    const answer = "Implement both child issues with the corrected chart layout.";
    await f.orchestrator.onLinearEvent({
      ...event(),
      action: "prompted",
      dedupeKey: "clarification-answer",
      activityId: "clarification-answer",
      body: answer,
    });
    await f.jobs.tick();
    const session = (await getLinearSession(db, "session"))!;
    expect(session.delegationId).not.toBe(previous.delegationId);
    expect((await getWorkItem(db, previous.id))?.state).toBe("cancelled");
    expect(f.launches).toEqual(["classify", "classify"]);
    const children = await db.run((q) =>
      q.all(
        q.orm
          .select({
            id: q.t.workItem.id,
            linear_issue_id: q.t.workItem.linearIssueId,
            state: q.t.workItem.state,
          })
          .from(q.t.workItem)
          .where(eq(q.t.workItem.delegationId, session.delegationId!))
          .orderBy(asc(q.t.workItem.position)),
      ),
    );
    expect(children.map((child) => child.linear_issue_id)).toEqual(["child", "second-child"]);
    const modes = [];
    for (const child of children) modes.push(await getTaskMode(db, child.id));
    expect(children.every((child) => child.state === "queued")).toBe(true);
    expect(modes.every((mode) => mode === "code")).toBe(true);
    expect(f.tracker.progress.filter((update) => update.kind === "response")).toEqual([]);
    const originalKey = (await db.run((q) =>
      q.one(
        q.orm
          .select({ taskKey: sql<string>`${sql.raw(parentTaskKeySql("work_item", "postgres"))}` })
          .from(q.t.workItem)
          .where(eq(q.t.workItem.delegationId, previous.delegationId))
          .orderBy(asc(q.t.workItem.position), asc(q.t.workItem.id))
          .limit(1),
      ),
    ))!.taskKey;
    const resolved = (await getTaskClassification(db, originalKey))!;
    expect(resolved.mode).toBe("code");
    if (resolved.mode === "clarify") throw new Error("Clarification was not resolved");
    expect(await getTaskClassification(db, resolved.redirect!.taskKey)).toMatchObject({
      mode: "code",
      context: expect.stringContaining(answer),
    });
    await f.close();
    await first.close();
    reopened = await persistedStore(databasePath);
    const store = reopened.db;
    const recovery = attachOrchestrator({
      store,
      admission: workspaceAdmission(store),
      jobs: new JobLoop(store, systemClock),
      outbox: new OutboxDispatcher(store, systemClock),
      pawsRoot: f.root,
      home: f.home,
      tracker: f.tracker,
      launch: f.launch,
      linearTaskModes: true,
    });
    await recovery.intakeLinearTask("parent", "session", originalKey);
    await recovery.onLinearEvent(event());
    expect((await getLinearSession(store, "session"))!.delegationId).toBe(session.delegationId);
    expect(await countRows(store, "workItem")).toBe(3);
    await recovery.shutdown();
    expect(f.launches).toEqual(["classify", "classify"]);
  } finally {
    await (reopened ?? first).close();
  }
});

test("clarifying a parent discussion as an answer keeps its children undispatched", async () => {
  const f = await setup("clarify", "What should I explain?", false, "ok", "answer");
  try {
    await f.orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const answeredAt = Math.max(
      Date.now(),
      (await findOpenQuestion(f.db, "session"))!.createdAt + 1,
    );
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
    expect(await countRows(f.db, "workItem")).toBe(1);
    expect(
      (await getWorkItem(f.db, (await getLinearSession(f.db, "session"))!.activeItemId!))?.state,
    ).toBe("completed");
    expect(f.tracker.statuses).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a question reply resumes through history containing an action with an empty parameter", async () => {
  const f = await setup("clarify", "Which screenshot?", false, "ok", "artifact");
  try {
    await f.orchestrator.onLinearEvent(event());
    await f.jobs.tick();
    const question = (await findOpenQuestion(f.db, "session"))!;
    const answeredAt = Math.max(Date.now(), question.createdAt + 1);
    f.tracker.listSessionActivities = createLinearTracker({
      async query() {
        return {
          agentSession: {
            id: "session",
            activities: {
              nodes: [
                {
                  id: "read-action",
                  createdAt: new Date(question.createdAt).toISOString(),
                  updatedAt: new Date(question.createdAt).toISOString(),
                  user: { id: "app" },
                  content: {
                    type: "action",
                    action: "Read",
                    parameter: "",
                    result: "Read the reference",
                  },
                  ephemeral: false,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      },
    }).listSessionActivities;
    await f.orchestrator.onLinearEvent({
      ...event(),
      action: "prompted",
      dedupeKey: "screenshot-answer",
      activityId: "screenshot-answer",
      activityCreatedAtMs: answeredAt,
      updatedAtMs: answeredAt,
      body: "Capture a fresh screenshot of an empty instance.",
    });
    expect((await getQuestion(f.db, question.id))?.answer).toBe(
      "Capture a fresh screenshot of an empty instance.",
    );
    await f.jobs.tick();
    const itemId = (await getLinearSession(f.db, "session"))!.activeItemId!;
    expect((await getWorkItem(f.db, itemId))?.state).toBe("completed");
    expect(f.launches).toEqual(["classify", "classify", "artifact"]);
    expect(f.uploads()).toBe(1);
    expect(f.tracker.progress.filter((update) => update.kind === "response")).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(readFileSync(f.traces.at(-1)!, "utf8")).prompts)).toContain(
      "Read the reference",
    );
  } finally {
    await f.orchestrator.shutdown();
    await f.close();
  }
});

test("Stop cancels and joins classification before any task can be created", async () => {
  const f = await setup("answer", "unused", true);
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
    expect((await getLinearSession(f.db, "session"))?.stoppedAt).not.toBeNull();
    expect(await countRows(f.db, "workItem")).toBe(0);
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
    await f.close();
  }
}, 15_000);

test.each(["ok", "fail", "omit"] as const)(
  "artifact-only outcome requires a successful upload: %s",
  async (upload) => {
    const f = await setup("artifact", "unused", false, upload);
    try {
      await f.orchestrator.onLinearEvent(event());
      const session = (await getLinearSession(f.db, "session"))!;
      const itemId = session.activeItemId!;
      expect(await getTaskMode(f.db, itemId)).toBe("artifact");
      await f.jobs.tick();
      expect(f.launches).toEqual(["classify", "artifact"]);
      expect(f.tracker.statuses).toEqual(
        upload === "ok" ? [{ linearIssueId: "parent", stateType: "completed" }] : [],
      );
      expect(existsSync(join(f.root, "worktrees"))).toBe(false);
      const responses = f.tracker.progress.filter((update) => update.kind === "response");
      if (upload === "ok") {
        expect(f.uploads()).toBe(1);
        expect((await getWorkItem(f.db, itemId))?.state).toBe("completed");
        expect((await listArtifacts(f.db, itemId))[0]?.state).toBe("uploaded");
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
        expect((await getWorkItem(f.db, itemId))?.state).toBe("failed");
        expect(responses).toHaveLength(0);
      }
    } finally {
      await f.close();
    }
  },
);

test.each(["answer", "artifact"] as const)(
  "%s work materializes private input files before ACP without Git provisioning",
  async (mode) => {
    const f = await setup(mode);
    try {
      const incoming = event();
      incoming.payload = JSON.stringify({
        agentSession: { creatorId: "human" },
        promptContext:
          "Use [reference](https://uploads.linear.app/workspace/reference.txt?signature=private)",
        previousComments: [
          {
            id: "earlier-comment",
            body: "Earlier [reference](https://uploads.linear.app/workspace/history.txt?signature=old)",
          },
        ],
      });
      await f.orchestrator.onLinearEvent(incoming);
      const session = (await getLinearSession(f.db, "session"))!;
      await f.jobs.tick();
      expect((await getWorkItem(f.db, session.activeItemId!))?.state).toBe("completed");
      expect(f.downloads()).toBe(2);
      const trace = JSON.parse(readFileSync(f.traces.at(-1)!, "utf8"));
      const prompt = JSON.stringify(trace.prompts);
      expect(prompt).toContain(".paws-linear-inputs");
      expect(prompt).not.toContain("signature=private");
      expect(prompt).not.toContain("signature=old");
      expect(existsSync(join(f.root, "mirrors"))).toBe(false);
      expect(existsSync(join(f.root, "worktrees"))).toBe(false);
      const inputs = await f.db.run((q) =>
        q.all(
          q.orm
            .select({
              asset: q.t.linearInput.assetId,
              url: q.t.linearInput.assetUrl,
              turn: q.t.linearInput.turnId,
              session: q.t.linearInput.sessionId,
            })
            .from(q.t.linearInput)
            .orderBy(asc(q.t.linearInput.assetUrl)),
        ),
      );
      expect(inputs.map((input) => input.url)).toEqual([
        "https://uploads.linear.app/workspace/history.txt",
        "https://uploads.linear.app/workspace/reference.txt",
      ]);
      expect(new Set(inputs.map((input) => input.turn)).size).toBe(1);
      for (const input of inputs) {
        expect(input.session).toBe("session");
        expect(prompt).toContain(input.asset);
      }
      // An answer does not finish the issue; a delivered artifact does.
      expect(f.tracker.statuses).toEqual(
        mode === "artifact" ? [{ linearIssueId: "parent", stateType: "completed" }] : [],
      );
    } finally {
      await f.close();
    }
  },
);

test("Stop during dependency loading cannot commit or queue the classified task", async () => {
  const f = await setup("answer");
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
    expect((await getLinearSession(f.db, "session"))?.stoppedAt).not.toBeNull();
    expect(await countRows(f.db, "workItem")).toBe(0);
    expect(f.launches).toEqual(["classify"]);
    expect(f.tracker.progress.some((update) => update.kind === "error")).toBe(false);
  } finally {
    release.resolve([]);
    await f.close();
  }
});

test("a lone issue's intake adds no announcement to the first activity", async () => {
  const f = await setup("answer");
  try {
    await f.orchestrator.onLinearEvent(event());
    expect((await getLinearSession(f.db, "session"))?.activeItemId).toBeString();
    expect(f.tracker.progress).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(["answer", "artifact"] as const)(
  "%s runtime publishes ACP plans and durable completion metadata",
  async (mode) => {
    const f = await setup(mode, "unused", false, "ok", undefined, undefined, true);
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
      expect(
        (await getWorkItem(f.db, (await getLinearSession(f.db, "session"))!.activeItemId!))?.state,
      ).toBe("completed");
    } finally {
      await f.close();
    }
  },
);

test("Stop fences pending answer plans and prevents completed session metadata", async () => {
  const f = await setup("answer", "unused", false, "ok", undefined, undefined, true, true);
  try {
    await f.orchestrator.onLinearEvent(event());
    const running = f.jobs.tick();
    for (
      let i = 0;
      i < 1000 &&
      !(await listOutbox(f.db, "session")).some((row) =>
        JSON.stringify(row.payload).includes("Read the reference"),
      );
      i++
    )
      await Bun.sleep(1);
    expect(
      (await listOutbox(f.db, "session")).some((row) =>
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
    const metadata = (await listOutbox(f.db, "session")).filter((row) =>
      row.op.startsWith("linear.session."),
    );
    expect(
      metadata.filter((row) => row.delivery !== "stop").every((row) => row.status === "dropped"),
    ).toBe(true);
    expect(metadata.filter((row) => row.delivery === "stop")).toEqual([]);
    expect(f.tracker.sessionUpdates.some((update) => update.summary === "ENG-1: completed")).toBe(
      false,
    );
    expect(
      (await getWorkItem(f.db, (await getLinearSession(f.db, "session"))!.activeItemId!))?.state,
    ).toBe("paused");
  } finally {
    await f.close();
  }
}, 15000);

test.each([
  ["answer", "raw"],
  ["artifact", "raw"],
  ["answer", "terminal_output"],
  ["artifact", "terminal_output_delta"],
] as const)(
  "%s ACP %s tool details stay out of Linear while the answer still arrives",
  async (mode, format) => {
    const f = await setup(mode, undefined, false, "ok", undefined, undefined, false, false, [
      {
        sessionUpdate: "tool_call",
        toolCallId: "private-tool-identifier",
        kind: "execute",
        title: "Check the requested output",
        status: "in_progress",
        rawInput: { command: "bun test output.test.ts", token: "must-not-be-published" },
      },
      ...(format === "raw"
        ? []
        : [
            {
              sessionUpdate: "tool_call_update" as const,
              toolCallId: "private-tool-identifier",
              _meta: { [format]: { terminal_id: "terminal", data: "Output " } },
            },
            {
              sessionUpdate: "tool_call_update" as const,
              toolCallId: "private-tool-identifier",
              _meta: { [format]: { terminal_id: "terminal", data: "verified" } },
            },
          ]),
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "private-tool-identifier",
        status: "completed",
        ...(format === "raw" ? { rawOutput: { stdout: "Output verified", exitCode: 0 } } : {}),
      },
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Private reasoning must not reach Linear" },
      },
    ]);
    const delivery = setInterval(() => void f.outbox.tick(), 1);
    try {
      await f.orchestrator.onLinearEvent(event());
      await f.jobs.tick();
      await f.outbox.idle();
      const actions = f.tracker.progress.filter(
        (update) => update.action?.action === "Check the requested output",
      );
      expect(actions).toEqual([]);
      expect(JSON.stringify(f.tracker.progress)).not.toContain("Output verified");
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
      await f.close();
    }
  },
);
