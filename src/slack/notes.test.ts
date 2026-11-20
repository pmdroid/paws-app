import { expect, test } from "bun:test";
import type { SlackNote } from "../db";
import { slackNotesText, splitSlackNotes } from "./notes";

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
  const older = note(1, `canary-symbol ${"y".repeat(900)}`, {
    repository: "acme/app",
    symbol: "chargeCustomer",
  });
  const filler = Array.from({ length: 12 }, (_, index) => note(index + 2, "x".repeat(900)));
  const text = slackNotesText([older, ...filler], "where is chargeCustomer?", new Map());
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8_000);
  expect(text).toContain("canary-symbol");
  expect(text.split("\n").filter((line) => line.startsWith("- ")).length).toBeLessThan(13);
  expect(slackNotesText([older, ...filler], "how?", new Map())).not.toContain("canary-symbol");
});

test("a note shows its commit only when it differs from the run's commit for its repository", () => {
  const at = note(1, "same", { repository: "acme/app", path: "a.ts", commit: "a".repeat(40) });
  const old = note(2, "old", { repository: "acme/app", path: "a.ts", commit: "b".repeat(40) });
  const text = slackNotesText([at, old], "q", new Map([["acme/app", "a".repeat(40)]]));
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
