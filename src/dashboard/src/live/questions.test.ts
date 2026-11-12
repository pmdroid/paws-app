import { afterEach, describe, expect, test } from "bun:test";
import {
  applyWorkItemEvent,
  beginImplementRun,
  insertLinkAsk,
  insertQueuedItem,
  type Db,
} from "../../../db";
import { parseQuestionDetailResponse, parseQuestionListResponse } from "../contract";
import { createLiveStatusProvider } from "./provider";
import { seed } from "../../../../test/dialects";
import { queriesDuring } from "../../../../test/query-log";
import { tempStore } from "../../../../test/pglite";

const NOW = 1_700_000_000_000;

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function database() {
  const { db, close } = await tempStore();
  open.push(close);
  return db;
}

async function asking(
  db: Db,
  id: string,
  session: string,
  question: string,
  kind = "ask",
): Promise<void> {
  await insertQueuedItem(db, {
    id,
    title: `Title of ${id}`,
    sessionKey: session,
    now: NOW - 10_000,
  });
  await beginImplementRun(db, id, NOW - 9_000);
  await applyWorkItemEvent(db, id, "blocking_question");
  await seed(db, (q) =>
    q.orm.insert(q.t.question).values({
      id: question,
      itemId: id,
      sessionId: session,
      kind,
      body: `Which way for ${id}?`,
      options: ["Left", "Right"],
      status: "open",
      createdAt: NOW - 8_000,
    }),
  );
}

function provider(db: Db, sessionIds?: readonly string[]) {
  return createLiveStatusProvider(db, {
    now: () => new Date(NOW),
    env: {},
    ...(sessionIds === undefined ? {} : { sessionIds }),
  });
}

async function tablesRead(db: Db, read: () => Promise<unknown>): Promise<Set<string>> {
  const tables = new Set<string>();
  for (const query of await queriesDuring(db, read))
    for (const match of query.matchAll(/\b(?:FROM|JOIN)\s+"?([a-z_]+)/gi)) tables.add(match[1]!);
  return tables;
}

describe("question resources", () => {
  test("the list carries the snapshot's open questions with the issue each card names", async () => {
    const db = await database();
    await asking(db, "ENG-1", "s1", "q-1");
    await asking(db, "ENG-2", "s1b", "q-2", "link");
    await insertLinkAsk(db, {
      questionId: "q-2",
      itemId: "ENG-2",
      kind: "risk",
      headCommit: "a".repeat(40),
      link: "https://paws.example/status/issues/ENG-2#risk",
      title: "High-risk paths changed.",
      detail: "Approve or request changes.",
      answerers: ["delegator"],
      createdAt: NOW - 8_000,
    });
    await asking(db, "ENG-3", "s2", "q-3");
    const live = provider(db, ["s1", "s1b"]);
    const parsed = parseQuestionListResponse(JSON.parse(JSON.stringify(await live.questions())));
    if (!parsed.ok) throw new Error(parsed.error);
    const list = parsed.response;
    expect(Object.keys(list).sort()).toEqual(["generatedAt", "questions", "source"]);
    expect(list.questions.map((question) => question.id)).toEqual(["q-1", "q-2"]);
    for (const card of list.questions) {
      const { issue, ...question } = card;
      const page = (await live.issue(card.itemId))!;
      const shown = page.questions.find((entry) => entry.id === card.id)!;
      const { risk: _risk, bypass: _bypass, ...ask } = shown.linkAsk ?? {};
      expect(question).toEqual({
        ...shown,
        ...(shown.linkAsk ? { linkAsk: ask as typeof shown.linkAsk } : {}),
      });
      const item = page.issue;
      expect(issue).toEqual({ id: item.id, title: item.title, agent: item.agent });
    }
    expect(list.questions[1]?.linkAsk).toMatchObject({ kind: "risk", head: "a".repeat(40) });
  });

  test("a question outside the reader's sessions reads like an unknown one", async () => {
    const db = await database();
    await asking(db, "ENG-1", "s1", "q-1");
    await asking(db, "ENG-2", "s2", "q-2");
    const live = provider(db, ["s1"]);
    const parsed = parseQuestionDetailResponse(
      JSON.parse(JSON.stringify(await live.question("q-1"))),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.response.question).toMatchObject({
      id: "q-1",
      itemId: "ENG-1",
      issue: { id: "ENG-1", title: "Title of ENG-1" },
    });
    expect(await live.question("q-2")).toBeNull();
    expect(await live.question("q-404")).toBeNull();
    expect((await provider(db, []).questions()).questions).toEqual([]);
    expect((await provider(db, ["s2"]).question("q-2"))?.question.itemId).toBe("ENG-2");
  });

  test("the list reads no Closeout, evidence, merge, CI or delivery rows", async () => {
    const db = await database();
    await asking(db, "ENG-1", "s1", "q-1");
    const live = provider(db, ["s1"]);
    const unread = [
      "closeout_progress",
      "closeout_round",
      "evidence",
      "ci_round",
      "merge_queue",
      "outbox",
      "job",
    ];
    const page = await tablesRead(db, () => live.issue("ENG-1"));
    expect(unread.filter((table) => page.has(table)).length).toBeGreaterThan(3);
    const questions = await tablesRead(db, () => live.questions());
    const detail = await tablesRead(db, () => live.question("q-1"));
    for (const table of unread) {
      expect(questions.has(table)).toBe(false);
      expect(detail.has(table)).toBe(false);
    }
    expect(questions.has("question")).toBe(true);
  });
});
