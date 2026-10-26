import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  enqueueOutboxOnce,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOpenQuestions,
  listOutbox,
} from "../src/db";
import {
  createInboxStore,
  createIntakePollSource,
  createLinearClient,
  createFakeTracker,
  parseAgentEvent,
  startCatchUpPoller,
  type TrackerAdapter,
} from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import {
  answerQuestion,
  ask,
  findOpenQuestion,
  getQuestion,
  handoffNote,
  openQuestion,
} from "../src/questions";
import { tempDb } from "./helpers";

const NOW = 1_700_000_000_000;

test("question handoff preserves selection labels and their values for freeform interpretation", () => {
  const handoff = handoffNote({
    question: "Which repository?\n\nThe change needs shared types.",
    options: [{ label: "Shared library", value: "https://github.com/acme/shared" }],
    answer: "The library, please",
  });
  expect(handoff).toContain("The change needs shared types.");
  expect(handoff).toContain("Shared library");
  expect(handoff).toContain("https://github.com/acme/shared");
  expect(handoff).toContain("The library, please");
});

function setup(tracker: TrackerAdapter | null = null) {
  const db = tempDb();
  const item = insertQueuedItem(db, { id: "ENG-2", sessionKey: "ses_1", title: "Export rows" });
  beginImplementRun(db, item.id, NOW - 10);
  applyWorkItemEvent(db, item.id, "blocking_question");
  const question = openQuestion(db, {
    itemId: item.id,
    sessionId: "ses_1",
    body: "Include archived rows?",
    now: NOW,
  });
  const clock = new FakeClock(NOW + 1_000);
  const outbox = new OutboxDispatcher(db, clock);
  const orchestrator = attachOrchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox,
    pawsRoot: "/tmp/paws-question-lifecycle",
    tracker,
    clock,
  });
  return { db, item, question, orchestrator, outbox };
}

function prompt(createdAt = NOW + 1, id = "answer-1", userId: string | null = "human-1") {
  return parseAgentEvent(
    JSON.stringify({
      type: "AgentSessionEvent",
      action: "prompted",
      webhookTimestamp: NOW + 100,
      agentSession: { id: "ses_1", issue: { id: "iss_1" } },
      agentActivity: {
        id,
        createdAt: new Date(createdAt).toISOString(),
        userId,
        content: { type: "prompt", body: "Yes, include the archived rows" },
      },
    }),
    `delivery:${id}`,
    NOW + 100,
  )!;
}

test("Linear answers preserve their human author through persisted inbox replay", async () => {
  const { db, question, orchestrator } = setup();
  try {
    const inbox = createInboxStore(db);
    const event = prompt();
    expect(event.actorId).toBe("human-1");
    inbox.commit(event);
    const replayed = createInboxStore(db).listUnhandled()[0]!;
    expect(replayed.actorId).toBe("human-1");
    expect(replayed.activityCreatedAtMs).toBe(NOW + 1);
    await orchestrator.onLinearEvent(replayed);
    expect(getQuestion(db, question.id)?.answeredBy).toBe("human-1");
    expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(1);
    await orchestrator.onLinearEvent(replayed);
    expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(1);
  } finally {
    db.close();
  }
});

