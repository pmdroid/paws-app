import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export type PullRequestDraft = { title: string; body: string };

export function* savePullRequestDraftSteps(
  q: Q,
  itemId: string,
  draft: PullRequestDraft,
  now: number,
) {
  const { pullRequestDraft } = q.t;
  yield* q.exec(
    q.orm
      .insert(pullRequestDraft)
      .values({ itemId, title: draft.title, body: draft.body, updatedAt: now })
      .onConflictDoUpdate({
        target: pullRequestDraft.itemId,
        set: {
          title: sql`excluded.title`,
          body: sql`excluded.body`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}

export function savePullRequestDraft(
  db: Database,
  itemId: string,
  draft: PullRequestDraft,
  now: number,
): void {
  settled(sqliteDb(db).run((q) => savePullRequestDraftSteps(q, itemId, draft, now)));
}

export function* pullRequestDraftSavedAtSteps(q: Q, itemId: string) {
  const { pullRequestDraft } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ updatedAt: pullRequestDraft.updatedAt })
      .from(pullRequestDraft)
      .where(eq(pullRequestDraft.itemId, itemId)),
  );
  return row?.updatedAt ?? null;
}

export function pullRequestDraftSavedAt(db: Database, itemId: string): number | null {
  return settled(sqliteDb(db).run((q) => pullRequestDraftSavedAtSteps(q, itemId)));
}

export function* getPullRequestDraftSteps(q: Q, itemId: string) {
  const { pullRequestDraft } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ title: pullRequestDraft.title, body: pullRequestDraft.body })
      .from(pullRequestDraft)
      .where(eq(pullRequestDraft.itemId, itemId)),
  );
  return row ?? null;
}

export function getPullRequestDraft(db: Database, itemId: string): PullRequestDraft | null {
  return settled(sqliteDb(db).run((q) => getPullRequestDraftSteps(q, itemId)));
}

export type PullRequestText = { title: string; body: string; evidence: string };

export function* savePullRequestTextSteps(
  q: Q,
  itemId: string,
  text: PullRequestText,
  now: number,
) {
  const { pullRequestText } = q.t;
  yield* q.exec(
    q.orm
      .insert(pullRequestText)
      .values({
        itemId,
        title: text.title,
        body: text.body,
        evidence: text.evidence,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: pullRequestText.itemId,
        set: {
          title: sql`excluded.title`,
          body: sql`excluded.body`,
          evidence: sql`excluded.evidence`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}

export function savePullRequestText(
  db: Database,
  itemId: string,
  text: PullRequestText,
  now: number,
): void {
  settled(sqliteDb(db).run((q) => savePullRequestTextSteps(q, itemId, text, now)));
}

export function* getPullRequestTextSteps(q: Q, itemId: string) {
  const { pullRequestText } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        title: pullRequestText.title,
        body: pullRequestText.body,
        evidence: pullRequestText.evidence,
      })
      .from(pullRequestText)
      .where(eq(pullRequestText.itemId, itemId)),
  );
  return row ?? null;
}

export function getPullRequestText(db: Database, itemId: string): PullRequestText | null {
  return settled(sqliteDb(db).run((q) => getPullRequestTextSteps(q, itemId)));
}
