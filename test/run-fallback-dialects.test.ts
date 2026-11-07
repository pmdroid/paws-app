import { expect, test } from "bun:test";
import {
  closeFallbackAttemptsSteps,
  fallbackHistorySteps,
  insertRunSteps,
  recordFallbackAttemptSteps,
  type FallbackOutcome,
} from "../src/db";
import {
  forEachDialect,
  insertWorkItem,
  withoutForeignKeys,
  insertRunnerBindingSteps,
} from "./dialects";

forEachDialect((open) => {
  test("fallback attempts number per call, name the run's account, and close together", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await insertWorkItem(db, "item");
      const run = await db.run((q) => insertRunSteps(q, { itemId: "item", now: 1 }));
      await db.run(function* (q) {
        yield* insertRunnerBindingSteps(q);
        yield* q.exec(
          q.orm.insert(q.t.runnerWork).values({
            runId: run.id,
            runnerId: "box",
            workspaceId: "acme",
            generation: 2,
            runnerFence: 0,
            commandId: "work",
            leaseUntil: 100,
          }),
        );
        yield* q.exec(
          q.orm.insert(q.t.runnerCommand).values({
            id: "command",
            runnerId: "box",
            runId: run.id,
            generation: 2,
            kind: "run",
            envelope: "{}",
            expiresAt: 100,
          }),
        );
        yield* q.exec(
          q.orm.insert(q.t.runnerCommandAccount).values({
            commandId: "command",
            workspaceId: "acme",
            runnerId: "box",
            agent: "codex",
            accountId: "account",
            bindingId: "binding",
            named: 1,
            recordedAt: 1,
          }),
        );
      });
      const record = (outcome: FallbackOutcome, excludedKey: string, runId = run.id) =>
        db.transaction((q) =>
          recordFallbackAttemptSteps(q, {
            runId,
            callId: "call",
            policyKey: "policy",
            outcome,
            runnerId: "box",
            excludedKey,
            now: 5,
          }),
        );
      expect(await record("failed", "box")).toBe(true);
      expect(await record("usage_limit", "account")).toBe(true);
      expect(await record("failed", "box")).toBe(false);
      expect(await record("handed_over", "other")).toBe(true);
      expect(await record("failed", "box", "missing")).toBe(false);
      const attempts = await db.run((q) =>
        q.all(
          q.orm
            .select({
              ordinal: q.t.runFallbackAttempt.ordinal,
              generation: q.t.runFallbackAttempt.generation,
              accountId: q.t.runFallbackAttempt.accountId,
              bindingId: q.t.runFallbackAttempt.bindingId,
            })
            .from(q.t.runFallbackAttempt),
        ),
      );
      expect(attempts.toSorted((a, b) => a.ordinal - b.ordinal)).toEqual(
        [1, 2, 3].map((ordinal) => ({
          ordinal,
          generation: 2,
          accountId: "account",
          bindingId: "binding",
        })),
      );
      expect(await db.run((q) => fallbackHistorySteps(q, run.id, "call", "policy"))).toEqual({
        excluded: ["box", "account", "other"],
        failures: 1,
        usageLimits: 1,
      });
      expect(await db.run((q) => fallbackHistorySteps(q, run.id, "call", "other"))).toEqual({
        excluded: [],
        failures: 0,
        usageLimits: 0,
      });
      await db.run((q) => closeFallbackAttemptsSteps(q, run.id, "call", 9));
      expect(await db.run((q) => fallbackHistorySteps(q, run.id, "call", "policy"))).toEqual({
        excluded: [],
        failures: 0,
        usageLimits: 0,
      });
    } finally {
      await close();
    }
  });
});
