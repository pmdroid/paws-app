import { expect, test } from "bun:test";
import { asc, eq, like } from "drizzle-orm";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  enqueueOutboxOnce,
  listOutbox,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { createFakeTracker, parseAgentEvent } from "../src/linear";
import { attachOrchestrator, deliverLinearOutbox } from "../src/loop";
import {
  QUESTION_ANSWER_PATH,
  getQuestion,
  handleQuestionAnswer,
  openLinkAsk,
  openQuestion,
} from "../src/questions";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const NOW = 1_700_000_000_000;
const OPTIONS = ["Fix the policy", "Add script alias"];
const principal = { workspaceId: "ws", userId: "user-1" };

async function setup(active = true) {
  const { db, close } = await tempStore();
  const item = await insertQueuedItem(db, { id: "PAS-1003", sessionKey: "ses_1", title: "Policy" });
  await beginImplementRun(db, item.id, NOW - 10);
  await applyWorkItemEvent(db, item.id, "blocking_question");
  const question = await openQuestion(db, {
    itemId: item.id,
    sessionId: "ses_1",
    body: "Which way?",
    options: OPTIONS,
    now: NOW,
  });
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws", linearOrganizationId: "org", name: "Kyku", createdAt: NOW }),
    (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({ id: "user-1", linearUserId: "linear-1", name: "Sam", email: "sam@example.com" }),
  );
  await syncWorkspaceMember(db, {
    workspaceId: "ws",
    userId: "user-1",
    role: "member",
    active,
    teamIds: [],
    now: NOW,
  });
  const clock = new FakeClock(NOW + 1_000);
  const orchestrator = attachOrchestrator({
    store: db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: "/tmp/paws-question-answer-route",
    tracker: null,
    clock,
  });
  const submit = (body: unknown, sessionIds: readonly string[] | null = ["ses_1"]) =>
    handleQuestionAnswer(
      new Request(`https://paws.example${QUESTION_ANSWER_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      {
        store: db,
        principal: sessionIds === null ? undefined : principal,
        sessionIds: sessionIds ?? undefined,
        submit: (input) => orchestrator.answerFromPaws(input),
        now: () => NOW + 5,
      },
    );
  return { db, close, item, question, orchestrator, submit };
}

const linearReply = (body: string, id = "reply-1") =>
  parseAgentEvent(
    JSON.stringify({
      type: "AgentSessionEvent",
      action: "prompted",
      webhookTimestamp: NOW + 100,
      agentSession: { id: "ses_1", issue: { id: "lin-item-PAS-1003" } },
      agentActivity: {
        id,
        createdAt: new Date(NOW + 1).toISOString(),
        userId: "linear-1",
        content: { type: "prompt", body },
      },
    }),
    `delivery:${id}`,
    NOW + 100,
  )!;

const history = (db: Db, itemId: string) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({
          from_state: q.t.workItemEvent.fromState,
          to_state: q.t.workItemEvent.toState,
          event: q.t.workItemEvent.event,
        })
        .from(q.t.workItemEvent)
        .where(eq(q.t.workItemEvent.itemId, itemId))
        .orderBy(asc(q.t.workItemEvent.version)),
    ),
  );

const answerQuestion = (db: Db, id: string) =>
  seed(db, (q) =>
    q.orm.update(q.t.question).set({ status: "answered" }).where(eq(q.t.question.id, id)),
  );

const resumes = async (db: Db) =>
  (await listJobs(db))
    .filter((job) => job.queue === JOB_KIND.resume)
    .map((job) => ({ ...(job.payload as object), runId: undefined }));

const pawsNotes = async (db: Db) =>
  (await listOutbox(db))
    .map((row) => row.payload as { kind?: string; body?: string })
    .filter((payload) => payload.body?.startsWith("Answered in Paws by"));

test("signed out, another session or an answered question are refused", async () => {
  const { db, close, question, submit } = await setup();
  try {
    const body = { questionId: question.id, answer: OPTIONS[0] };
    expect((await submit(body, null))?.status).toBe(401);
    const elsewhere = await submit(body, ["ses_other"]);
    expect(elsewhere?.status).toBe(409);
    expect(await elsewhere?.json()).toEqual({ error: "This question is no longer waiting" });
    await answerQuestion(db, question.id);
    expect((await submit(body))?.status).toBe(409);
    expect(await resumes(db)).toEqual([]);
  } finally {
    await close();
  }
});

test("a non-member gets 403 and an audit row", async () => {
  const { db, close, question, submit } = await setup(false);
  try {
    expect((await submit({ questionId: question.id, answer: OPTIONS[0] }))?.status).toBe(403);
    expect(
      await db.run((q) =>
        q.all(
          q.orm
            .select({
              action: q.t.workspaceAccessAudit.action,
              subject: q.t.workspaceAccessAudit.subject,
            })
            .from(q.t.workspaceAccessAudit)
            .where(eq(q.t.workspaceAccessAudit.action, "question.refused")),
        ),
      ),
    ).toEqual([{ action: "question.refused", subject: "PAS-1003 agent" }]);
    expect((await getQuestion(db, question.id))?.status).toBe("open");
  } finally {
    await close();
  }
});

test("a link ask is answered on the issue page", async () => {
  const { db, close, question, submit } = await setup();
  try {
    await answerQuestion(db, question.id);
    const { question: link } = await openLinkAsk(db, {
      asker: { itemId: "PAS-1003", runId: null, sessionId: "ses_1" },
      kind: "risk",
      head: "7f65200aa",
      link: "https://paws.example/dashboard/issues/PAS-1003#risk",
      detail: "High-risk paths changed: src/auth/session.ts.",
      answerers: ["linear-1"],
      now: NOW,
    });
    const response = await submit({ questionId: link.id, answer: "Approve" });
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "Answer this on the issue page" });
  } finally {
    await close();
  }
});

test("an option answered in Paws restarts the item as a Linear reply does, once", async () => {
  const paws = await setup();
  const linear = await setup();
  try {
    const response = await paws.submit({ questionId: paws.question.id, answer: OPTIONS[0] });
    expect(response?.status).toBe(200);
    expect(await getQuestion(paws.db, paws.question.id)).toMatchObject({
      status: "answered",
      answer: OPTIONS[0],
      answeredBy: "linear-1",
    });

    await linear.orchestrator.onLinearEvent(linearReply(OPTIONS[0]!));
    expect((await getQuestion(linear.db, linear.question.id))?.answeredBy).toBe("linear-1");
    expect(await history(paws.db, paws.item.id)).toEqual(await history(linear.db, linear.item.id));
    expect((await getWorkItem(paws.db, paws.item.id))?.state).toBe(
      (await getWorkItem(linear.db, linear.item.id))!.state,
    );
    expect(await resumes(paws.db)).toHaveLength(1);
    expect(await resumes(paws.db)).toEqual(await resumes(linear.db));

    const again = await paws.submit({ questionId: paws.question.id, answer: OPTIONS[1] });
    expect(again?.status).toBe(409);
    expect(
      await paws.orchestrator.answerFromPaws({
        questionId: paws.question.id,
        answer: "Add script alias",
        answeredBy: "linear-1",
        answeredByName: "Sam",
      }),
    ).toBe("rejected");
    expect(await resumes(paws.db)).toHaveLength(1);
    expect(await history(paws.db, paws.item.id)).toEqual(await history(linear.db, linear.item.id));

    expect(await pawsNotes(paws.db)).toEqual([
      expect.objectContaining({
        kind: "response",
        body: "Answered in Paws by Sam: Fix the policy",
      }),
    ]);
    expect(await pawsNotes(linear.db)).toEqual([]);
  } finally {
    await paws.close();
    await linear.close();
  }
});

test("a rejected answer leaves the question open and a corrected answer closes it", async () => {
  const { db, close, question, submit } = await setup();
  try {
    const rejected = await submit({ questionId: question.id, answer: "/paws decision expired" });
    expect(rejected?.status).toBe(409);
    expect((await getQuestion(db, question.id))?.status).toBe("open");
    expect(await resumes(db)).toEqual([]);
    expect((await submit({ questionId: question.id, answer: OPTIONS[0] }))?.status).toBe(200);
    expect(await getQuestion(db, question.id)).toMatchObject({
      status: "answered",
      answer: OPTIONS[0],
    });
    expect(await resumes(db)).toHaveLength(1);
  } finally {
    await close();
  }
});

test("a cancelled question is not answered and nothing restarts", async () => {
  const { db, close, question, submit } = await setup();
  try {
    await seed(db, (q) =>
      q.orm
        .update(q.t.question)
        .set({ cancelledAt: NOW + 2 })
        .where(eq(q.t.question.id, question.id)),
    );
    expect((await submit({ questionId: question.id, answer: OPTIONS[0] }))?.status).toBe(409);
    expect(await resumes(db)).toEqual([]);
    expect(
      await db.run((q) =>
        q.all(q.orm.select({ eventKey: q.t.linearTurn.eventKey }).from(q.t.linearTurn)),
      ),
    ).toEqual([]);
  } finally {
    await close();
  }
});

test("a Linear reply racing a Paws answer answers the question once", async () => {
  const { db, close, question, orchestrator } = await setup();
  try {
    const [, paws] = await Promise.allSettled([
      orchestrator.onLinearEvent(linearReply(OPTIONS[1]!)),
      orchestrator.answerFromPaws({
        questionId: question.id,
        answer: OPTIONS[0]!,
        answeredBy: "linear-1",
        answeredByName: "Sam",
      }),
    ]);
    const answered = paws.status === "fulfilled" && paws.value === "answered";
    const stored = (await getQuestion(db, question.id))!;
    expect(stored.status).toBe("answered");
    expect(stored.answer).toBe(answered ? OPTIONS[0]! : OPTIONS[1]!);
    expect(await resumes(db)).toHaveLength(1);
    expect(await pawsNotes(db)).toHaveLength(answered ? 1 : 0);
    expect(
      await db.run((q) =>
        q.all(
          q.orm
            .select({ state: q.t.linearTurn.state })
            .from(q.t.linearTurn)
            .where(like(q.t.linearTurn.eventKey, "paws-answer:%")),
        ),
      ),
    ).toHaveLength(answered ? 1 : 0);
  } finally {
    await close();
  }
});

test("the answer record reaches Linear after the pull request response", async () => {
  const { db, close, question, submit } = await setup();
  try {
    for (const [key, kind] of [
      ["pull-request-ready:PAS-1003", "response"],
      ["late-thought", "thought"],
    ] as const)
      await enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: "ses_1",
        idempotencyKey: key,
        payload: { id: key, sessionId: "ses_1", kind, body: key },
        now: NOW,
      });
    await seed(db, (q) =>
      q.orm
        .update(q.t.outbox)
        .set({ status: "sent" })
        .where(eq(q.t.outbox.idempotencyKey, "pull-request-ready:PAS-1003")),
    );
    expect((await submit({ questionId: question.id, answer: OPTIONS[0] }))?.status).toBe(200);
    const tracker = createFakeTracker();
    for (const row of (await listOutbox(db)).filter((entry) => entry.status !== "sent"))
      await deliverLinearOutbox(row, tracker, async () => {}, undefined, db);
    expect(tracker.progress.map((update) => update.body)).toEqual([
      "Answered in Paws by Sam: Fix the policy",
    ]);
  } finally {
    await close();
  }
});
