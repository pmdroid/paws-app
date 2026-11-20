import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  addSlackNotesSteps,
  recordSlackConversationSteps,
  slackNotesSteps,
  type Db,
  type SlackNoteInput,
} from "./index";
import { tempStore } from "../../test/pglite";

let db: Db;
let close: () => Promise<void>;
let conversationId: string;

const thread = {
  workspaceId: "w",
  teamId: "T",
  installGeneration: 1,
  channelId: "C",
  threadTs: "1.0",
  appId: null,
  slackUserId: "U",
  eventId: "E",
};

const run = {
  workspaceId: "w",
  authorUserId: "member",
  sources: [{ repository: "o/r", ref: "main", commit: "abc" }],
  linearTeamIds: ["team"],
};

const note = (text: string, extra: Partial<SlackNoteInput> = {}): SlackNoteInput => ({
  kind: "observation",
  text,
  repository: null,
  path: null,
  symbol: null,
  commit: null,
  ...extra,
});

beforeEach(async () => {
  ({ db, close } = await tempStore());
  conversationId = (await db.run((q) => recordSlackConversationSteps(q, thread, 1))).id;
});

afterEach(() => close());

function add(requestId: string, notes: SlackNoteInput[], now = 10) {
  return db.run((q) => addSlackNotesSteps(q, { ...run, conversationId, requestId, notes, now }));
}

test("notes come back oldest first with every field", async () => {
  const located = { repository: "o/r", path: "src/a.ts", symbol: "f", commit: "abc" };
  expect(await add("r1", [note("first", located), note("second", { kind: "guess" })], 10)).toBe(2);
  expect(await add("r2", [note("third", { kind: "decision" })], 20)).toBe(1);
  const notes = await db.run((q) => slackNotesSteps(q, conversationId));
  expect(notes.map((n) => [n.text, n.kind, n.requestId])).toEqual([
    ["first", "observation", "r1"],
    ["second", "guess", "r1"],
    ["third", "decision", "r2"],
  ]);
  expect(notes[0]).toEqual({
    ...run,
    ...located,
    id: expect.any(String),
    conversationId,
    requestId: "r1",
    kind: "observation",
    text: "first",
    createdAt: 10,
  });
});

test("a run stores at most 16 notes, 1,024 bytes each and 16,384 bytes in all", async () => {
  const many = Array.from({ length: 17 }, (_, i) => note(`n${i}`));
  expect(await add("count", many)).toBe(16);
  const big = [
    note(""),
    note("é".repeat(513)),
    ...Array.from({ length: 16 }, () => note("x".repeat(1024))),
  ];
  expect(await add("bytes", big)).toBe(16);
  const notes = await db.run((q) => slackNotesSteps(q, conversationId));
  const stored = (id: string) => notes.filter((n) => n.requestId === id).map((n) => n.text);
  expect(stored("count")).toEqual(many.slice(0, 16).map((n) => n.text));
  expect(stored("bytes").join("").length).toBe(16384);
});

test("a second add for the same request stores nothing", async () => {
  expect(await add("r1", [note("one")])).toBe(1);
  expect(await add("r1", [note("two")])).toBe(0);
  const notes = await db.run((q) => slackNotesSteps(q, conversationId));
  expect(notes.map((n) => n.text)).toEqual(["one"]);
});

test("a kind outside the three is refused", async () => {
  const bad = note("x", { kind: "rumour" as SlackNoteInput["kind"] });
  const error = await add("r1", [bad]).catch((caught: Error) => caught);
  expect(String((error as Error).cause)).toContain("slack_thread_note_kind");
});
