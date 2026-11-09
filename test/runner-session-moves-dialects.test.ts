import { expect, test } from "bun:test";
import {
  clearRunnerSessionMoveSteps,
  currentRunnerAgentVersionSteps,
  lastRunCommandAccountSteps,
  latestSealedSnapshotSteps,
  noteRunnerSessionMoveSteps,
  requestRunnerSessionMoveSteps,
  runnerSessionMoveSteps,
} from "../src/db";
import { forEachDialect, withoutForeignKeys, insertRunnerBindingSteps } from "./dialects";

const HASH = "a".repeat(64);

forEachDialect((open) => {
  test("a session move is requested, noted and cleared per run and runner", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      const move = () => db.run((q) => runnerSessionMoveSteps(q, "run", "box"));
      expect(await move()).toBeNull();
      await db.run((q) =>
        noteRunnerSessionMoveSteps(q, {
          runId: "run",
          runnerId: "box",
          status: "waiting",
          reason: "no runner",
          now: 1,
        }),
      );
      expect(await move()).toEqual({ status: "waiting", reason: "no runner" });
      await db.run((q) =>
        requestRunnerSessionMoveSteps(q, { runId: "run", runnerId: "box", userId: "u", now: 2 }),
      );
      expect(await move()).toEqual({ status: "moving", reason: null });
      expect(await db.run((q) => runnerSessionMoveSteps(q, "run", "other"))).toBeNull();
      await db.run((q) => clearRunnerSessionMoveSteps(q, "run", "other"));
      expect(await move()).not.toBeNull();
      await db.run((q) => clearRunnerSessionMoveSteps(q, "run", "box"));
      expect(await move()).toBeNull();
    } finally {
      await close();
    }
  });

  test("a move reads the latest sealed snapshot, the run's account and the runner's agent", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await db.run(function* (q) {
        yield* insertRunnerBindingSteps(q);
        for (const [generation, status] of [
          [1, "sealed"],
          [2, "sealed"],
          [3, "uploading"],
        ] as const)
          yield* q.exec(
            q.orm.insert(q.t.agentSessionSnapshot).values({
              runId: "run",
              generation,
              itemId: "item",
              workspaceId: "acme",
              runnerId: "box",
              ownerUserId: "u",
              agent: "codex",
              agentVersion: "1.0",
              sessionId: `session-${generation}`,
              workspacePath: "/work",
              commitSha: "sha",
              turn: generation,
              sizeBytes: 10,
              sealedSize: status === "sealed" ? 10 : null,
              sha256: HASH,
              status,
              createdAt: generation,
              sealedAt: status === "sealed" ? generation : null,
            }),
          );
        for (const [id, kind, accountId] of [
          ["first", "run", "a"],
          ["second", "run", "b"],
          ["third", "review", "c"],
        ] as const) {
          yield* q.exec(
            q.orm.insert(q.t.agentAccountBinding).values({
              id: `binding-${accountId}`,
              workspaceId: "acme",
              accountId,
              agent: "codex",
              runnerId: "box",
              quotaScope: "unknown",
              createdAt: 0,
            }),
          );
          yield* q.exec(
            q.orm.insert(q.t.runnerCommand).values({
              id,
              runnerId: "box",
              runId: "run",
              generation: 1,
              kind,
              envelope: "{}",
              expiresAt: 100,
            }),
          );
          yield* q.exec(
            q.orm.insert(q.t.runnerCommandAccount).values({
              commandId: id,
              workspaceId: "acme",
              runnerId: "box",
              agent: "codex",
              accountId,
              bindingId: `binding-${accountId}`,
              named: 1,
              recordedAt: 1,
            }),
          );
        }
        for (const [version, status] of [
          ["1.0", "previous"],
          ["2.0", "current"],
        ] as const)
          yield* q.exec(
            q.orm
              .insert(q.t.runnerAgent)
              .values({ runnerId: "box", agent: "codex", version, status, reportedAt: 1 }),
          );
      });
      expect(await db.run((q) => latestSealedSnapshotSteps(q, "run"))).toEqual({
        generation: 2,
        runnerId: "box",
        ownerUserId: "u",
        agent: "codex",
        agentVersion: "1.0",
        sessionId: "session-2",
        commitSha: "sha",
        turn: 2,
        sealedSize: 10,
        sha256: HASH,
      });
      expect(await db.run((q) => latestSealedSnapshotSteps(q, "other"))).toBeNull();
      expect(await db.run((q) => lastRunCommandAccountSteps(q, "run", 1))).toEqual({
        accountId: "b",
        named: 1,
      });
      expect(await db.run((q) => lastRunCommandAccountSteps(q, "run", 2))).toBeNull();
      expect(await db.run((q) => currentRunnerAgentVersionSteps(q, "box", "codex"))).toBe("2.0");
      expect(await db.run((q) => currentRunnerAgentVersionSteps(q, "box", "claude"))).toBeNull();
    } finally {
      await close();
    }
  });
});
