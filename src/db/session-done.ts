import { and, eq, like, max, ne, notInArray } from "drizzle-orm";
import { type Db, type Q } from "./db";
import { jsonField, parsedJson } from "./json-text";
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

function storedSessionDone(stored: string | null): SessionDoneSettings {
  if (stored === null) return DEFAULT_SESSION_DONE;
  try {
    return parseSessionDone(JSON.parse(stored) as Record<string, unknown>);
  } catch {
    return DEFAULT_SESSION_DONE;
  }
}

export function* readSessionDoneSteps(q: Q) {
  return storedSessionDone(yield* readSettingSteps(q, SESSION_DONE_KEY));
}

export async function readSessionDone(store: Db): Promise<SessionDoneSettings> {
  return store.run((q) => readSessionDoneSteps(q));
}

export async function saveSessionDone(
  store: Db,
  settings: SessionDoneSettings,
  now = Date.now(),
): Promise<void> {
  await store.transaction((q) =>
    updateSettingSteps(q, SESSION_DONE_KEY, () => JSON.stringify(settings), now),
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
  return rows.flatMap((row): OpenedSession[] => {
    const { body } = parsedJson<{ body?: unknown }>(q, row.payload);
    return row.sessionId !== null && typeof body === "string"
      ? [
          {
            itemId: row.itemId,
            sessionId: row.sessionId,
            generation: row.generation,
            body,
            openedAt: row.openedAt,
          },
        ]
      : [];
  });
}

export function* lastPullCommentAtSteps(q: Q, itemId: string) {
  const { pullComment } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ at: max(pullComment.receivedAt) })
      .from(pullComment)
      .where(eq(pullComment.itemId, itemId)),
  );
  return row?.at == null ? null : Number(row.at);
}
