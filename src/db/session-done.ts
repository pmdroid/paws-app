import { and, eq, gte, inArray, like, max, ne, notInArray } from "drizzle-orm";
import { type Db, type Q } from "./db";
import { jsonField, parsedJson } from "./json-text";
import { sessionHasFinalResponseSteps } from "./outbox";
import { getWorkItemRepositorySteps } from "./repositories";
import { readSettingSteps, updateSettingSteps } from "./settings";

export const SESSION_DONE = ["pull_request", "ci_green", "settled"] as const;
export type SessionDone = (typeof SESSION_DONE)[number];
export type SessionDoneSettings = { sessionDone: SessionDone; sessionQuietMinutes: number };

export const SESSION_DONE_KEY = "linear.session_done";
export const DEFAULT_SESSION_DONE: SessionDoneSettings = {
  sessionDone: "pull_request",
  sessionQuietMinutes: 10,
};

export function parseSessionDone(
  value: Partial<Record<keyof SessionDoneSettings, unknown>>,
  current: SessionDoneSettings = DEFAULT_SESSION_DONE,
): SessionDoneSettings {
  const done = value.sessionDone ?? current.sessionDone;
  const quiet = value.sessionQuietMinutes ?? current.sessionQuietMinutes;
  if (!SESSION_DONE.includes(done as SessionDone))
    throw new Error(`sessionDone must be ${SESSION_DONE.join(", ")}`);
  if (typeof quiet !== "number" || !Number.isInteger(quiet) || quiet < 1 || quiet > 120)
    throw new Error("sessionQuietMinutes must be a whole number from 1 to 120");
  return { sessionDone: done as SessionDone, sessionQuietMinutes: quiet };
}

export async function readSessionDone(store: Db): Promise<SessionDoneSettings> {
  const stored = await store.run((q) => readSettingSteps(q, SESSION_DONE_KEY));
  try {
    return stored === null ? DEFAULT_SESSION_DONE : parseSessionDone(JSON.parse(stored));
  } catch {
    return DEFAULT_SESSION_DONE;
  }
}

export async function saveSessionDone(store: Db, settings: SessionDoneSettings): Promise<void> {
  await store.transaction((q) =>
    updateSettingSteps(q, SESSION_DONE_KEY, () => JSON.stringify(settings)),
  );
}

export type OpenedSession = {
  itemId: string;
  sessionId: string;
  generation: number;
  body: string;
  openedAt: number;
};

export function* openedSessionsSteps(q: Q) {
  const { outbox, workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        itemId: workItem.id,
        sessionId: outbox.orderingKey,
        generation: outbox.deliveryGeneration,
        payload: outbox.payload,
        openedAt: outbox.createdAt,
      })
      .from(outbox)
      .innerJoin(workItem, eq(workItem.id, jsonField(q, outbox.payload, "itemId")))
      .where(
        and(
          eq(outbox.target, "linear"),
          like(outbox.idempotencyKey, "pull-request-opened:%"),
          ne(outbox.status, "dropped"),
          notInArray(workItem.state, ["merged", "cancelled", "completed"]),
        ),
      ),
  );
  return rows.flatMap(({ payload, sessionId, ...row }): OpenedSession[] => {
    const { body } = parsedJson<{ body?: unknown }>(q, payload);
    return sessionId !== null && typeof body === "string" ? [{ ...row, sessionId, body }] : [];
  });
}

const PULL_ACTIVITY_EVENTS = [
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
];

function deliveryPull(payload: string): { repository: unknown; number: unknown } {
  try {
    const body = JSON.parse(payload) as {
      repository?: { full_name?: unknown };
      pull_request?: { number?: unknown };
      issue?: { number?: unknown };
    };
    return {
      repository: body.repository?.full_name,
      number: body.pull_request?.number ?? body.issue?.number,
    };
  } catch {
    return { repository: null, number: null };
  }
}

export function* lastPullActivityAtSteps(q: Q, itemId: string, pullNumber: number, since: number) {
  const { githubDelivery, pullComment, pullReview } = q.t;
  const comment = yield* q.one(
    q.orm
      .select({ at: max(pullComment.receivedAt) })
      .from(pullComment)
      .where(eq(pullComment.itemId, itemId)),
  );
  const review = yield* q.one(
    q.orm
      .select({ at: max(pullReview.receivedAt) })
      .from(pullReview)
      .where(eq(pullReview.itemId, itemId)),
  );
  const repository = yield* getWorkItemRepositorySteps(q, itemId);
  const name = repository ? `${repository.owner}/${repository.repo}`.toLowerCase() : null;
  const deliveries = yield* q.all(
    q.orm
      .select({ payload: githubDelivery.payload, at: githubDelivery.receivedAt })
      .from(githubDelivery)
      .where(
        and(
          gte(githubDelivery.receivedAt, since),
          inArray(githubDelivery.event, PULL_ACTIVITY_EVENTS),
        ),
      ),
  );
  const times = [
    comment?.at,
    review?.at,
    ...deliveries.flatMap((row) => {
      const pull = deliveryPull(row.payload);
      return typeof pull.repository === "string" &&
        pull.repository.toLowerCase() === name &&
        pull.number === pullNumber
        ? [row.at]
        : [];
    }),
  ].flatMap((at) => (at == null ? [] : [Number(at)]));
  return times.length ? Math.max(...times) : null;
}

export function* sessionAwaitsFinishSteps(q: Q, sessionId: string, generation: number) {
  const { outbox } = q.t;
  const opened = yield* q.one(
    q.orm
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, sessionId),
          eq(outbox.deliveryGeneration, generation),
          like(outbox.idempotencyKey, "pull-request-opened:%"),
          ne(outbox.status, "dropped"),
        ),
      )
      .limit(1),
  );
  return opened !== undefined && !(yield* sessionHasFinalResponseSteps(q, sessionId, generation));
}
