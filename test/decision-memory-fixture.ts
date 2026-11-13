import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  activateLinearItem,
  applyWorkItemEvent,
  bindWorkItemRepository,
  getWorkItem,
  listJobs,
  openPawsStore,
  type Db,
} from "../src/db";
import {
  changeDecision,
  confirmDecisionSteps,
  listDecisions,
  suggestDecisionsSteps,
} from "../src/decisions";
import { getQuestion, openQuestion } from "../src/questions";
import { jsonValue, seed } from "./dialects";
import { answerQuestionPg } from "./questions";
import { createExecutionControlsFixturePg } from "./local/execution-controls";
import { pgliteServer } from "./pglite";

async function resumeJobs(db: Db): Promise<number> {
  return (await listJobs(db)).filter((job) => job.queue === "run.resume").length;
}

function setPaths(db: Db, paths: string[]): Promise<void> {
  return seed(db, (q) =>
    q.orm
      .update(q.t.workItemScheduling)
      .set({ paths: jsonValue(q, paths) })
      .where(eq(q.t.workItemScheduling.itemId, "controlled")),
  );
}

export async function decisionFixture(root: string) {
  const server = await pgliteServer();
  const fixture = await createExecutionControlsFixturePg(root, {
    database: { db: server.store, close: server.close },
  });
  await activateLinearItem(fixture.db, "session-controlled", "controlled");
  await bindWorkItemRepository(fixture.db, "controlled", {
    owner: "fixture",
    repo: "allowed",
    remoteUrl: "https://example.invalid/fixture/allowed",
  });
  const question = await openQuestion(fixture.db, {
    itemId: "controlled",
    sessionId: "session-controlled",
    body: "Which pagination format?",
    now: Date.now() - 2000,
  });
  await answerQuestionPg(fixture.db, question.id, {
    answer: "Use cursor pagination and the existing response format.",
    answeredBy: "member",
  });
  return { ...fixture, url: server.url, question: (await getQuestion(fixture.db, question.id))! };
}

