import { expect, test } from "bun:test";
import type { LinkAsk, LinkAskRounds } from "../db";
import { linkAskHandoff, reviewRoundsDetail } from "./link-ask";

const ROUNDS: LinkAskRounds = {
  rounds: [
    { head: "aaa", findings: 2 },
    { head: "bbb", findings: 4 },
  ],
  open: [
    { severity: "P1", location: "src/a.ts:1", bugClass: "caller drift", sentence: "One." },
    { severity: "P1", location: "src/a.ts:2", bugClass: "caller drift", sentence: "Two." },
    { severity: "P2", location: "src/b.ts:3", bugClass: "race", sentence: "Three." },
    { severity: "P2", location: "src/b.ts:4", bugClass: "race", sentence: "Four." },
  ],
  bugClass: null,
  limit: 4,
  handoff: "",
};

function rethink(rounds: LinkAskRounds): string {
  const ask = { kind: "rounds", headCommit: "bbb", rounds } as LinkAsk;
  return linkAskHandoff(ask, { decision: "rethink", note: null });
}

test("a named class that an open finding has leads the detail and the rethink note", () => {
  const rounds = { ...ROUNDS, bugClass: "race" };
  expect(reviewRoundsDetail(rounds)).toBe(
    'The independent review failed 2 rounds and 4 findings are still open. The class of bug that keeps coming back is "race" (2 of 4 open findings). Rethink the approach, keep going, or stop.',
  );
  expect(rethink(rounds)).toContain("find what the findings have in common (most are race), and");
});

test("without a class the open findings lead, up to three", () => {
  for (const rounds of [ROUNDS, { ...ROUNDS, bugClass: "host driver" }]) {
    expect(reviewRoundsDetail(rounds)).toBe(
      "The independent review failed 2 rounds and 4 findings are still open. Open findings: P1 at src/a.ts:1: One; P1 at src/a.ts:2: Two; P2 at src/b.ts:3: Three; and 1 more. Rethink the approach, keep going, or stop.",
    );
    expect(rethink(rounds)).toContain(
      "find what the findings have in common (start from the open findings: P1 at src/a.ts:1: One; P1 at src/a.ts:2: Two; P2 at src/b.ts:3: Three; and 1 more), and",
    );
  }
});
