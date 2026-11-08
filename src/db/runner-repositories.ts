import type { Database } from "bun:sqlite";
import { and, eq, isNull, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { enqueueJob } from "./jobs";
import { jsonText } from "./json-text";
import { orm } from "./orm";
import { job, question, runner, runnerRepositories } from "./schema";
import { immediate } from "./tx";
import { auditWorkspaceAccess } from "./workspace";

export type RunnerRepositoryLists = { admin: string[] | null; host: string[] | null };

export function recordRunnerRepositories(
  db: Database,
  runnerId: string,
  repositories: readonly string[] | null,
  at: number,
): void {
  const reported = repositories === null ? null : JSON.stringify(repositories);
  const before = orm(db)
    .select({ host: runnerRepositories.repositories })
    .from(runnerRepositories)
    .where(eq(runnerRepositories.runnerId, runnerId))
    .get();
  orm(db)
    .insert(runnerRepositories)
    .values({ runnerId, repositories: reported, reportedAt: at })
    .onConflictDoUpdate({
      target: runnerRepositories.runnerId,
      set: { repositories: reported, reportedAt: at },
    })
    .run();
  if (before === undefined || before.host !== reported)
    enqueueRepositoryCheck(db, runnerId, `runner:${runnerId}`, at);
}

export function setRunnerAdminRepositories(
  db: Database,
  input: {
    runnerId: string;
    workspaceId: string;
    userId: string;
    repositories: readonly string[] | null;
    now: number;
  },
): void {
  immediate(db, () => {
    const found = orm(db)
      .select({ id: runner.id })
      .from(runner)
      .where(
        and(
          eq(runner.id, input.runnerId),
          eq(runner.workspaceId, input.workspaceId),
          isNull(runner.revokedAt),
        ),
      )
      .get();
    if (!found) throw new Error("Runner is unavailable.");
    const chosen = input.repositories === null ? null : JSON.stringify(input.repositories);
    orm(db)
      .insert(runnerRepositories)
      .values({
        runnerId: input.runnerId,
        repositories: null,
        reportedAt: 0,
        adminRepositories: chosen,
      })
      .onConflictDoUpdate({
        target: runnerRepositories.runnerId,
        set: { adminRepositories: chosen },
      })
      .run();
    auditWorkspaceAccess(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: "runner.repositories",
      subject: input.runnerId,
      now: input.now,
    });
    enqueueRepositoryCheck(db, input.runnerId, input.userId, input.now);
  });
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

function enqueueRepositoryCheck(
  db: Database,
  runnerId: string,
  answeredBy: string,
  at: number,
): void {
  const waiting = orm(db)
    .select({ one: sql`1` })
    .from(question)
    .where(
      and(
        eq(question.kind, "runner-repository"),
        eq(question.status, "open"),
        isNull(question.cancelledAt),
      ),
    )
    .limit(1)
    .get();
  const pending = orm(db)
    .select({ one: sql`1` })
    .from(job)
    .where(
      and(
        eq(job.queue, JOB_KIND.runnerRepositoryCheck),
        eq(job.status, "pending"),
        sql`json_extract(${job.payload},'$.runnerId') = ${runnerId}`,
        sql`json_extract(${job.payload},'$.answeredBy') = ${answeredBy}`,
      ),
    )
    .limit(1)
    .get();
  if (!waiting || pending) return;
  enqueueJob(db, {
    queue: JOB_KIND.runnerRepositoryCheck,
    payload: { runnerId, answeredBy },
    maxAttempts: 3,
    now: at,
  });
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
