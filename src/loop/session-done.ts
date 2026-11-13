import {
  enqueueOutboxOnceSteps,
  getItemPullRequestSteps,
  getLinearSessionGenerationSteps,
  getWorkItemSteps,
  lastPullCommentAtSteps,
  openedSessionsSteps,
  readSessionDone,
  sessionHasFinalResponseSteps,
  type Db,
  type OpenedSession,
  type SessionDoneSettings,
  type WorkItemRecord,
} from "../db";
import type { PullCi } from "../github";

export const SESSION_DONE_CAP_MS = 4 * 60 * 60_000;

const FIX_ROUND_STATES = new Set(["queued", "running", "verifying", "recovering"]);

export type SessionDoneFacts = {
  ci: PullCi["state"];
  fixRound: boolean;
  lastCommentAt: number | null;
  openedAt: number;
  now: number;
};

export function sessionDoneLine(
  settings: SessionDoneSettings,
  facts: SessionDoneFacts,
): string | null {
  const green = facts.ci === "green";
  const quiet =
    !facts.fixRound &&
    (facts.lastCommentAt === null ||
      facts.now - facts.lastCommentAt >= settings.sessionQuietMinutes * 60_000);
  if (green && settings.sessionDone === "ci_green") return "CI is green.";
  if (green && quiet) return "CI is green and review rounds are done.";
  if (facts.now - facts.openedAt < SESSION_DONE_CAP_MS) return null;
  const waiting = green
    ? "recent review activity"
    : facts.ci === "failed"
      ? "CI failing"
      : "CI pending";
  return `Still waiting: ${waiting}.`;
}

export type SessionDoneDeps = {
  now(): number;
  readPullCi(item: WorkItemRecord, pull: { number: number; head: string }): Promise<PullCi>;
};

export async function finishOpenedSessions(
  store: Db,
  deps: SessionDoneDeps,
  itemId?: string,
): Promise<void> {
  const settings = await readSessionDone(store);
  if (settings.sessionDone === "pull_request") return;
  const opened = await store.run((q) => openedSessionsSteps(q));
  for (const session of opened)
    if (itemId === undefined || session.itemId === itemId)
      await finishOpenedSession(store, deps, settings, session);
}

async function finishOpenedSession(
  store: Db,
  deps: SessionDoneDeps,
  settings: SessionDoneSettings,
  session: OpenedSession,
): Promise<void> {
  const facts = await store.run(function* (q) {
    const generation = yield* getLinearSessionGenerationSteps(q, session.sessionId);
    if (
      generation !== session.generation ||
      (yield* sessionHasFinalResponseSteps(q, session.sessionId, generation))
    )
      return null;
    return {
      item: yield* getWorkItemSteps(q, session.itemId),
      pull: yield* getItemPullRequestSteps(q, session.itemId),
      lastCommentAt: yield* lastPullCommentAtSteps(q, session.itemId),
    };
  });
  if (!facts?.item) return;
  const { item, pull } = facts;
  const ci: PullCi["state"] =
    pull && item.acceptedHead
      ? (await deps.readPullCi(item, { number: pull.pullNumber, head: item.acceptedHead })).state
      : "pending";
  const line = sessionDoneLine(settings, {
    ci,
    fixRound: FIX_ROUND_STATES.has(item.state),
    lastCommentAt: facts.lastCommentAt,
    openedAt: session.openedAt,
    now: deps.now(),
  });
  if (line === null) return;
  await store.transaction(function* (q) {
    const current = yield* getWorkItemSteps(q, item.id);
    if (
      !current ||
      ["merged", "cancelled", "completed"].includes(current.state) ||
      (yield* sessionHasFinalResponseSteps(q, session.sessionId, session.generation))
    )
      return;
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "activity",
      orderingKey: session.sessionId,
      delivery: "ordered",
      generation: session.generation,
      idempotencyKey: `pull-request-ready:${item.id}:${session.generation}`,
      payload: {
        sessionId: session.sessionId,
        itemId: item.id,
        issueId: item.linearIssueId,
        kind: "response",
        body: `${session.body}\n\n${line}`,
      },
      now: deps.now(),
    });
  });
}
