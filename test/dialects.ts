import { describe } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, Q } from "../src/db";
import { rows, tempStore } from "./pglite";

export type DialectDb = { db: Db; close(): Promise<void> };

export function forEachDialect(suite: (open: () => Promise<DialectDb>) => void): void {
  describe("postgres", () => suite(() => tempStore()));
}

export function* insertWorkItemSteps(q: Q, id: string, now = 0) {
  yield* q.exec(
    q.orm.insert(q.t.workItem).values({
      id,
      delegationId: `delegation-${id}`,
      linearIssueId: `issue-${id}`,
      linearIdentifier: id,
      title: id,
      state: "queued",
      branchName: `paws/${id}`,
      position: 0,
      createdAt: now,
    }),
  );
}

export function insertWorkItem(db: Db, id: string, now = 0): Promise<void> {
  return db.run((q) => insertWorkItemSteps(q, id, now));
}

/** Seed rows without their parents: the tests below check one module's queries, not the schema. */
export async function withoutForeignKeys(db: Db): Promise<void> {
  await rows(db, sql`SET session_replication_role = replica`);
}

/** Insert rows through Drizzle on either dialect. */
export function seed(db: Db, ...inserts: ((q: Q) => PromiseLike<unknown>)[]): Promise<void> {
  return db.run(function* (q) {
    for (const insert of inserts) yield* q.exec(insert(q));
  });
}

export function saveChangedPaths(
  db: Db,
  input: { itemId: string; head: string; paths: readonly string[]; recordedAt: number },
): Promise<void> {
  const changedPaths = [...new Set(input.paths)].sort();
  return db.run((q) =>
    q.exec(
      q.orm
        .insert(q.t.candidateRisk)
        .values({
          itemId: input.itemId,
          headSha: input.head,
          baseSha: "base",
          tier: "normal",
          paths: [],
          classifiedAt: input.recordedAt,
          changedPaths,
        })
        .onConflictDoUpdate({
          target: [q.t.candidateRisk.itemId, q.t.candidateRisk.headSha],
          set: { changedPaths },
        }),
    ),
  );
}

export function json(_db: Db, value: unknown): unknown {
  return value;
}

/** A runner `box` in workspace `acme` with a codex account `account` bound to it as `binding`. */
export function* insertRunnerBindingSteps(q: Q) {
  yield* q.exec(
    q.orm.insert(q.t.runner).values({
      id: "box",
      workspaceId: "acme",
      ownerUserId: "owner",
      name: "box",
      status: "active",
      createdAt: 0,
    }),
  );
  yield* q.exec(
    q.orm.insert(q.t.agentAccountBinding).values({
      id: "binding",
      workspaceId: "acme",
      accountId: "account",
      agent: "codex",
      runnerId: "box",
      quotaScope: "unknown",
      createdAt: 0,
    }),
  );
}

export function jsonValue(_q: Q, value: unknown): string {
  return value as string;
}

export function insertLinearSession(db: Db, sessionId: string, issueId: string | null = null) {
  return db.run(function* (q) {
    yield* q.exec(q.orm.insert(q.t.linearSession).values({ sessionId, issueId, createdAt: 0 }));
  });
}

export async function pullCommentOutcome(
  db: Db,
  source: string,
  commentId: number,
): Promise<string | null | undefined> {
  const row = await db.run(function* (q) {
    const { pullComment } = q.t;
    return yield* q.one(
      q.orm
        .select({ outcome: pullComment.outcome })
        .from(pullComment)
        .where(and(eq(pullComment.source, source), eq(pullComment.commentId, commentId))),
    );
  });
  return row?.outcome;
}

export function githubDeliveryRows(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select()
        .from(q.t.githubDelivery)
        .orderBy(asc(q.t.githubDelivery.receivedAt), asc(q.t.githubDelivery.deliveryId)),
    ),
  );
}
