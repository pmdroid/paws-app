import type { Database } from "bun:sqlite";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";
import { readCheckpoint } from "./checkpoint";
import { randomUUID } from "node:crypto";
import type { Checkpoint, RunKind, RunStatus, GitCommitPolicy } from "../core";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { jsonText } from "./json-text";

export type StoredRun = {
  id: string;
  itemId: string;
  kind: RunKind;
  agent: string;
  status: RunStatus;
  checkpoint: Checkpoint | null;
  freshSession: boolean;
  createdAt: number;
  updatedAt: number;
};

type RunInput = {
  itemId: string;
  now: number;
  kind?: RunKind;
  agent?: string;
  status?: RunStatus;
  checkpoint?: Checkpoint | null;
  freshSession?: boolean;
  ownerInstance?: string | null;
};

export function* insertRunSteps(q: Q, input: RunInput): Steps<StoredRun> {
  const id = randomUUID();
  const checkpoint = input.checkpoint ?? null;
  yield* q.exec(
    q.orm.insert(q.t.run).values({
      id,
      itemId: input.itemId,
      kind: input.kind ?? "implement",
      agent: input.agent ?? "cursor",
      status: input.status ?? "active",
      checkpoint: checkpoint === null ? null : storedCheckpoint(q, checkpoint),
      freshSession: input.freshSession === true ? 1 : 0,
      createdAt: input.now,
      updatedAt: input.now,
    }),
  );
  if (input.ownerInstance != null) yield* claimRunSteps(q, id, input.ownerInstance);
  const stored = yield* getRunSteps(q, id);
  if (stored === null) throw new Error("insertRun did not store a row");
  return stored;
}

export function insertRun(db: Database, input: RunInput): StoredRun {
  return settled(sqliteDb(db).run((q) => insertRunSteps(q, input)));
}

export function* getRunSteps(q: Q, id: string): Steps<StoredRun | null> {
  const row = yield* q.one(q.orm.select().from(q.t.run).where(eq(q.t.run.id, id)));
  return row === undefined ? null : mapRun(q, row);
}

export function getRun(db: Database, id: string): StoredRun | null {
  return settled(sqliteDb(db).run((q) => getRunSteps(q, id)));
}

export function* listRunsSteps(q: Q, itemId?: string): Steps<StoredRun[]> {
  const { run: runTable } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(runTable)
      .where(itemId === undefined ? undefined : eq(runTable.itemId, itemId))
      .orderBy(asc(runTable.createdAt), asc(runTable.id)),
  );
  return rows.map((row) => mapRun(q, row));
}

/** Every run, oldest first. Pass `itemId` to keep one work item. */
export async function listRuns(store: Db, itemId?: string): Promise<StoredRun[]> {
  return store.run((q) => listRunsSteps(q, itemId));
}

export function* runOwnerSteps(q: Q, runId: string): Steps<string | null> {
  const { runOwner: runOwnerTable } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ owner: runOwnerTable.ownerInstance })
      .from(runOwnerTable)
      .where(eq(runOwnerTable.runId, runId)),
  );
  return row?.owner ?? null;
}

export async function runOwner(store: Db, runId: string): Promise<string | null> {
  return store.run((q) => runOwnerSteps(q, runId));
}

export function* claimRunSteps(q: Q, runId: string, ownerInstance: string): Steps<void> {
  const { runOwner: runOwnerTable } = q.t;
  yield* q.exec(
    q.orm
      .insert(runOwnerTable)
      .values({ runId, ownerInstance })
      .onConflictDoUpdate({ target: runOwnerTable.runId, set: { ownerInstance } }),
  );
}

export async function claimRun(store: Db, runId: string, ownerInstance: string): Promise<void> {
  await store.run((q) => claimRunSteps(q, runId, ownerInstance));
}

export function* markRunSteps(q: Q, id: string, status: RunStatus, now: number): Steps<void> {
  yield* q.exec(q.orm.update(q.t.run).set({ status, updatedAt: now }).where(eq(q.t.run.id, id)));
}

export function markRun(db: Database, id: string, status: RunStatus, now: number): void {
  settled(sqliteDb(db).run((q) => markRunSteps(q, id, status, now)));
}

