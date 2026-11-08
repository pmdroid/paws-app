import type { Database } from "bun:sqlite";
import { and, eq, isNull, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { settled, sqliteDb, type Db, type Q, type Steps } from "./db";
import { emitJobReady, enqueueJobSteps } from "./jobs";
import { wakeRunnerSlotWaitsSteps } from "./runner-capacity";
import { jsonField, jsonText, jsonValue } from "./json-text";
import { auditWorkspaceAccessSteps } from "./workspace";

export type RunnerRepositoryLists = { admin: string[] | null; host: string[] | null };

export function* recordRunnerRepositoriesSteps(
  q: Q,
  runnerId: string,
  repositories: readonly string[] | null,
  at: number,
): Steps<boolean> {
  const lists = q.t.runnerRepositories;
  const reported = repositories === null ? null : JSON.stringify(repositories);
  const before = yield* q.one(
    q.orm
      .select({ host: jsonText(q, lists.repositories) })
      .from(lists)
      .where(eq(lists.runnerId, runnerId)),
  );
  const stored = repositories === null ? null : jsonValue(q, repositories);
  yield* q.exec(
    q.orm
      .insert(lists)
      .values({ runnerId, repositories: stored, reportedAt: at })
      .onConflictDoUpdate({
        target: lists.runnerId,
        set: { repositories: stored, reportedAt: at },
      }),
  );
  if (before !== undefined && sameList(before.host, reported)) return false;
  const woke = yield* wakeRunnerSlotWaitsSteps(q, runnerId, at);
  const enqueued = yield* enqueueRepositoryCheckSteps(q, runnerId, `runner:${runnerId}`, at);
  return woke || enqueued;
}

function sameList(stored: string | null, reported: string | null): boolean {
  if (stored === null || reported === null) return stored === reported;
  return JSON.stringify(JSON.parse(stored)) === reported;
}

export function recordRunnerRepositories(
  db: Database,
  runnerId: string,
  repositories: readonly string[] | null,
  at: number,
): void {
  const enqueued = settled(
    sqliteDb(db).transaction((q) => recordRunnerRepositoriesSteps(q, runnerId, repositories, at)),
  );
  if (enqueued) emitJobReady(db);
}

export async function recordRunnerRepositoriesAsync(
  store: Db,
  runnerId: string,
  repositories: readonly string[] | null,
  at: number,
): Promise<void> {
  const enqueued = await store.transaction((q) =>
    recordRunnerRepositoriesSteps(q, runnerId, repositories, at),
  );
  if (enqueued) emitJobReady(store);
}

type RunnerAdminRepositories = {
  runnerId: string;
  workspaceId: string;
  userId: string;
  repositories: readonly string[] | null;
  now: number;
};

export function* setRunnerAdminRepositoriesSteps(
  q: Q,
  input: RunnerAdminRepositories,
): Steps<boolean> {
  const { runner, runnerRepositories: lists } = q.t;
  const found = yield* q.one(
    q.orm
      .select({ id: runner.id })
      .from(runner)
      .where(
        and(
          eq(runner.id, input.runnerId),
          eq(runner.workspaceId, input.workspaceId),
          isNull(runner.revokedAt),
        ),
      ),
  );
  if (!found) throw new Error("Runner is unavailable.");
  const chosen = input.repositories === null ? null : jsonValue(q, input.repositories);
  yield* q.exec(
    q.orm
      .insert(lists)
      .values({
        runnerId: input.runnerId,
        repositories: null,
        reportedAt: 0,
        adminRepositories: chosen,
      })
      .onConflictDoUpdate({
        target: lists.runnerId,
        set: { adminRepositories: chosen },
      }),
  );
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    action: "runner.repositories",
    subject: input.runnerId,
    now: input.now,
  });
  const woke = yield* wakeRunnerSlotWaitsSteps(q, input.runnerId, input.now);
  const enqueued = yield* enqueueRepositoryCheckSteps(q, input.runnerId, input.userId, input.now);
  return woke || enqueued;
}

