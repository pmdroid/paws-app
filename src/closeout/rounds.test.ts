import { expect, test } from "bun:test";
import { bugClass, summarizeReviewRounds, UNCLASSIFIED } from "./rounds";
import type { Finding } from "./types";

function finding(location: string, explanation: string): Finding {
  return { severity: "P1", location, explanation, evidence: "seen" };
}

test("the class of bug is what the explanation starts with", () => {
  expect(bugClass("unchecked null: the handler reads user.id before the guard")).toBe(
    "unchecked null",
  );
  expect(bugClass("Missing await — the write races the read")).toBe("missing await");
  expect(bugClass("Race condition. Two writers commit at once.")).toBe("race condition");
  expect(bugClass("")).toBe(UNCLASSIFIED);
  expect(bugClass(`${"x".repeat(80)}: too long to be a class`)).toBe(UNCLASSIFIED);
});

test("rounds follow the heads in order, and the open findings are the last round's", () => {
  const summary = summarizeReviewRounds([
    {
      itemId: "independent-review",
      head: "aaa",
      attempt: 1,
      findings: [
        finding("src/a.ts:1", "unchecked null: a"),
        finding("src/b.ts:2", "missing await: b"),
      ],
    },
    {
      itemId: "security-review",
      head: "aaa",
      attempt: 1,
      findings: [finding("src/c.ts:3", "unchecked null: c")],
    },
    { itemId: "independent-review", head: "bbb", attempt: 2, findings: [] },
    // A retried review of the same head counts its latest attempt only.
    {
      itemId: "independent-review",
      head: "bbb",
      attempt: 3,
      findings: [finding("src/a.ts:4", "missing await: d")],
    },
    {
      itemId: "independent-review",
      head: "ccc",
      attempt: 4,
      findings: [finding("src/a.ts:9", "Unchecked null: e"), finding("src/z.ts:1", "")],
    },
  ]);
  expect(summary.rounds).toEqual([
    { head: "aaa", findings: 3 },
    { head: "bbb", findings: 1 },
    { head: "ccc", findings: 2 },
  ]);
  expect(summary.open).toEqual([
    { severity: "P1", location: "src/a.ts:9", bugClass: "unchecked null" },
    { severity: "P1", location: "src/z.ts:1", bugClass: UNCLASSIFIED },
  ]);
  expect(summary.bugClass).toBe("unchecked null");
});

test("no review records means no rounds and no class", () => {
  expect(summarizeReviewRounds([])).toEqual({ rounds: [], open: [], bugClass: null });
});
