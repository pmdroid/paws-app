import { afterEach, expect, test } from "bun:test";
import {
  blockConversationSteps,
  clearConversationBlockSteps,
  closeLinkAskSteps,
  getConversationSteps,
  getLinkAskSteps,
  insertLinkAskSteps,
  listBlockedConversationsSteps,
  listLinkAsksSteps,
  openLinkAsksSteps,
  recordLinkAskDecisionSteps,
  saveConversationSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem, withoutForeignKeys, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  return handle.db;
}

const ask = (questionId: string, createdAt: number) => ({
  questionId,
  itemId: "item",
  kind: "risk" as const,
  headCommit: "head",
  link: `https://paws/${questionId}`,
  title: "Approve",
  detail: "High-risk paths",
  answerers: ["lead", "delegator"],
  createdAt,
});

forEachDialect((open) => {
  test("a link ask is decided once, and closing keeps its note", async () => {
    const db = await connect(open);
    await withoutForeignKeys(db);
    const rounds = {
      rounds: [{ head: "h1", findings: 2 }],
      open: [{ severity: "high", location: "a.ts:1", bugClass: "race" }],
      bugClass: "race",
      limit: 3,
      handoff: "fix it",
    };
    const first = await db.run((q) => insertLinkAskSteps(q, { ...ask("q2", 5), rounds }));
    expect(first).toEqual({
      ...ask("q2", 5),
      decision: null,
      note: null,
      decidedBy: null,
      decidedAt: null,
      closedReason: null,
      closedAt: null,
      rounds,
    });
    await db.run((q) => insertLinkAskSteps(q, ask("q1", 5)));
    await db.run((q) => insertLinkAskSteps(q, ask("q0", 9)));
    expect((await db.run((q) => getLinkAskSteps(q, "q1")))?.rounds).toBeNull();
    expect(await db.run((q) => getLinkAskSteps(q, "missing"))).toBeNull();

    const decision = { decision: "approve" as const, note: null, decidedBy: "lead", now: 10 };
    expect(await db.run((q) => recordLinkAskDecisionSteps(q, "q1", decision))).toBe(true);
    expect(await db.run((q) => recordLinkAskDecisionSteps(q, "q1", decision))).toBe(false);
    expect(await db.run((q) => closeLinkAskSteps(q, "q2", { reason: "head_moved", now: 11 }))).toBe(
      true,
    );
    expect(
      await db.run((q) =>
        closeLinkAskSteps(q, "q0", { reason: "guidance", note: "try again", by: "lead", now: 12 }),
      ),
    ).toBe(true);
    expect(await db.run((q) => closeLinkAskSteps(q, "q0", { reason: "cancelled", now: 13 }))).toBe(
      false,
    );

    const all = await db.run((q) => listLinkAsksSteps(q, "item"));
    expect(all.map((row) => [row.questionId, row.closedReason, row.note, row.decidedBy])).toEqual([
      ["q1", "decided", null, "lead"],
      ["q2", "head_moved", null, null],
      ["q0", "guidance", "try again", "lead"],
    ]);
    expect(await db.run((q) => openLinkAsksSteps(q, "item"))).toEqual([]);
    await db.run((q) => insertLinkAskSteps(q, ask("q3", 20)));
    expect(
      (await db.run((q) => openLinkAsksSteps(q, "item"))).map((row) => row.questionId),
    ).toEqual(["q3"]);
  });

  test("a conversation's block only rises on save and clears by its time", async () => {
    const db = await connect(open);
    await insertWorkItem(db, "a");
    await insertWorkItem(db, "b");
    expect(await db.run((q) => getConversationSteps(q, "a"))).toEqual({
      entries: "[]",
      transcript: null,
      transcriptOffset: 0,
      blocked: false,
      blockedAt: null,
    });
    await db.run((q) => saveConversationSteps(q, "a", '["one"]', "t", false, 4));
    expect(await db.run((q) => getConversationSteps(q, "a"))).toEqual({
      entries: '["one"]',
      transcript: "t",
      transcriptOffset: 4,
      blocked: false,
      blockedAt: null,
    });
    await db.run((q) => blockConversationSteps(q, "a", 100));
    await db.run((q) => blockConversationSteps(q, "a", 200));
    await db.run((q) => saveConversationSteps(q, "a", '["two"]', null));
    expect(await db.run((q) => getConversationSteps(q, "a"))).toEqual({
      entries: '["two"]',
      transcript: null,
      transcriptOffset: 0,
      blocked: true,
      blockedAt: 100,
    });
    await db.run((q) => blockConversationSteps(q, "b", 50));
    expect(await db.run((q) => listBlockedConversationsSteps(q))).toEqual([
      { itemId: "a", blockedAt: 100 },
      { itemId: "b", blockedAt: 50 },
    ]);
    expect(await db.run((q) => clearConversationBlockSteps(q, "a", 200))).toBe(false);
    expect(await db.run((q) => clearConversationBlockSteps(q, "a", 100))).toBe(true);
    expect(await db.run((q) => clearConversationBlockSteps(q, "a"))).toBe(false);
    expect(await db.run((q) => clearConversationBlockSteps(q, "b", null))).toBe(true);
    expect(await db.run((q) => listBlockedConversationsSteps(q))).toEqual([]);
  });
});