export function setRunnerAdminRepositories(db: Database, input: RunnerAdminRepositories): void {
  const enqueued = settled(
    sqliteDb(db).transaction((q) => setRunnerAdminRepositoriesSteps(q, input)),
  );
  if (enqueued) emitJobReady(db);
}

export async function setRunnerAdminRepositoriesAsync(
  store: Db,
  input: RunnerAdminRepositories,
): Promise<void> {
  const enqueued = await store.transaction((q) => setRunnerAdminRepositoriesSteps(q, input));
  if (enqueued) emitJobReady(store);
}

export function* runnerRepositoryListsSteps(q: Q, runnerId: string) {
  const lists = q.t.runnerRepositories;
  const row = yield* q.one(
    q.orm
      .select({
        host: jsonText(q, lists.repositories),
        admin: jsonText(q, lists.adminRepositories),
      })
      .from(lists)
      .where(eq(lists.runnerId, runnerId)),
  );
  return {
    admin: row?.admin == null ? null : (JSON.parse(row.admin) as string[]),
    host: row?.host == null ? null : (JSON.parse(row.host) as string[]),
  };
}

export function runnerRepositoryLists(db: Database, runnerId: string): RunnerRepositoryLists {
  return settled(sqliteDb(db).run((q) => runnerRepositoryListsSteps(q, runnerId)));
}

export type RunnerRepositoryRefusal = { list: "admin" | "host"; allowed: string[] };

export function* runnerRepositoryRefusalSteps(
  q: Q,
  runnerId: string,
  repository: string,
): Steps<RunnerRepositoryRefusal | null> {
  const wanted = repository.toLowerCase();
  const allows = (list: string[] | null) =>
    list === null || list.some((name) => name.toLowerCase() === wanted);
  const { admin, host } = yield* runnerRepositoryListsSteps(q, runnerId);
  if (!allows(admin)) return { list: "admin", allowed: admin! };
  if (!allows(host)) return { list: "host", allowed: host! };
  return null;
}

export function runnerRepositoryRefusal(
  db: Database,
  runnerId: string,
  repository: string,
): RunnerRepositoryRefusal | null {
  return settled(sqliteDb(db).run((q) => runnerRepositoryRefusalSteps(q, runnerId, repository)));
}

export function runnerAllowsRepository(
  db: Database,
  runnerId: string,
  repository: string,
): boolean {
  return runnerRepositoryRefusal(db, runnerId, repository) === null;
}

function* enqueueRepositoryCheckSteps(
  q: Q,
  runnerId: string,
  answeredBy: string,
  at: number,
): Steps<boolean> {
  const { job, question } = q.t;
  const waiting = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(question)
      .where(
        and(
          eq(question.kind, "runner-repository"),
          eq(question.status, "open"),
          isNull(question.cancelledAt),
        ),
      )
      .limit(1),
  );
  const pending = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.runnerRepositoryCheck),
          eq(job.status, "pending"),
          eq(jsonField(q, job.payload, "runnerId"), runnerId),
          eq(jsonField(q, job.payload, "answeredBy"), answeredBy),
        ),
      )
      .limit(1),
  );
  if (!waiting || pending) return false;
  yield* enqueueJobSteps(q, {
    queue: JOB_KIND.runnerRepositoryCheck,
    payload: { runnerId, answeredBy },
    maxAttempts: 3,
    now: at,
  });
  return true;
}

export type RunnerRepositoryQuestion = { id: string; itemId: string; sessionId: string };

export function* openRunnerRepositoryQuestionsSteps(q: Q): Steps<RunnerRepositoryQuestion[]> {
  const asked = q.t.question;
  return yield* q.all(
    q.orm
      .select({ id: asked.id, itemId: asked.itemId, sessionId: asked.sessionId })
      .from(asked)
      .where(
        and(
          eq(asked.kind, "runner-repository"),
          eq(asked.status, "open"),
          isNull(asked.cancelledAt),
        ),
      ),
  );
}

export function openRunnerRepositoryQuestions(db: Database): RunnerRepositoryQuestion[] {
  return settled(sqliteDb(db).run((q) => openRunnerRepositoryQuestionsSteps(q)));
}
