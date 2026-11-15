import { describe } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  bindAgentAccount,
  createAgentAccount,
  listAgentBindings,
  recordRunnerAccountCapability,
  type Db,
  type Q,
} from "../src/db";
import type { RunnerCodingAgent } from "../src/runner-protocol";
import { rows, tempStore } from "./pglite";

export type PgliteTestDb = { db: Db; close(): Promise<void> };

export function describePglite(suite: (open: () => Promise<PgliteTestDb>) => void): void {
  describe("pglite", () => suite(() => tempStore()));
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
          recordedAt: input.recordedAt,
          changedPaths,
        })
        .onConflictDoUpdate({
          target: [q.t.candidateRisk.itemId, q.t.candidateRisk.headSha],
          set: { changedPaths, recordedAt: input.recordedAt },
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

export async function bindFixtureAccounts(db: Db, runnerId?: string, agent?: string) {
  const policies = await db.run((q) =>
    q.all(
      q.orm
        .select({
          workspaceId: q.t.runner.workspaceId,
          ownerUserId: q.t.runner.ownerUserId,
          runnerId: q.t.runner.id,
          agent: q.t.runnerAgentPolicy.agent,
          now: q.t.runner.createdAt,
        })
        .from(q.t.runner)
        .innerJoin(q.t.runnerAgentPolicy, eq(q.t.runner.id, q.t.runnerAgentPolicy.runnerId))
        .where(
          and(
            eq(q.t.runnerAgentPolicy.ready, 1),
            runnerId === undefined ? undefined : eq(q.t.runner.id, runnerId),
            agent === undefined ? undefined : eq(q.t.runnerAgentPolicy.agent, agent),
          ),
        ),
    ),
  );
  for (const row of policies) {
    const bindings = await listAgentBindings(db, row.workspaceId);
    if (
      !bindings.some(
        (b) =>
          b.runnerId === row.runnerId && b.agent === row.agent && !b.legacy && b.removedAt === null,
      )
    ) {
      const account = await createAgentAccount(db, {
        ownerUserId: row.ownerUserId,
        workspaceId: row.workspaceId,
        agent: row.agent as RunnerCodingAgent,
        label: row.runnerId + "-" + row.agent,
        now: row.now,
      });
      await bindAgentAccount(db, {
        userId: row.ownerUserId,
        workspaceId: row.workspaceId,
        accountId: account.id,
        runnerId: row.runnerId,
        now: row.now,
      });
    }
    await recordRunnerAccountCapability(
      db,
      row.runnerId,
      {
        protocol: 1,
        bindings: (await listAgentBindings(db, row.workspaceId))
          .filter((b) => b.runnerId === row.runnerId && !b.legacy && b.removedAt === null)
          .map((b) => ({ bindingId: b.id, agent: b.agent })),
      },
      row.now,
    );
  }
}
