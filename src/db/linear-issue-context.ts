import type { Database } from "bun:sqlite";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export function* linearSessionsForIssueContextSteps(q: Q, issueId: string) {
  const { linearSession, workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ sessionId: linearSession.sessionId })
      .from(linearSession)
      .where(eq(linearSession.issueId, issueId))
      .union(
        q.orm
          .select({ sessionId: sql<string>`${workItem.sessionKey}` })
          .from(workItem)
          .where(and(eq(workItem.linearIssueId, issueId), isNotNull(workItem.sessionKey))),
      ),
  );
  return rows.map((row) => row.sessionId).sort();
}

export function linearSessionsForIssueContext(db: Database, issueId: string): string[] {
  return settled(sqliteDb(db).run((q) => linearSessionsForIssueContextSteps(q, issueId)));
}

type LinearIssueContextInput = {
  sessionId: string;
  issueId: string;
  observedAt: number;
  context: string;
};

export function* saveLinearIssueContextSteps(q: Q, input: LinearIssueContextInput) {
  const { linearIssueContext } = q.t;
  yield* q.exec(
    q.orm
      .insert(linearIssueContext)
      .values(input)
      .onConflictDoUpdate({
        target: [linearIssueContext.sessionId, linearIssueContext.issueId],
        set: { observedAt: sql`excluded.observed_at`, context: sql`excluded.context` },
        setWhere: sql`excluded.observed_at >= linear_issue_context.observed_at`,
      }),
  );
}

export function saveLinearIssueContext(db: Database, input: LinearIssueContextInput): void {
  settled(sqliteDb(db).run((q) => saveLinearIssueContextSteps(q, input)));
}

export function* getLinearIssueContextSteps(q: Q, sessionId: string) {
  const { linearIssueContext } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ context: linearIssueContext.context })
      .from(linearIssueContext)
      .where(eq(linearIssueContext.sessionId, sessionId))
      .orderBy(asc(linearIssueContext.issueId)),
  );
  return rows.map((row) => row.context).join("\n\n");
}