export function* recordReviewRoundsSteps(q: Q, id: string, rounds: number): Steps<void> {
  const { runReviewRounds } = q.t;
  yield* q.exec(
    q.orm
      .insert(runReviewRounds)
      .values({ runId: id, rounds })
      .onConflictDoUpdate({ target: runReviewRounds.runId, set: { rounds } }),
  );
}

/** How many review rounds the item needed by the time this run verified it. */
export async function recordReviewRounds(store: Db, id: string, rounds: number): Promise<void> {
  await store.run((q) => recordReviewRoundsSteps(q, id, rounds));
}

export function* releaseRunCapacitySteps(q: Q, runId: string, now: number): Steps<void> {
  const { runnerWork, runnerWorkGrant } = q.t;
  const stored = yield* getRunSteps(q, runId);
  if (stored && (stored.status === "active" || stored.status === "provisioning"))
    yield* markRunSteps(q, runId, "ended", now);
  yield* q.exec(
    q.orm
      .update(runnerWork)
      .set({ endedAt: now })
      .where(and(eq(runnerWork.runId, runId), isNull(runnerWork.endedAt))),
  );
  yield* q.exec(q.orm.delete(runnerWorkGrant).where(eq(runnerWorkGrant.runId, runId)));
}

export async function releaseRunCapacity(store: Db, runId: string, now: number): Promise<void> {
  await store.run((q) => releaseRunCapacitySteps(q, runId, now));
}

export function* saveRunResultSteps(
  q: Q,
  id: string,
  resultBody: string,
  now: number,
): Steps<void> {
  const stored = yield* getRunSteps(q, id);
  if (stored === null) throw new Error(`run ${id} not found`);
  const checkpoint = { ...(stored.checkpoint ?? { phase: "running" }), resultBody };
  yield* q.exec(
    q.orm
      .update(q.t.run)
      .set({ checkpoint: storedCheckpoint(q, checkpoint), updatedAt: now })
      .where(eq(q.t.run.id, id)),
  );
}

export async function saveRunResult(
  store: Db,
  id: string,
  resultBody: string,
  now: number,
): Promise<void> {
  await store.run((q) => saveRunResultSteps(q, id, resultBody, now));
}

/** `run.checkpoint` is JSON text on SQLite and `jsonb` on Postgres. */
function storedCheckpoint(q: Q, checkpoint: Checkpoint): unknown {
  return q.dialect === "sqlite" ? JSON.stringify(checkpoint) : checkpoint;
}

