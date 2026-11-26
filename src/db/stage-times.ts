import { and, asc, eq, gte, inArray, isNotNull, lt, notInArray } from "drizzle-orm";
import { type Q } from "./db";

export type MergeWaitMarkKind = "review_started" | "review_ended" | "enqueued";

export type StageMarkRow = { itemId: string; head: string; kind: MergeWaitMarkKind; at: number };

const DONE = ["completed", "merged", "cancelled"];

export function* recordMergeWaitMarkSteps(
  q: Q,
  mark: { itemId: string; head: string; kind: MergeWaitMarkKind; at: number },
) {
  yield* q.exec(q.orm.insert(q.t.mergeWaitMark).values(mark).onConflictDoNothing());
}

export function* stageHistorySteps(
  q: Q,
  window: { from: number; to: number; repository?: { owner: string; repo: string } },
) {
  const { workItem: w, workItemEvent: e, workItemRepository: r, question, mergeWaitMark } = q.t;
  const touched = yield* q.all(
    q.orm.selectDistinct({ id: e.itemId }).from(e).where(gte(e.at, window.from)),
  );
  const open = yield* q.all(
    q.orm
      .select({ id: w.id })
      .from(w)
      .where(and(notInArray(w.state, DONE), lt(w.createdAt, window.to))),
  );
  const ids = [...new Set([...touched, ...open].map((row) => row.id))];
  if (ids.length === 0) return { items: [], events: [], questions: [], marks: [] };
  const repository = window.repository;
  const items = yield* q.all(
    q.orm
      .select({
        id: w.id,
        identifier: w.linearIdentifier,
        title: w.title,
        createdAt: w.createdAt,
        state: w.state,
        owner: r.owner,
        repo: r.repo,
      })
      .from(w)
      .leftJoin(r, eq(r.itemId, w.id))
      .where(
        and(
          inArray(w.id, ids),
          ...(repository ? [eq(r.owner, repository.owner), eq(r.repo, repository.repo)] : []),
        ),
      )
      .orderBy(asc(w.createdAt), asc(w.id)),
  );
  const kept = items.map((item) => item.id);
  if (kept.length === 0) return { items, events: [], questions: [], marks: [] };
  const events = yield* q.all(
    q.orm
      .select({ itemId: e.itemId, at: e.at, fromState: e.fromState, toState: e.toState })
      .from(e)
      .where(and(inArray(e.itemId, kept), lt(e.at, window.to)))
      .orderBy(asc(e.itemId), asc(e.version)),
  );
  const questions = yield* q.all(
    q.orm
      .select({
        id: question.id,
        itemId: question.itemId,
        reason: question.reason,
        createdAt: question.createdAt,
        answeredAt: question.answeredAt,
        cancelledAt: question.cancelledAt,
      })
      .from(question)
      .where(and(inArray(question.itemId, kept), lt(question.createdAt, window.to))),
  );
  const marks = (yield* q.all(
    q.orm
      .select({
        itemId: mergeWaitMark.itemId,
        head: mergeWaitMark.head,
        kind: mergeWaitMark.kind,
        at: mergeWaitMark.at,
      })
      .from(mergeWaitMark)
      .where(and(inArray(mergeWaitMark.itemId, kept), lt(mergeWaitMark.at, window.to)))
      .orderBy(asc(mergeWaitMark.at)),
  )) as StageMarkRow[];
  return { items, events, questions, marks };
}

export function* closeoutCheckRunsSteps(
  q: Q,
  window: { from: number; to: number; repository?: { owner: string; repo: string } },
) {
  const { closeoutStep: s, closeoutProgress: p, workItemRepository: r } = q.t;
  const repository = window.repository;
  return yield* q.all(
    q.orm
      .select({
        stepId: s.stepId,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        timedOut: s.timedOut,
      })
      .from(s)
      .innerJoin(p, eq(p.id, s.progressId))
      .leftJoin(r, eq(r.itemId, p.itemId))
      .where(
        and(
          isNotNull(s.finishedAt),
          gte(s.startedAt, window.from),
          lt(s.startedAt, window.to),
          ...(repository ? [eq(r.owner, repository.owner), eq(r.repo, repository.repo)] : []),
        ),
      ),
  );
}
