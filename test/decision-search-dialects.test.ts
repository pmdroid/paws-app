import { afterEach, expect, test } from "bun:test";
import {
  correctDecisionMemorySteps,
  insertDecisionMemorySteps,
  replaceDecisionSearchSteps,
  retireDecisionMemorySteps,
  searchDecisionRowsSteps,
  type Db,
} from "../src/db";
import { suggestDecisionsSteps } from "../src/decisions";
import {
  forEachDialect,
  insertWorkItem,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

const FIXTURE = [
  ["d01", "Cursor pagination, always cursor pagination.", ["api"]],
  ["d02", "List endpoints return cursor pagination metadata.", ["api"]],
  ["d03", "Cursor pagination replaces offset queries.", ["pagination"]],
  ["d04", "Offset queries stay in the admin export, never a cursor.", ["export"]],
  ["d05", "Keep merge retries in config.toml under the merge section.", ["settings"]],
  ["d06", "Migrations are append-only.", ["database", "migrations"]],
  ["d07", "Rotate secrets every ninety days.", ["security"]],
  ["d08", "Column names use snake_case in the database schema.", ["database"]],
  ["d09", "Cache responses in src/api/cache.ts for sixty seconds.", ["performance"]],
  ["d10", "Dashboard pages read their own resource.", ["dashboard"]],
] as const;

/** Each query's top three, best first. Decisions in one inner list may come in either order. */
const QUERIES: [string, string[][]][] = [
  ['"cursor" OR "pagination"', [["d01"], ["d02", "d03"]]],
  ['"database"', [["d06", "d08"]]],
  ['"config" OR "secrets"', [["d05", "d07"]]],
  ['"performance" OR "cache"', [["d09"]]],
  ['"offset" OR "queries" OR "export"', [["d04"], ["d03"]]],
];

function save(db: Db, [id, statement, tags]: (typeof FIXTURE)[number], now = 1) {
  return db.run(function* (q) {
    const text = { statement, tags: JSON.stringify(tags), globs: '["**"]' };
    yield* insertDecisionMemorySteps(q, {
      ...text,
      id,
      questionId: `question-${id}`,
      workspaceId: "w",
      userId: "ada",
      now,
    });
    yield* replaceDecisionSearchSteps(q, { id, statement: text.statement, tags: text.tags });
  });
}

async function saveFixture(db: Db) {
  for (const decision of FIXTURE) {
    await seed(db, (q) =>
      q.orm.insert(q.t.question).values({
        id: `question-${decision[0]}`,
        itemId: "item",
        sessionId: "session",
        body: "body",
        status: "answered",
        answer: "answer",
        answeredBy: "ada",
        createdAt: 0,
      }),
    );
    await save(db, decision);
  }
}

const search = (db: Db, query: string, options: { activeOnly?: boolean } = {}) =>
  db
    .run((q) => searchDecisionRowsSteps(q, { workspaceId: "w", query, limit: 200, ...options }))
    .then((rows) => rows.map((row) => row.id));

forEachDialect((connect) => {
  test("the same queries find the same top three decisions, in rank order", async () => {
    const db = await connected(connect);
    await saveFixture(db);
    for (const [query, tiers] of QUERIES) {
      const top = (await search(db, query)).slice(0, 3);
      const tier = (id: string) => tiers.findIndex((members) => members.includes(id));
      expect(top.toSorted()).toEqual(tiers.flat().toSorted());
      expect(top.map(tier)).toEqual(top.map(tier).toSorted());
    }
  });

  test("a corrected decision is found by its new text, and only a retired one is left out of active search", async () => {
    const db = await connected(connect);
    await saveFixture(db);
    await db.run(function* (q) {
      const change = { statement: "Rotate tokens hourly.", tags: '["auth"]' };
      yield* correctDecisionMemorySteps(q, {
        ...change,
        id: "d07",
        userId: "ada",
        now: 2,
        globs: '["**"]',
      });
      yield* replaceDecisionSearchSteps(q, { ...change, id: "d07" });
    });
    expect(await search(db, '"secrets"')).toEqual([]);
    expect(await search(db, '"auth"')).toEqual(["d07"]);
    await db.run((q) => retireDecisionMemorySteps(q, { id: "d07", userId: "ada", now: 3 }));
    expect(await search(db, '"auth"')).toEqual(["d07"]);
    expect(await search(db, '"auth"', { activeOnly: true })).toEqual([]);
  });

  test("search stays inside the workspace", async () => {
    const db = await connected(connect);
    await saveFixture(db);
    expect(
      await db.run((q) =>
        searchDecisionRowsSteps(q, { workspaceId: "other", query: '"cursor"', limit: 200 }),
      ),
    ).toEqual([]);
  });

  test("suggestDecisions offers the best active candidates and records them", async () => {
    const db = await connected(connect);
    await insertWorkItem(db, "item");
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
          appUserId: "app",
          installationObservedAt: 5,
          createdAt: 0,
        }),
      (q) =>
        q.orm
          .insert(q.t.workItemRepository)
          .values({ itemId: "item", owner: "Acme", repo: "App", remoteUrl: "https://x.invalid" }),
      (q) =>
        q.orm
          .insert(q.t.workspaceRepository)
          .values({ workspaceId: "w", repository: "acme/app", teamId: "team" }),
      (q) =>
        q.orm.insert(q.t.question).values({
          id: "asked",
          itemId: "item",
          sessionId: "session",
          body: "Which pagination?",
          status: "open",
          createdAt: 1,
        }),
    );
    await saveFixture(db);
    await db.run((q) => retireDecisionMemorySteps(q, { id: "d03", userId: "ada", now: 3 }));
    const offered = await db.run((q) =>
      suggestDecisionsSteps(q, "asked", "Which cursor pagination format?"),
    );
    expect(offered.map((decision) => decision.id).toSorted()).toEqual(["d01", "d02", "d04"]);
    expect(offered[0]!.id).toBe("d01");
    expect(offered[0]!.value).toMatch(/^\/paws decision [a-f0-9-]{36}$/);
    expect(await db.run((q) => suggestDecisionsSteps(q, "asked", "zz"))).toEqual([]);
  });
});
