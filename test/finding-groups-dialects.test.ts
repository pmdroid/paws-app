import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  activeRunnerOwnersSteps,
  completeFindingGroupRunSteps,
  deleteUntouchedFindingGroupsSteps,
  dropProcessedFindingGroupMembersSteps,
  failFindingGroupRunSteps,
  findingGroupRunExistsForDaySteps,
  findingGroupRunIsRunningSteps,
  heldFindingGroupMembersSteps,
  insertFindingGroupRunSteps,
  insertFindingGroupSteps,
  lastCompletedFindingGroupRunSteps,
  setFindingGroupRunFingerprintSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, withoutForeignKeys, type DialectDb } from "./dialects";

const RUN = { workspaceId: "acme", fingerprint: "print", status: "running" };

function group(id: string, memberIds: number[]) {
  return {
    id,
    workspaceId: "acme",
    repository: "acme/app",
    teamId: "team",
    title: id,
    summary: "summary",
    scope: "scope",
    suggestedIssue: null,
    memberIds,
    createdAt: 1,
    runId: "run",
  };
}

function* runRow(q: Q, id: string) {
  const { findingGroupRun: run } = q.t;
  return yield* q.one(q.orm.select().from(run).where(eq(run.id, id)));
}

function* touch(q: Q, id: string) {
  const { findingGroup: g } = q.t;
  yield* q.exec(q.orm.update(g).set({ action: "file" }).where(eq(g.id, id)));
}

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened: DialectDb = await open();
    try {
      await withoutForeignKeys(opened.db);
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  test("a day's run is claimed once and the newest completed run carries the cursors", () =>
    withDb(async (db) => {
      expect(await db.run((q) => lastCompletedFindingGroupRunSteps(q, "acme"))).toBeNull();
      await db.run((q) =>
        insertFindingGroupRunSteps(q, { ...RUN, id: "old", day: "2026-01-01", startedAt: 1 }),
      );
      await db.run((q) =>
        insertFindingGroupRunSteps(q, {
          ...RUN,
          id: "new",
          day: "2026-01-02",
          startedAt: 2,
          status: "completed",
          groupCount: 3,
          findingCursor: 4,
          issueCursor: 5,
        }),
      );
      expect(await db.run((q) => findingGroupRunExistsForDaySteps(q, "acme", "2026-01-01"))).toBe(
        true,
      );
      expect(await db.run((q) => findingGroupRunExistsForDaySteps(q, "acme", "2026-01-03"))).toBe(
        false,
      );
      expect(await db.run((q) => lastCompletedFindingGroupRunSteps(q, "acme"))).toEqual({
        fingerprint: "print",
        findingCursor: 4,
        issueCursor: 5,
        groupCount: 3,
      });
    }));

  test("only a running run can complete or fail, and a partial one keeps its new fingerprint", () =>
    withDb(async (db) => {
      await db.run((q) =>
        insertFindingGroupRunSteps(q, { ...RUN, id: "run", day: "2026-01-01", startedAt: 1 }),
      );
      await db.run((q) => setFindingGroupRunFingerprintSteps(q, "run", "print:partial"));
      expect(await db.run((q) => findingGroupRunIsRunningSteps(q, "run"))).toBe(true);
      const result = {
        finishedAt: 9,
        tokens: 7,
        groupCount: 2,
        findingCursor: 3,
        issueCursor: 4,
      };
      expect(await db.run((q) => completeFindingGroupRunSteps(q, "run", result))).toBe(true);
      expect(await db.run((q) => findingGroupRunIsRunningSteps(q, "run"))).toBe(false);
      expect(await db.run((q) => completeFindingGroupRunSteps(q, "run", result))).toBe(false);
      await db.run((q) => failFindingGroupRunSteps(q, "run", 10, "late"));
      expect(await db.run((q) => runRow(q, "run"))).toMatchObject({
        status: "completed",
        fingerprint: "print:partial",
        finishedAt: 9,
        tokens: 7,
        error: null,
      });
      await db.run((q) =>
        insertFindingGroupRunSteps(q, { ...RUN, id: "bad", day: "2026-01-02", startedAt: 2 }),
      );
      await db.run((q) => failFindingGroupRunSteps(q, "bad", 11, "broken"));
      expect(await db.run((q) => runRow(q, "bad"))).toMatchObject({
        status: "failed",
        finishedAt: 11,
        error: "broken",
      });
    }));

  test("a partial snapshot drops processed and gone members and keeps claimed groups", () =>
    withDb(async (db) => {
      await db.run((q) => insertFindingGroupSteps(q, group("keeps", [3, 1, 2, 9])));
      await db.run((q) => insertFindingGroupSteps(q, group("empties", [1])));
      await db.run((q) => insertFindingGroupSteps(q, group("claimed", [1, 9])));
      await db.run((q) => touch(q, "claimed"));
      await db.run((q) => dropProcessedFindingGroupMembersSteps(q, "acme", [1], [2, 3]));
      const held = await db.run((q) => heldFindingGroupMembersSteps(q, "acme"));
      expect([...held].sort((a, b) => a - b)).toEqual([1, 2, 3, 9]);
      const kept = await db.run(function* (q) {
        const { findingGroup: g } = q.t;
        return yield* q.all(q.orm.select({ id: g.id, ids: g.memberIds }).from(g).orderBy(g.id));
      });
      const parsed = kept.map((row) => ({
        id: row.id,
        ids: typeof row.ids === "string" ? JSON.parse(row.ids) : row.ids,
      }));
      expect(parsed).toEqual([
        { id: "claimed", ids: [1, 9] },
        { id: "keeps", ids: [3, 2] },
      ]);
    }));

  test("a full snapshot deletes only untouched groups", () =>
    withDb(async (db) => {
      await db.run((q) => insertFindingGroupSteps(q, group("fresh", [1])));
      await db.run((q) => insertFindingGroupSteps(q, group("claimed", [2])));
      await db.run((q) => touch(q, "claimed"));
      await db.run((q) => deleteUntouchedFindingGroupsSteps(q, "acme"));
      expect(await db.run((q) => heldFindingGroupMembersSteps(q, "acme"))).toEqual([2]);
    }));

  test("revoked runners do not count as owners", () =>
    withDb(async (db) => {
      await db.run(function* (q) {
        const base = { workspaceId: "acme", name: "box", createdAt: 0 };
        yield* q.exec(
          q.orm.insert(q.t.runner).values([
            { ...base, id: "a", ownerUserId: "active", status: "active" },
            { ...base, id: "b", ownerUserId: "marked", status: "active", revokedAt: 1 },
            { ...base, id: "c", ownerUserId: "status", status: "revoked" },
            { ...base, id: "d", ownerUserId: "elsewhere", status: "active", workspaceId: "other" },
          ]),
        );
      });
      expect(await db.run((q) => activeRunnerOwnersSteps(q, "acme"))).toEqual(["active"]);
    }));
});
