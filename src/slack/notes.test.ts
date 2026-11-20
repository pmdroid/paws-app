import { expect, test } from "bun:test";
import type { SlackNote } from "../db";
import { estimateContextTokens } from "../project-context";
import { SLACK_CONTEXT_TOKENS } from "./memory";
import { slackNotesText, slackPrompt, splitSlackNotes } from "./notes";

const note = (id: number, text: string, extra: Partial<SlackNote> = {}): SlackNote => ({
  id: String(id).padStart(26, "0"),
  conversationId: "c",
  workspaceId: "W1",
  requestId: `r${id}`,
  authorUserId: "um",
  kind: "observation",
  text,
  repository: null,
  path: null,
  symbol: null,
  commit: null,
  sources: [],
  linearTeamIds: [],
  createdAt: id,
  ...extra,
});

test("with more notes than fit, one naming a symbol from the question goes before newer ones", () => {
  const older = note(1, `canary-symbol ${"y".repeat(20_000)}`, {
    repository: "acme/app",
    symbol: "chargeCustomer",
  });
  const filler = Array.from({ length: 12 }, (_, index) => note(index + 2, "x".repeat(20_000)));
  const { text, included } = slackNotesText(
    [older, ...filler],
    "where is chargeCustomer?",
    new Map(),
  );
  expect(included[0]).toBe(older);
  expect(estimateContextTokens(text)).toBeLessThanOrEqual(SLACK_CONTEXT_TOKENS * 0.4);
  expect(estimateContextTokens(text)).toBeGreaterThan(SLACK_CONTEXT_TOKENS * 0.35);
  expect(text).toContain("canary-symbol");
  expect(included.map((kept) => kept.id)).toEqual(
    [older, ...filler.slice(-included.length + 1).reverse()].map((kept) => kept.id),
  );
  expect(included.length).toBeLessThan(13);
  expect(slackNotesText([older, ...filler], "how?", new Map()).text).not.toContain("canary-symbol");
});

test("a prompt past 32,768 bytes is sent whole; past half the context window it drops the lowest-ranked notes first", () => {
  const notes = Array.from({ length: 6 }, (_, index) =>
    note(index + 1, `n${index} ${"x".repeat(20_000)}`),
  );
  const thread = "[<@S1>]: how?";
  const roomy = slackPrompt({
    head: "Answer.\n\n",
    notes,
    question: "how?",
    commits: new Map(),
    thread,
  });
  expect(Buffer.byteLength(roomy.prompt)).toBeGreaterThan(32_768);
  expect(roomy.notes).toHaveLength(6);
  expect(roomy.prompt).toEndWith(thread);
  const head = `Answer.\n\n${"m".repeat(140_000)}\n\n`;
  const tight = slackPrompt({ head, notes, question: "how?", commits: new Map(), thread });
  expect(estimateContextTokens(tight.prompt)).toBeLessThan(SLACK_CONTEXT_TOKENS / 2);
  expect(tight.notes.map((kept) => kept.text.slice(0, 2))).toEqual(["n5", "n4"]);
  expect(tight.prompt).toEndWith(thread);
  const full = slackPrompt({
    head: `${"m".repeat(250_000)}`,
    notes,
    question: "how?",
    commits: new Map(),
    thread,
  });
  expect(full.notes).toEqual([]);
  expect(full.prompt).not.toContain(thread);
});

test("a note shows its commit only when it differs from the run's commit for its repository", () => {
  const at = note(1, "same", { repository: "acme/app", path: "a.ts", commit: "a".repeat(40) });
  const old = note(2, "old", { repository: "acme/app", path: "a.ts", commit: "b".repeat(40) });
  const { text } = slackNotesText([at, old], "q", new Map([["acme/app", "a".repeat(40)]]));
  expect(text).toContain("- [observation] acme/app a.ts: same");
  expect(text).toContain("- [observation] acme/app a.ts (at bbbbbbbbbbbb): old");
});

test("the notes block is removed whether or not it parses", () => {
  expect(splitSlackNotes('Hi.\n```paws-notes\n[{"kind":"guess","text":"t"}]\n```')).toEqual({
    answer: "Hi.",
    notes: [{ kind: "guess", text: "t", repository: null, path: null, symbol: null }],
  });
  for (const text of [
    "Hi.\n```paws-notes\n{}\n```",
    "Hi.\n```paws-notes\n[]\n```\nafter",
    "Hi.\n```paws-notes",
  ])
    expect(splitSlackNotes(text)).toEqual({ answer: "Hi.", notes: null });
  expect(splitSlackNotes("Hi.")).toEqual({ answer: "Hi.", notes: null });
});
