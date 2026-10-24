import { describe, expect, test } from "bun:test";
import {
  MAX_REBASE_RETURNS,
  MAX_REBASE_RETURNS_PER_HOUR,
  REBASE_RETURN_WINDOW_MS,
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
    const budget = rebaseBudget(spent, conflict, now);
    if (budget.allowed) spent.push({ ...conflict, recordedAt: now });
    return budget;
  });
}

describe("rebase budget", () => {
  test("conflicts each caused by a newer main commit do not fail the task", () => {
    const results = play(
      [1, 2, 3, 4].map((n) => ({ base: sha(n), files: ["src/loop/orchestrator.ts"] })),
    );
    expect(results.every((result) => result.allowed)).toBe(true);
    expect(results.map((result) => (result.allowed ? result.spent : -1))).toEqual([0, 0, 0, 0]);
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

  test("a newer main gives a fresh attempt after repeats on an older one", () => {
    const old = { base: sha(1), files: ["a.ts"] };
    const results = play([old, old, old, { base: sha(2), files: ["a.ts"] }]);
    expect(results.every((result) => result.allowed)).toBe(true);
  });

  test("without a main commit, the same files count as the same conflict", () => {
    const same = { base: null, files: ["a.ts"] };
    expect(play([same, same, same, same]).at(-1)?.allowed).toBe(false);
    const moving = ["a.ts", "b.ts", "c.ts", "d.ts"].map((file) => ({ base: null, files: [file] }));
    expect(play(moving).every((result) => result.allowed)).toBe(true);
  });

  test("returns without a main commit or files count as before", () => {
    const unknown = { base: null, files: null };
    expect(play([unknown, unknown, unknown, unknown]).at(-1)?.allowed).toBe(false);
  });

  test("an hourly cap stops a busy main from looping forever", () => {
    const spacing = REBASE_RETURN_WINDOW_MS / (MAX_REBASE_RETURNS_PER_HOUR + 1);
    const conflicts = Array.from({ length: MAX_REBASE_RETURNS_PER_HOUR + 1 }, (_, n) => ({
      base: sha(n + 1),
      files: [`f${n}.ts`],
    }));
    const results = play(conflicts, spacing);
    expect(results.slice(0, -1).every((result) => result.allowed)).toBe(true);
    const last = results.at(-1)!;
    expect(last.allowed).toBe(false);
    if (!last.allowed) {
      expect(last.message).toStartWith(
        `The branch conflicted with main ${MAX_REBASE_RETURNS_PER_HOUR + 1} times within an hour.`,
      );
      expect(last.message).toContain("7777777");
      expect(last.message).toContain("f6.ts");
    }
    expect(play(conflicts, REBASE_RETURN_WINDOW_MS / 2).every((result) => result.allowed)).toBe(
      true,
    );
  });
});
