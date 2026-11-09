import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  acceptDecisionSuggestionSteps,
  answeredDecisionQuestionSteps,
  correctDecisionMemorySteps,
  decisionRowSteps,
  decisionScopeSteps,
  insertDecisionMemorySteps,
  itemPathHintsSteps,
  listDecisionRowsSteps,
  openDecisionSuggestionSteps,
  recordDecisionSuggestionSteps,
  retireDecisionMemorySteps,
  unsavedDecisionAnswersSteps,
  type Db,
} from "../src/db";
import {
  forEachDialect,
  insertWorkItem,
  json,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

const content = { statement: "Use cursors.", globs: '["src/**"]', tags: '["api"]' };

function insertDecision(db: Db, id: string, questionId: string, now: number) {
  return db.run((q) =>
    insertDecisionMemorySteps(q, {
      ...content,
      id,
      questionId,
      workspaceId: "w",
      userId: "ada",
      now,
    }),
  );
}

function insertQuestion(
  db: Db,
  id: string,
  fields: Partial<{
    sessionId: string;
    kind: string;
    status: string;
    answer: string | null;
    answeredBy: string | null;
    answeredAt: number | null;
    cancelledAt: number | null;
  }> = {},
) {
  return seed(db, (q) =>
    q.orm.insert(q.t.question).values({
      id,
      itemId: "item",
      sessionId: `session-${id}`,
      body: `${id} body`,
      status: "answered",
      answer: `${id} answer`,
      answeredBy: "ada",
      answeredAt: 1,
      createdAt: 0,
      ...fields,
    }),
  );
}

async function seedScope(db: Db, installationObservedAt: number | null = 5) {
  await insertWorkItem(db, "item");
  await insertQuestion(db, "asked", { sessionId: "session" });
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "w", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: "session",
        organizationId: "org",
        oauthClientId: "client",
        teamId: "team",
        installationObservedAt,
        createdAt: 0,
      }),
    (q) =>
      q.orm
        .insert(q.t.workItemRepository)
        .values({ itemId: "item", owner: "Acme", repo: "App", remoteUrl: "https://x.invalid" }),
  );
}