test.each([NOW - 1, NOW])(
  "an activity at %d cannot answer a question without later creation",
  async (at) => {
    const { db, question, orchestrator } = setup();
    try {
      await orchestrator.onLinearEvent(prompt(at));
      expect(getQuestion(db, question.id)?.status).toBe("open");
      expect(listJobs(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  },
);

test("an answer racing delivery suppresses the unsent elicitation", async () => {
  const { db, question, orchestrator } = setup();
  try {
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses_1",
      idempotencyKey: `ask:${question.id}`,
      payload: {
        sessionId: "ses_1",
        questionId: question.id,
        id: question.id,
        body: question.body,
      },
      now: NOW,
    });
    await orchestrator.onLinearEvent(prompt());
    expect(getQuestion(db, question.id)?.status).toBe("answered");
    expect(listOutbox(db)[0]?.status).toBe("dropped");
    expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("an answer aborts an elicitation currently being delivered", async () => {
  const tracker = createFakeTracker();
  let aborted = false;
  tracker.askQuestion = async (_question, options) =>
    new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("elicitation no longer needed"));
        },
        { once: true },
      );
    });
  const { db, question, orchestrator, outbox } = setup(tracker);
  try {
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses_1",
      idempotencyKey: `ask:${question.id}`,
      payload: {
        sessionId: "ses_1",
        questionId: question.id,
        id: question.id,
        body: question.body,
      },
      now: NOW,
    });
    outbox.tick();
    await orchestrator.onLinearEvent(prompt());
    expect(aborted).toBe(true);
    expect(getQuestion(db, question.id)?.status).toBe("answered");
    expect(listOutbox(db)[0]?.status).toBe("dropped");
  } finally {
    db.close();
  }
});