export async function probeDecisionMemory(root: string) {
  const f = await decisionFixture(root);
  const observations: string[] = [];
  const actor = { workspaceId: "workspace", userId: "member", clientId: "client" };
  const call = (body?: unknown, identity = "member", headers = {}) =>
    fetch(`${f.origin}/api/workspaces/decisions`, {
      method: body ? "POST" : "GET",
      headers: { ...f.headers(identity), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const input = {
    questionId: f.question.id,
    statement: f.question.answer,
    scopeGlobs: ["**"],
    tags: ["pagination"],
  };
  try {
    assert.equal((await call(input, "inactive")).status, 401);
    assert.equal((await call(input, "outside")).status, 400);
    assert.equal((await call(input, "member", { "x-paws-csrf": "invalid" })).status, 403);
    assert.equal((await call(input, "member", { origin: "https://other.invalid" })).status, 403);
    observations.push("Current membership, source access, Origin and CSRF guard saving");
    const saved = await call(input);
    assert.equal(saved.status, 200, await saved.clone().text());
    const { id } = (await saved.json()) as { id: string };
    assert.equal((await call(input)).status, 400);
    assert.deepEqual(
      ((await (await call(undefined, "outside")).json()) as { decisions: unknown[] }).decisions,
      [],
    );
    assert.equal((await listDecisions(f.db, actor, "pagination"))[0]?.id, id);
    const pending = await openQuestion(f.db, {
      itemId: "controlled",
      sessionId: "session-controlled",
      body: "Which pagination format?",
      runId: f.runId,
      now: Date.now() - 1000,
    });
    await applyWorkItemEvent(f.db, "controlled", "blocking_question");
    const suggest = (questionId: string, body: string) =>
      f.db.run((q) => suggestDecisionsSteps(q, questionId, body));
    const confirm = (questionId: string, value: string, userId: string) =>
      f.db.transaction((q) => confirmDecisionSteps(q, questionId, value, userId, Date.now()));
    const options = await suggest(pending.id, pending.body);
    assert.equal(options.length, 1);
    assert.equal((await getQuestion(f.db, pending.id))?.status, "open");
    assert.equal((await getWorkItem(f.db, "controlled"))?.state, "awaiting_input");
    assert.equal(await resumeJobs(f.db), 0);
    observations.push("Search and persisted suggestions leave work awaiting human input");
    await assert.rejects(confirm(pending.id, options[0]!.value, "inactive"));
    await assert.rejects(confirm(pending.id, options[0]!.value, "outside"));
    await changeDecision(
      f.db,
      actor,
      {
        id,
        revision: 1,
        statement: "Use cursor pagination.",
        scopeGlobs: ["src/api/**"],
        tags: [],
      },
      Date.now(),
    );
    await assert.rejects(confirm(pending.id, options[0]!.value, "member"));
    await f.orchestrator.onLinearEvent({
      deliveryId: "stale-decision-delivery",
      source: "webhook",
      activityId: "stale-decision-activity",
      dedupeKey: "stale-decision",
      action: "prompted",
      sessionId: "session-controlled",
      issueId: "controlled",
      body: options[0]!.value,
      signal: null,
      actorId: "member",
      activityCreatedAtMs: Date.now() + 500,
      updatedAtMs: Date.now() + 500,
      payload: JSON.stringify({ questionId: pending.id, answeredBy: "member" }),
    });
    assert.equal((await getWorkItem(f.db, "controlled"))?.state, "awaiting_input");
    const rejected = await f.db.run((q) =>
      q.one(
        q.orm
          .select({ payload: q.t.outbox.payload })
          .from(q.t.outbox)
          .where(eq(q.t.outbox.idempotencyKey, "decision-rejected:stale-decision")),
      ),
    );
    assert.equal((rejected?.payload as { kind?: string } | undefined)?.kind, "error");
    assert.equal((await getQuestion(f.db, pending.id))?.status, "open");
    observations.push(
      "Corrected decisions invalidate old choices without changing the waiting answer",
    );
    await answerQuestionPg(f.db, pending.id, {
      answer: "Use cursor pagination.",
      answeredBy: "member",
    });
    const next = await openQuestion(f.db, {
      itemId: "controlled",
      sessionId: "session-controlled",
      body: "Which pagination format?",
      now: Date.now() - 500,
    });
    assert.equal((await suggest(next.id, next.body)).length, 0);
    await seed(
      f.db,
      (q) =>
        q.orm
          .update(q.t.workItem)
          .set({
            brief: jsonValue(q, { issue: { description: "paths: src/api/pagination.ts" } }),
          })
          .where(eq(q.t.workItem.id, "controlled")),
      (q) => q.orm.insert(q.t.workItemScheduling).values({ itemId: "controlled", projectKnown: 0 }),
    );
    assert.equal((await suggest(next.id, next.body)).length, 1);
    await setPaths(f.db, ["src/dashboard/index.ts"]);
    assert.equal((await suggest(next.id, next.body)).length, 0);
    await setPaths(f.db, ["src/api/pagination.ts"]);
    const suggestion = (await suggest(next.id, next.body))[0]!;
    await assert.rejects(
      f.db.transaction(function* (q) {
        yield* confirmDecisionSteps(q, next.id, suggestion.value, "member", Date.now());
        throw new Error("rollback");
      }),
    );
    assert.equal((await listDecisions(f.db, actor))[0]?.accepted, 0);
    const second = await openPawsStore({ url: f.url, pgliteDir: "" });
    assert.equal((await listDecisions(second.store, actor))[0]?.shown, 2);
    await second.close();
    const event = {
      deliveryId: "delivery",
      source: "webhook" as const,
      activityId: "decision-activity",
      dedupeKey: "confirm-decision",
      action: "prompted" as const,
      sessionId: "session-controlled",
      issueId: "controlled",
      body: suggestion.value,
      signal: null,
      actorId: "member",
      activityCreatedAtMs: Date.now() + 1000,
      updatedAtMs: Date.now() + 1000,
      payload: JSON.stringify({ questionId: next.id, answeredBy: "member" }),
    };
    await f.orchestrator.onLinearEvent(event);
    await f.orchestrator.onLinearEvent(event);
    assert.equal((await getQuestion(f.db, next.id))?.answer, "Use cursor pagination.");
    assert.equal((await listDecisions(f.db, actor))[0]?.accepted, 1);
    assert.equal(await resumeJobs(f.db), 1);
    observations.push(
      "Persisted choices survive reopening the database and one human confirmation schedules exactly one resume",
    );
    await changeDecision(f.db, actor, { id, revision: 2, retire: true }, Date.now());
    const retired = await openQuestion(f.db, {
      itemId: "controlled",
      sessionId: "session-controlled",
      body: "pagination",
    });
    assert.equal((await suggest(retired.id, retired.body)).length, 0);
    assert.equal((await listDecisions(f.db, actor))[0]?.retiredAt !== null, true);
    observations.push("Retired decisions remain auditable and are excluded from suggestions");
    await seed(f.db, (q) =>
      q.orm
        .delete(q.t.workspaceRepository)
        .where(eq(q.t.workspaceRepository.workspaceId, "workspace")),
    );
    assert.deepEqual(await listDecisions(f.db, actor), []);
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    return observations;
  } finally {
    await f.close();
  }
}