forEachDialect((connect) => {
  test("a question's scope needs an observed installation and an allowed repository", async () => {
    const db = await connected(connect);
    await seedScope(db);
    expect(await db.run((q) => decisionScopeSteps(q, "asked"))).toBeNull();
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "w", repository: "acme/app", teamId: "team" }),
    );
    expect(await db.run((q) => decisionScopeSteps(q, "asked"))).toEqual({
      workspaceId: "w",
      sessionId: "session",
      clientId: "client",
      teamId: "team",
      repository: "acme/app",
      identifier: "item",
      itemId: "item",
    });
    expect(await db.run((q) => decisionScopeSteps(q, "missing"))).toBeNull();
  });

  test("an unobserved installation has no scope", async () => {
    const db = await connected(connect);
    await seedScope(db, null);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspaceRepository)
        .values({ workspaceId: "w", repository: "acme/app", teamId: "team" }),
    );
    expect(await db.run((q) => decisionScopeSteps(q, "asked"))).toBeNull();
  });

  test("decisions read back with JSON text and suggestion counts, newest first", async () => {
    const db = await connected(connect);
    await insertQuestion(db, "one");
    await insertQuestion(db, "two");
    await insertDecision(db, "older", "one", 1);
    await insertDecision(db, "newer", "two", 2);
    await db.run((q) =>
      recordDecisionSuggestionSteps(q, {
        id: "s1",
        questionId: "two",
        decisionId: "older",
        revision: 1,
        statement: content.statement,
      }),
    );
    await db.run((q) =>
      recordDecisionSuggestionSteps(q, {
        id: "s2",
        questionId: "one",
        decisionId: "older",
        revision: 1,
        statement: content.statement,
      }),
    );
    await db.run((q) => acceptDecisionSuggestionSteps(q, "s2", "linear-ada", 9));
    const rows = await db.run((q) => listDecisionRowsSteps(q, "w"));
    expect(rows.map((row) => [row.id, row.shown, row.accepted])).toEqual([
      ["newer", 0, 0],
      ["older", 2, 1],
    ]);
    expect(JSON.parse(rows[0]!.scopeGlobs)).toEqual(["src/**"]);
    expect(JSON.parse(rows[0]!.tags)).toEqual(["api"]);
    expect(rows[0]!.author).toBe("ada");
    expect(await db.run((q) => listDecisionRowsSteps(q, "other"))).toEqual([]);
  });

  test("correcting and retiring bump the revision, and a retired decision is not active", async () => {
    const db = await connected(connect);
    await insertQuestion(db, "one");
    await insertDecision(db, "d", "one", 1);
    await db.run((q) =>
      correctDecisionMemorySteps(q, {
        id: "d",
        userId: "bob",
        now: 2,
        statement: "Use offsets.",
        globs: '["lib/**"]',
        tags: "[]",
      }),
    );
    const corrected = await db.run((q) => decisionRowSteps(q, "d"));
    expect(corrected).toMatchObject({ statement: "Use offsets.", revision: 2, retiredAt: null });
    expect(JSON.parse(corrected!.scopeGlobs)).toEqual(["lib/**"]);
    expect(await db.run((q) => decisionRowSteps(q, "d", { activeOnly: true }))).not.toBeNull();
    await db.run((q) => retireDecisionMemorySteps(q, { id: "d", userId: "bob", now: 3 }));
    expect(await db.run((q) => decisionRowSteps(q, "d"))).toMatchObject({
      revision: 3,
      retiredAt: 3,
    });
    expect(await db.run((q) => decisionRowSteps(q, "d", { activeOnly: true }))).toBeNull();
    expect(await db.run((q) => decisionRowSteps(q, "missing"))).toBeNull();
    const stored = await db.run((q) =>
      q.one(
        q.orm
          .select({
            updatedBy: q.t.decisionMemory.updatedBy,
            updatedAt: q.t.decisionMemory.updatedAt,
          })
          .from(q.t.decisionMemory)
          .where(eq(q.t.decisionMemory.id, "d")),
      ),
    );
    expect(stored).toEqual({ updatedBy: "bob", updatedAt: 3 });
  });

  test("offered answers are unsaved agent and clarification answers, unanswered time last", async () => {
    const db = await connected(connect);
    await insertQuestion(db, "older", { answeredAt: 1 });
    await insertQuestion(db, "undated", { answeredAt: null });
    await insertQuestion(db, "newer", { answeredAt: 2, kind: "clarification" });
    await insertQuestion(db, "saved", { answeredAt: 3 });
    await insertDecision(db, "d", "saved", 1);
    await insertQuestion(db, "wait", { answeredAt: 4, kind: "runner-wait" });
    await insertQuestion(db, "cancelled", { answeredAt: 5, cancelledAt: 6 });
    await insertQuestion(db, "open", { answeredAt: 6, status: "open" });
    await insertQuestion(db, "blank", { answeredAt: 7, answer: null });
    const rows = await db.run((q) => unsavedDecisionAnswersSteps(q));
    expect(rows.map((row) => row.id)).toEqual(["newer", "older", "undated"]);
    expect(rows[0]).toEqual({
      id: "newer",
      body: "newer body",
      answer: "newer answer",
      author: "ada",
      sessionId: "session-newer",
    });
  });

  test("an answered question reads only while it stands answered", async () => {
    const db = await connected(connect);
    await insertQuestion(db, "done");
    await insertQuestion(db, "open", { status: "open" });
    await insertQuestion(db, "cancelled", { cancelledAt: 2 });
    expect(await db.run((q) => answeredDecisionQuestionSteps(q, "done"))).toEqual({
      answer: "done answer",
      answeredBy: "ada",
    });
    expect(await db.run((q) => answeredDecisionQuestionSteps(q, "open"))).toBeNull();
    expect(await db.run((q) => answeredDecisionQuestionSteps(q, "cancelled"))).toBeNull();
  });

  test("a suggestion records once, keeps its first id, and closes when accepted", async () => {
    const db = await connected(connect);
    const offer = (id: string) =>
      db.run((q) =>
        recordDecisionSuggestionSteps(q, {
          id,
          questionId: "asked",
          decisionId: "d",
          revision: 1,
          statement: "Use cursors.",
        }),
      );
    expect(await offer("first")).toBe("first");
    expect(await offer("second")).toBe("first");
    expect(await db.run((q) => openDecisionSuggestionSteps(q, "first", "asked"))).toEqual({
      decisionId: "d",
      revision: 1,
      statement: "Use cursors.",
    });
    expect(await db.run((q) => openDecisionSuggestionSteps(q, "first", "other"))).toBeNull();
    await db.run((q) => acceptDecisionSuggestionSteps(q, "first", "linear-ada", 7));
    expect(await db.run((q) => openDecisionSuggestionSteps(q, "first", "asked"))).toBeNull();
    const stored = await db.run((q) =>
      q.one(
        q.orm
          .select({
            acceptedBy: q.t.decisionSuggestion.acceptedBy,
            acceptedAt: q.t.decisionSuggestion.acceptedAt,
          })
          .from(q.t.decisionSuggestion),
      ),
    );
    expect(stored).toEqual({ acceptedBy: "linear-ada", acceptedAt: 7 });
  });

  test("path hints read the brief with and without a scheduling row", async () => {
    const db = await connected(connect);
    await insertWorkItem(db, "item");
    expect(await db.run((q) => itemPathHintsSteps(q, "missing"))).toBeNull();
    expect(await db.run((q) => itemPathHintsSteps(q, "item"))).toEqual({
      paths: null,
      brief: null,
    });
    const brief = { issue: { description: "paths: src/a.ts" } };
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.workItem)
          .set({ brief: json(db, brief) as string })
          .where(eq(q.t.workItem.id, "item")),
      ),
    );
    await seed(db, (q) =>
      q.orm.insert(q.t.workItemScheduling).values({
        itemId: "item",
        projectKnown: 0,
        paths: json(db, ["src/a.ts"]) as string,
      }),
    );
    const hints = await db.run((q) => itemPathHintsSteps(q, "item"));
    expect(JSON.parse(hints!.paths!)).toEqual(["src/a.ts"]);
    expect(JSON.parse(hints!.brief!)).toEqual(brief);
  });
});
