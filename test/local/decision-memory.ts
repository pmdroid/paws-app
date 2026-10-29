import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activateLinearItem,
  applyWorkItemEvent,
  bindWorkItemRepository,
  getWorkItem,
  openDatabase,
} from "../../src/db";
import {
  changeDecision,
  confirmDecision,
  listDecisions,
  suggestDecisions,
} from "../../src/decisions";
import { answerQuestion, getQuestion, openQuestion } from "../../src/questions";
import { createExecutionControlsFixture } from "./execution-controls";

export function decisionFixture(root: string) {
  const fixture = createExecutionControlsFixture(root);
  activateLinearItem(fixture.db, "session-controlled", "controlled");
  bindWorkItemRepository(fixture.db, "controlled", {
    owner: "fixture",
    repo: "allowed",
    remoteUrl: "https://example.invalid/fixture/allowed",
  });
  const question = openQuestion(fixture.db, {
    itemId: "controlled",
    sessionId: "session-controlled",
    body: "Which pagination format?",
    now: Date.now() - 2000,
  });
  answerQuestion(fixture.db, question.id, {
    answer: "Use cursor pagination and the existing response format.",
    answeredBy: "member",
  });
  return { ...fixture, question: getQuestion(fixture.db, question.id)! };
}

export async function probeDecisionMemory(root: string) {
  const f = decisionFixture(root);
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
    assert.equal(listDecisions(f.db, actor, "pagination")[0]?.id, id);
    const pending = openQuestion(f.db, {
      itemId: "controlled",
      sessionId: "session-controlled",
      body: "Which pagination format?",
      runId: f.runId,
      now: Date.now() - 1000,
    });
    applyWorkItemEvent(f.db, "controlled", "blocking_question");
    const options = suggestDecisions(f.db, pending.id, pending.body);
    assert.equal(options.length, 1);
    assert.equal(getQuestion(f.db, pending.id)?.status, "open");
    assert.equal(getWorkItem(f.db, "controlled")?.state, "awaiting_input");
    assert.equal(f.db.query("SELECT * FROM job WHERE queue='run.resume'").all().length, 0);
    observations.push("Search and persisted suggestions leave work awaiting human input");
    assert.throws(() =>
      confirmDecision(f.db, pending.id, options[0]!.value, "inactive", Date.now()),
    );
    assert.throws(() =>
      confirmDecision(f.db, pending.id, options[0]!.value, "outside", Date.now()),
    );
    changeDecision(
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
    assert.throws(() => confirmDecision(f.db, pending.id, options[0]!.value, "member", Date.now()));
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
    assert.equal(getWorkItem(f.db, "controlled")?.state, "awaiting_input");
    assert.equal(
      f.db
        .query<{ kind: string }, []>(
          "SELECT json_extract(payload,'$.kind') AS kind FROM outbox WHERE idempotency_key='decision-rejected:stale-decision'",
        )
        .get()?.kind,
      "error",
    );
    assert.equal(getQuestion(f.db, pending.id)?.status, "open");
    observations.push(
      "Corrected decisions invalidate old choices without changing the waiting answer",
    );
    answerQuestion(f.db, pending.id, { answer: "Use cursor pagination.", answeredBy: "member" });
    const next = openQuestion(f.db, {
      itemId: "controlled",
      sessionId: "session-controlled",
      body: "Which pagination format?",
      now: Date.now() - 500,
    });
    assert.equal(suggestDecisions(f.db, next.id, next.body).length, 0);
    f.db.run("UPDATE work_item SET brief=? WHERE id='controlled'", [
      JSON.stringify({ issue: { description: "paths: src/api/pagination.ts" } }),
    ]);
    f.db.run("INSERT INTO work_item_scheduling(item_id,project_known) VALUES('controlled',0)");
    assert.equal(suggestDecisions(f.db, next.id, next.body).length, 1);
    f.db.run("UPDATE work_item_scheduling SET paths=? WHERE item_id='controlled'", [
      JSON.stringify(["src/web/index.ts"]),
    ]);
    assert.equal(suggestDecisions(f.db, next.id, next.body).length, 0);
    f.db.run("UPDATE work_item_scheduling SET paths=? WHERE item_id='controlled'", [
      JSON.stringify(["src/api/pagination.ts"]),
    ]);
    const suggestion = suggestDecisions(f.db, next.id, next.body)[0]!;
    assert.throws(() =>
      f.db
        .transaction(() => {
          confirmDecision(f.db, next.id, suggestion.value, "member", Date.now());
          throw new Error("rollback");
        })
        .immediate(),
    );
    assert.equal(listDecisions(f.db, actor)[0]?.accepted, 0);
    const second = openDatabase(join(root, "controls.sqlite"));
    assert.equal(listDecisions(second, actor)[0]?.shown, 2);
    second.close();
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
    assert.equal(getQuestion(f.db, next.id)?.answer, "Use cursor pagination.");
    assert.equal(listDecisions(f.db, actor)[0]?.accepted, 1);
    assert.equal(f.db.query("SELECT * FROM job WHERE queue='run.resume'").all().length, 1);
    observations.push(
      "Persisted choices survive reopening SQLite and one human confirmation schedules exactly one resume",
    );
    changeDecision(f.db, actor, { id, revision: 2, retire: true }, Date.now());
    const retired = openQuestion(f.db, {
      itemId: "controlled",
      sessionId: "session-controlled",
      body: "pagination",
    });
    assert.equal(suggestDecisions(f.db, retired.id, retired.body).length, 0);
    assert.equal(listDecisions(f.db, actor)[0]?.retiredAt !== null, true);
    observations.push("Retired decisions remain auditable and are excluded from suggestions");
    f.db.run("DELETE FROM workspace_repository WHERE workspace_id='workspace'");
    assert.deepEqual(listDecisions(f.db, actor), []);
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    return observations;
  } finally {
    await f.close();
  }
}

if (import.meta.main) {
  const root = process.argv[2]!;
  if (!root) throw new Error("Provide a disposable evidence directory.");
  mkdirSync(root, { recursive: true });
  if (process.argv.includes("--serve")) {
    const f = decisionFixture(root);
    writeFileSync(
      join(root, "fixture.json"),
      JSON.stringify({ origin: f.origin, token: f.sessions["member"]!.token }),
    );
    process.on("SIGTERM", () => void f.close().then(() => process.exit(0)));
    console.log(f.origin);
  } else console.log(await probeDecisionMemory(root));
}
