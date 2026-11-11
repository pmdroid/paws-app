import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";

export type GitHubIntegrationHoldRow = {
  question_id: string;
  item_id: string;
  phase: string;
  item_version: number;
  session_generation: number;
  current_run_id: string | null;
  checkpoint: string;
  authority: string;
  status: string;
};

export function* githubIntegrationHoldStatusSteps(q: Q, questionId: string): Steps<string | null> {
  const h = q.t.githubIntegrationHold;
  const row = yield* q.one(
    q.orm.select({ status: h.status }).from(h).where(eq(h.questionId, questionId)),
  );
  return row?.status ?? null;
}

export function githubIntegrationHoldStatus(db: Database, questionId: string): string | null {
  return settled(sqliteDb(db).run((q) => githubIntegrationHoldStatusSteps(q, questionId)));
}

export function* setGithubIntegrationHoldStatusSteps(
  q: Q,
  match: { itemId: string } | { questionId: string },
  status: "revoked" | "verified",
) {
  const h = q.t.githubIntegrationHold;
  yield* q.exec(
    q.orm
      .update(h)
      .set({ status })
      .where(
        and(
          "itemId" in match ? eq(h.itemId, match.itemId) : eq(h.questionId, match.questionId),
          eq(h.status, "pending"),
        ),
      ),
  );
}

export function setGithubIntegrationHoldStatus(
  db: Database,
  match: { itemId: string } | { questionId: string },
  status: "revoked" | "verified",
): void {
  settled(sqliteDb(db).run((q) => setGithubIntegrationHoldStatusSteps(q, match, status)));
}

export type NewGitHubIntegrationHold = {
  questionId: string;
  itemId: string;
  phase: string;
  itemVersion: number;
  sessionGeneration: number;
  currentRunId: string | null;
  checkpoint: string;
  authority: string;
};

export function* insertGithubIntegrationHoldSteps(q: Q, hold: NewGitHubIntegrationHold) {
  yield* q.exec(q.orm.insert(q.t.githubIntegrationHold).values(hold));
}

export function insertGithubIntegrationHold(db: Database, hold: NewGitHubIntegrationHold): void {
  settled(sqliteDb(db).run((q) => insertGithubIntegrationHoldSteps(q, hold)));
}

export function* pendingGithubIntegrationHoldsSteps(q: Q): Steps<GitHubIntegrationHoldRow[]> {
  const h = q.t.githubIntegrationHold;
  return yield* q.all(
    q.orm
      .select({
        question_id: h.questionId,
        item_id: h.itemId,
        phase: h.phase,
        item_version: h.itemVersion,
        session_generation: h.sessionGeneration,
        current_run_id: h.currentRunId,
        checkpoint: h.checkpoint,
        authority: h.authority,
        status: h.status,
      })
      .from(h)
      .where(eq(h.status, "pending")),
  );
}

export function pendingGithubIntegrationHolds(db: Database): GitHubIntegrationHoldRow[] {
  return settled(sqliteDb(db).run((q) => pendingGithubIntegrationHoldsSteps(q)));
}

export function* setOpenQuestionBodySteps(q: Q, questionId: string, body: string) {
  const question = q.t.question;
  yield* q.exec(
    q.orm
      .update(question)
      .set({ body })
      .where(and(eq(question.id, questionId), eq(question.status, "open"))),
  );
}

export function setOpenQuestionBody(db: Database, questionId: string, body: string): void {
  settled(sqliteDb(db).run((q) => setOpenQuestionBodySteps(q, questionId, body)));
}

export function* nudgeJobRunAtSteps(q: Q, jobId: number, now: number) {
  const job = q.t.job;
  const later =
    q.dialect === "sqlite" ? sql`MAX(${job.runAt}, ${now})` : sql`GREATEST(${job.runAt}, ${now})`;
  const sooner =
    q.dialect === "sqlite" ? sql`MIN(${job.runAt}, ${now})` : sql`LEAST(${job.runAt}, ${now})`;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ runAt: sql`CASE WHEN ${job.status} = 'running' THEN ${later} ELSE ${sooner} END` })
      .where(eq(job.id, jobId)),
  );
}

export function nudgeJobRunAt(db: Database, jobId: number, now: number): void {
  settled(sqliteDb(db).run((q) => nudgeJobRunAtSteps(q, jobId, now)));
}
