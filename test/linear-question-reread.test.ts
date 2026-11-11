import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  insertQueuedItem,
  listJobs,
  setJournalSink,
  sqliteDb,
} from "../src/db";
import {
  createInboxStore,
  createIntakePollSource,
  handleLinearWebhook,
  startCatchUpPoller,
  type IntakePollSource,
  type AcceptedLinearEvent,
} from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { getQuestion, openQuestion } from "../src/questions";
import { tempDb } from "./helpers";

const NOW = 1_700_000_000_000;

type Prompt = { id: string; sessionId: string; issueId: string; body: string; at: number };

function linearWorld() {
  const prompts: Prompt[] = [];
  const threadReads: string[] = [];
  let pagesLeft = 0;
  const node = (prompt: Prompt) => ({
    id: prompt.id,
    createdAt: new Date(prompt.at).toISOString(),
    updatedAt: new Date(prompt.at).toISOString(),
    user: { id: "human-1" },
    agentSession: { id: prompt.sessionId, issue: { id: prompt.issueId } },
    content: { type: "prompt", body: prompt.body },
  });
  const client = {
    async query(query: string, variables: Record<string, unknown> = {}) {
      if (query.includes("QuestionThread")) {
        const sessionId = String(variables["id"]);
        threadReads.push(sessionId);
        const since = Date.parse(String(variables["since"]));
        return {
          agentSession: {
            id: sessionId,
            activities: {
              nodes: prompts
                .filter((prompt) => prompt.sessionId === sessionId && prompt.at > since)
                .map(node),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      const since = Date.parse(String(variables["since"]));
      const more = variables["includeIssues"] === true && pagesLeft > 0;
      if (more) pagesLeft -= 1;
      return {
        viewer: { id: "app_1" },
        issues: {
          nodes: [],
          pageInfo: { hasNextPage: more, endCursor: more ? `p${pagesLeft}` : null },
        },
        comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        agentActivities: {
          nodes:
            variables["includeActivities"] === true
              ? prompts.filter((prompt) => prompt.at > since).map(node)
              : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    },
  };
  return {
    client,
    prompts,
    threadReads,
    morePages(count: number) {
      pagesLeft = count;
    },
  };
}

async function askedSession() {
  const db = tempDb();
  const item = insertQueuedItem(db, { id: "ENG-2", sessionKey: "ses_1", title: "Export rows" });
  beginImplementRun(db, item.id, NOW - 10);
  applyWorkItemEvent(db, item.id, "blocking_question");
  const question = await openQuestion(db, {
    itemId: item.id,
    sessionId: "ses_1",
    body: "Include archived rows?",
    now: NOW,
  });
  return { db, item, question };
}

function setup(
  { db, item, question }: Awaited<ReturnType<typeof askedSession>>,
  options: { reread?: boolean } = {},
) {
  const clock = new FakeClock(NOW + 1_000);
  const orchestrator = attachOrchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: "/tmp/paws-question-reread",
    tracker: null,
    clock,
  });
  const world = linearWorld();
  const store = createInboxStore(db);
  const delivered: AcceptedLinearEvent[] = [];
  let now = NOW + 1_000;
  let wake = () => {};
  const hooks: { onDeliver: (event: AcceptedLinearEvent) => void } = { onDeliver: () => {} };
  const source: IntakePollSource = createIntakePollSource(world.client, { teamId: "ENG" });
  const journal: string[] = [];
  const restoreJournal = setJournalSink((line) => journal.push(line));
  const poller = startCatchUpPoller({
    source: options.reread === false ? { poll: (since) => source.poll(since) } : source,
    store,
    db,
    now: () => now,
    sleeper: {
      wait: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      wake: () => wake(),
    },
    async onEvent(event) {
      delivered.push(event);
      hooks.onDeliver(event);
      await orchestrator.onLinearEvent(event);
    },
  });
  return {
    db,
    item,
    question,
    orchestrator,
    world,
    store,
    poller,
    delivered,
    hooks,
    journal,
    reply(input: Partial<Prompt> = {}) {
      const prompt: Prompt = {
        id: "reply-1",
        sessionId: "ses_1",
        issueId: "iss_1",
        body: "Yes",
        at: now,
        ...input,
      };
      world.prompts.push(prompt);
      return prompt;
    },
    resumes: () => listJobs(db).filter((job) => job.queue === JOB_KIND.resume),
    async webhook(prompt: Prompt) {
      const body = JSON.stringify({
        type: "AgentSessionEvent",
        action: "prompted",
        webhookTimestamp: now,
        agentSession: { id: prompt.sessionId, issue: { id: prompt.issueId } },
        agentActivity: {
          id: prompt.id,
          createdAt: new Date(prompt.at).toISOString(),
          userId: "human-1",
          content: { type: "prompt", body: prompt.body },
        },
      });
      const response = await handleLinearWebhook(
        new Request("http://localhost/webhooks/linear", {
          method: "POST",
          body,
          headers: {
            "linear-signature": createHmac("sha256", "secret").update(body).digest("hex"),
            "linear-delivery": `delivery:${prompt.id}`,
          },
        }),
        "secret",
        { store, onEvent: (event) => orchestrator.onLinearEvent(event), now: () => now },
      );
      expect(response.status).toBe(200);
      await waitFor(() => store.listUnhandled().length === 0);
    },
    advance(ms: number) {
      now += ms;
    },
    at: () => now,
    async close() {
      restoreJournal();
      await poller.stop();
      db.close();
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("the poll cursor starts where the cycle read activities, so a reply during a long cycle is read next", async () => {
  const t = setup(await askedSession(), { reread: false });
  try {
    await t.poller.pollNow();
    t.world.prompts.push({
      id: "nudge",
      sessionId: "ses_other",
      issueId: "iss_other",
      body: "hello",
      at: t.at() + 1,
    });
    t.world.morePages(1);
    t.advance(60_000);
    t.hooks.onDeliver = (event) => {
      if (event.activityId !== "nudge") return;
      t.hooks.onDeliver = () => {};
      t.reply({ at: t.at() + 1_000 });
      t.advance(30_000);
    };
    await t.poller.pollNow();
    t.advance(60_000);
    await t.poller.pollNow();
    expect(t.delivered.map((event) => event.activityId)).toContain("reply-1");
    expect((await getQuestion(sqliteDb(t.db), t.question.id))?.status).toBe("answered");
  } finally {
    await t.close();
  }
});

test("a reply behind the poll cursor with no webhook answers the open question on the next poll", async () => {
  const t = setup(await askedSession());
  try {
    await t.poller.pollNow();
    t.reply({ at: t.at() + 1_000 });
    t.store.setCursor("linear", t.at() + 60_000);
    t.advance(60_000);
    await t.poller.pollNow();
    expect(await getQuestion(sqliteDb(t.db), t.question.id)).toMatchObject({
      status: "answered",
      answer: "Yes",
      answerEventKey: "activity:reply-1",
    });
    expect(t.resumes()).toHaveLength(1);
    expect(t.journal.filter((line) => line.includes("poll re-read found reply"))).toEqual([
      "poll re-read found reply reply-1 in question thread ses_1 that no webhook delivered",
    ]);
  } finally {
    await t.close();
  }
});

test("a reply delivered by both a webhook and the poll answers the question once", async () => {
  const t = setup(await askedSession());
  try {
    await t.poller.pollNow();
    await t.webhook(t.reply({ at: t.at() + 1_000 }));
    expect((await getQuestion(sqliteDb(t.db), t.question.id))?.status).toBe("answered");
    t.advance(60_000);
    await t.poller.pollNow();
    expect(t.resumes()).toHaveLength(1);
    expect(t.delivered.filter((event) => event.activityId === "reply-1")).toHaveLength(0);
    expect(t.journal.some((line) => line.includes("poll re-read found reply"))).toBe(false);
  } finally {
    await t.close();
  }
});

test("a reply in another issue's thread does not touch the open question", async () => {
  const t = setup(await askedSession());
  try {
    await t.poller.pollNow();
    t.reply({ id: "other-reply", sessionId: "ses_other", issueId: "iss_other", at: t.at() + 1 });
    t.store.setCursor("linear", t.at() + 60_000);
    t.advance(60_000);
    await t.poller.pollNow();
    expect((await getQuestion(sqliteDb(t.db), t.question.id))?.status).toBe("open");
    expect(t.resumes()).toHaveLength(0);
    expect(new Set(t.world.threadReads)).toEqual(new Set(["ses_1"]));
  } finally {
    await t.close();
  }
});

test("an answered question's thread is no longer re-read", async () => {
  const t = setup(await askedSession());
  try {
    await t.poller.pollNow();
    expect(t.world.threadReads).toEqual(["ses_1"]);
    t.reply({ at: t.at() + 1_000 });
    t.advance(60_000);
    await t.poller.pollNow();
    expect((await getQuestion(sqliteDb(t.db), t.question.id))?.status).toBe("answered");
    const reads = t.world.threadReads.length;
    t.advance(60_000);
    await t.poller.pollNow();
    expect(t.world.threadReads).toHaveLength(reads);
  } finally {
    await t.close();
  }
});
