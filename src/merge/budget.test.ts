import { describe, expect, test } from "bun:test";
import {
  MAX_REBASE_RETURNS,
  rebaseBudget,
  type RebaseBudget,
  type RebaseConflict,
  type SpentRebaseReturn,
} from "./budget";

const MINUTE = 60_000;
const sha = (n: number) => `${String(n).repeat(7)}${"0".repeat(33)}`;

/** Feeds each conflict through the budget and records it as spent when it goes back to the agent. */
function play(conflicts: readonly RebaseConflict[], spacing = 30 * MINUTE): RebaseBudget[] {
  const spent: SpentRebaseReturn[] = [];
  return conflicts.map((conflict, index) => {
    const now = index * spacing;
    const budget = rebaseBudget(spent, conflict);
    if (budget.allowed) spent.push({ ...conflict, recordedAt: now });
    return budget;
  });
}

describe("rebase budget", () => {
  test("newer main commits do not refill the consecutive budget", () => {
    const results = play(
      [1, 2, 3, 4].map((n) => ({ base: sha(n), files: ["src/loop/orchestrator.ts"] })),
    );
    expect(results.map((result) => (result.allowed ? result.spent : -1))).toEqual([0, 1, 2, -1]);
  });

  test("conflicts on the same main commit fail once the budget is spent", () => {
    const conflict = { base: sha(1), files: ["src/index.ts", "src/loop/orchestrator.ts"] };
    const results = play(Array.from({ length: MAX_REBASE_RETURNS + 1 }, () => conflict));
    expect(results.slice(0, MAX_REBASE_RETURNS).every((result) => result.allowed)).toBe(true);
    expect(results.at(-1)).toEqual({
      allowed: false,
      message: `The branch still conflicts with main after ${MAX_REBASE_RETURNS} attempts to resolve the conflict. Main commits: 1111111. Conflicting files: src/index.ts, src/loop/orchestrator.ts.`,
    });
  });

  test("a newer main cannot refill a spent budget", () => {
    const old = { base: sha(1), files: ["a.ts"] };
    const results = play([old, old, old, { base: sha(2), files: ["a.ts"] }]);
    expect(results.at(-1)?.allowed).toBe(false);
  });

  test("unknown main and missing timestamps cannot refill the per-item budget", () => {
    const unknown = { base: null, files: null, recordedAt: null };
    expect(rebaseBudget(Array(MAX_REBASE_RETURNS).fill(unknown), unknown)).toEqual({
      allowed: false,
      message: `The branch still conflicts with main after ${MAX_REBASE_RETURNS} attempts to resolve the conflict.`,
    });
  });

  test("mixed known and unknown main returns share the limit even days apart", () => {
    const conflicts = [
      { base: null, files: ["a.ts"] },
      { base: sha(1), files: ["b.ts"] },
      { base: null, files: null },
      { base: sha(2), files: ["c.ts"] },
    ];
    expect(play(conflicts, 24 * 60 * MINUTE).map((result) => result.allowed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