test("an activity ID alone does not establish a human respondent", async () => {
  const { db, question, orchestrator } = setup();
  try {
    await orchestrator.onLinearEvent(prompt(NOW + 1, "anonymous-activity", null));
    expect(getQuestion(db, question.id)?.status).toBe("open");
    expect(listJobs(db)).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("a webhook without an activity creation time cannot answer from delivery time", async () => {
  const { db, question, orchestrator } = setup();
  try {
    await orchestrator.onLinearEvent({ ...prompt(), activityCreatedAtMs: null });
    expect(getQuestion(db, question.id)?.status).toBe("open");
    expect(listJobs(db)).toHaveLength(0);
  } finally {
    db.close();
  }
});

test("a consumed activity cannot answer the next question in its session", async () => {
  const { db, item, question, orchestrator } = setup();
  try {
    const event = prompt(NOW + 100);
    await orchestrator.onLinearEvent(event);
    applyWorkItemEvent(db, item.id, "dispatched");
    applyWorkItemEvent(db, item.id, "blocking_question");
    const next = openQuestion(db, {
      itemId: item.id,
      sessionId: "ses_1",
      body: "Use CSV?",
      now: NOW + 50,
    });
    await orchestrator.onLinearEvent(event);
    expect(getQuestion(db, question.id)?.status).toBe("answered");
    expect(getQuestion(db, next.id)?.status).toBe("open");
  } finally {
    db.close();
  }
});

test("only one blocking question may be open on a session", () => {
  const { db, item, question } = setup();
  try {
    expect(() =>
      openQuestion(db, {
        itemId: item.id,
        sessionId: "ses_1",
        body: "Use CSV?",
        now: NOW + 1,
      }),
    ).toThrow("already has an unanswered question");
    expect(findOpenQuestion(db, "ses_1")?.id).toBe(question.id);
  } finally {
    db.close();
  }
});

test("a continuation write failure rolls back the answer and state transition", async () => {
  const { db, item, question, orchestrator } = setup();
  try {
    db.run(`CREATE TRIGGER reject_resume BEFORE INSERT ON job
      WHEN NEW.queue = 'run.resume' BEGIN SELECT RAISE(ABORT, 'resume unavailable'); END`);
    await expect(orchestrator.onLinearEvent(prompt())).rejects.toThrow("resume unavailable");
    expect(getQuestion(db, question.id)?.status).toBe("open");
    expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
    db.run("DROP TRIGGER reject_resume");
    await orchestrator.onLinearEvent(prompt());
    expect(getQuestion(db, question.id)?.status).toBe("answered");
  } finally {
    db.close();
  }
});

test("Stop cancels a persisted question even when no agent is alive", async () => {
  const { db, item, question, orchestrator } = setup();
  try {
    await orchestrator.onLinearEvent({ ...prompt(), body: null, signal: "stop" });
    expect(getWorkItem(db, item.id)?.state).toBe("cancelled");
    expect(getQuestion(db, question.id)?.status).toBe("cancelled");
    expect(findOpenQuestion(db, "ses_1")).toBeNull();
    expect(listOpenQuestions(db)).toHaveLength(0);
    await orchestrator.onLinearEvent(prompt());
    expect(getQuestion(db, question.id)?.answer).toBeNull();
  } finally {
    db.close();
  }
});

test("polling keeps activity creation and human identity distinct from viewer and update time", async () => {
  const client = createLinearClient({
    auth: {
      hasToken: () => true,
      ensureFresh: async () => "fixture-token",
      forceRefresh: async () => "fixture-token",
    },
    fetch: async (_url, options) => {
      const query = JSON.parse(String(options?.body)).query as string;
      expect(query).toContain("createdAt");
      expect(query).toContain("user { id }");
      return Response.json({
        data: {
          viewer: { id: "token-owner" },
          agentActivities: {
            nodes: [
              {
                id: "answer-1",
                createdAt: new Date(NOW - 10).toISOString(),
                updatedAt: new Date(NOW + 10).toISOString(),
                user: { id: "human-1" },
                agentSession: { id: "ses_1", issue: { id: "iss_1" } },
                content: { type: "prompt", body: "Yes" },
              },
            ],
          },
        },
      });
    },
  });
  const page = await createIntakePollSource(client, { teamId: "ENG" }).poll(NOW - 100);
  expect(page.activities[0]).toMatchObject({
    actorId: "human-1",
    activityCreatedAtMs: NOW - 10,
    updatedAtMs: NOW + 10,
  });
});

test("a polled prompt reaches answer delivery with normalized actor and creation time", async () => {
  const { db, question, orchestrator } = setup();
  const inbox = createInboxStore(db);
  const delivered = Promise.withResolvers<void>();
  let wake = () => {};
  const poller = startCatchUpPoller({
    source: createIntakePollSource(
      {
        async query() {
          return {
            viewer: { id: "token-owner" },
            agentActivities: {
              nodes: [
                {
                  id: "polled-answer",
                  createdAt: new Date(NOW + 1).toISOString(),
                  updatedAt: new Date(NOW + 100).toISOString(),
                  user: { id: "human-1" },
                  agentSession: { id: "ses_1", issue: { id: "iss_1" } },
                  content: { type: "prompt", body: "Yes" },
                },
              ],
            },
          };
        },
      },
      { teamId: "ENG" },
    ),
    store: inbox,
    sleeper: {
      wait: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      wake: () => wake(),
    },
    now: () => NOW + 1_000,
    async onEvent(event) {
      try {
        expect(event.actorId).toBe("human-1");
        expect(event.activityCreatedAtMs).toBe(NOW + 1);
        await orchestrator.onLinearEvent(event);
        delivered.resolve();
      } catch (error) {
        delivered.reject(error);
        throw error;
      }
    },
  });
  try {
    await delivered.promise;
    expect(getQuestion(db, question.id)?.answeredBy).toBe("human-1");
    expect(getQuestion(db, question.id)?.answer).toBe("Yes");
  } finally {
    poller.stop();
    await poller.settled;
    db.close();
  }
});

test("a runner wait asked before a restart is answered by the next process without a resume", async () => {
  const { db, item, question, orchestrator } = setup();
  try {
    answerQuestion(db, question.id, { answer: "No", answeredBy: "human-1", now: NOW });
    applyWorkItemEvent(db, item.id, "answer_received");
    const wait = ask(
      db,
      { itemId: item.id, runId: getWorkItem(db, item.id)!.currentRunId, sessionId: "ses_1" },
      "runner-wait",
      "Move the task to another runner, or keep waiting?",
      { options: ["Move to another runner", "Keep waiting"], now: NOW },
    );
    expect(wait.status).toBe("asked");
    await orchestrator.onLinearEvent(prompt(NOW + 1, "keep-waiting"));
    expect(getQuestion(db, wait.question.id)).toMatchObject({
      status: "answered",
      answeredBy: "human-1",
    });
    expect(listJobs(db).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(0);
  } finally {
    db.close();
  }
});