function mapRun(q: Q, row: typeof q.t.run.$inferSelect): StoredRun {
  return {
    id: row.id,
    itemId: row.itemId,
    kind: row.kind as RunKind,
    agent: row.agent,
    status: row.status as RunStatus,
    checkpoint:
      row.checkpoint === null
        ? null
        : readCheckpoint(
            q.dialect === "sqlite" ? (row.checkpoint as string) : JSON.stringify(row.checkpoint),
          ),
    freshSession: row.freshSession === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function* saveRunCommitPolicySteps(q: Q, id: string, policy: GitCommitPolicy): Steps<void> {
  const stored = yield* getRunSteps(q, id);
  if (!stored) throw new Error("Attribution run is missing");
  if (
    stored.checkpoint?.commitPolicy &&
    JSON.stringify(stored.checkpoint.commitPolicy) !== JSON.stringify(policy)
  )
    throw new Error("Run attribution snapshot cannot change");
  yield* saveCheckpointSteps(q, id, {
    ...(stored.checkpoint ?? { phase: "running" }),
    commitPolicy: policy,
  });
}

export async function saveRunCommitPolicy(
  store: Db,
  id: string,
  policy: GitCommitPolicy,
): Promise<void> {
  await store.run((q) => saveRunCommitPolicySteps(q, id, policy));
}

function* saveCheckpointSteps(q: Q, id: string, checkpoint: Checkpoint): Steps<void> {
  yield* q.exec(
    q.orm
      .update(q.t.run)
      .set({ checkpoint: storedCheckpoint(q, checkpoint) })
      .where(eq(q.t.run.id, id)),
  );
}

export function* pinRunCheckoutSteps(
  q: Q,
  id: string,
  resolve: () => NonNullable<Checkpoint["checkout"]>,
): Steps<NonNullable<Checkpoint["checkout"]>> {
  const stored = yield* getRunSteps(q, id);
  if (!stored) return resolve();
  if (stored.checkpoint?.checkout) return stored.checkpoint.checkout;
  const checkout = resolve();
  yield* saveCheckpointSteps(q, id, { ...(stored.checkpoint ?? { phase: "running" }), checkout });
  return checkout;
}

export function* getItemRunCommitPolicySteps(
  q: Q,
  itemId: string,
): Steps<GitCommitPolicy | undefined> {
  const runs = yield* listRunsSteps(q, itemId);
  return runs.toReversed().find((stored) => stored.checkpoint?.commitPolicy)?.checkpoint
    ?.commitPolicy;
}

export function getItemRunCommitPolicy(db: Database, itemId: string): GitCommitPolicy | undefined {
  return settled(sqliteDb(db).run((q) => getItemRunCommitPolicySteps(q, itemId)));
}

export function* listWaitingProfileRunsSteps(q: Q, now: number): Steps<StoredRun[]> {
  const { run: runTable, runnerWork, workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ run: runTable })
      .from(runTable)
      .innerJoin(workItem, eq(workItem.id, runTable.itemId))
      .where(
        and(
          notInArray(workItem.state, ["queued", "completed", "merged", "cancelled"]),
          eq(workItem.cancelRequested, 0),
          notExists(
            q.orm
              .select({ one: sql`1` })
              .from(runnerWork)
              .where(
                and(
                  eq(runnerWork.runId, runTable.id),
                  isNull(runnerWork.endedAt),
                  gt(runnerWork.leaseUntil, now),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(runTable.createdAt), asc(runTable.id)),
  );
  return rows.map((row) => mapRun(q, row.run));
}

/** Existing runs eligible for a Settings profile update. A live work lease owns its snapshot. */
export function listWaitingProfileRuns(db: Database, now: number): StoredRun[] {
  return settled(sqliteDb(db).run((q) => listWaitingProfileRunsSteps(q, now)));
}

export function* loseActiveItemRunsSteps(q: Q, itemId: string, now: number) {
  const { run } = q.t;
  yield* q.exec(
    q.orm
      .update(run)
      .set({ status: "lost", updatedAt: now })
      .where(and(eq(run.itemId, itemId), inArray(run.status, ["active", "provisioning"]))),
  );
}

export async function loseActiveItemRuns(store: Db, itemId: string, now: number): Promise<void> {
  await store.run((q) => loseActiveItemRunsSteps(q, itemId, now));
}

export type AnsweredRunQuestion = {
  id: string;
  itemId: string;
  body: string;
  options: string | null;
  answer: string;
};

export function* latestRunningAnswerSteps(q: Q, runId: string): Steps<AnsweredRunQuestion | null> {
  const { question, workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        id: question.id,
        itemId: question.itemId,
        body: question.body,
        options: jsonText(q, question.options),
        answer: question.answer,
      })
      .from(question)
      .innerJoin(workItem, eq(workItem.id, question.itemId))
      .where(
        and(
          eq(question.runId, runId),
          eq(question.status, "answered"),
          isNull(question.cancelledAt),
          isNotNull(question.answer),
          eq(workItem.state, "running"),
        ),
      )
      .orderBy(desc(question.answeredAt), desc(question.id))
      .limit(1),
  );
  return row ? { ...row, options: row.options as string | null, answer: row.answer! } : null;
}

export async function latestRunningAnswer(
  store: Db,
  runId: string,
): Promise<AnsweredRunQuestion | null> {
  return store.run((q) => latestRunningAnswerSteps(q, runId));
}

/** When any of these items' runs last changed, or null when they have none. */
export function* latestRunUpdateSteps(q: Q, itemIds: readonly string[]) {
  const { run } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ at: sql`MAX(${run.updatedAt})`.mapWith(Number) })
      .from(run)
      .where(inArray(run.itemId, [...itemIds])),
  );
  return row?.at ?? null;
}

export async function latestRunUpdate(
  store: Db,
  itemIds: readonly string[],
): Promise<number | null> {
  return store.run((q) => latestRunUpdateSteps(q, itemIds));
}
