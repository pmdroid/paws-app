import {
  enqueueOutboxOnceSteps,
  getItemPullRequestSteps,
  getLinearSessionGenerationSteps,
  getWorkItemSteps,
  lastPullActivityAtSteps,
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

const GREEN_CHECKS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const FAILED_CHECKS = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"]);

function reportedCi(read: PullCi | null): PullCi["state"] {
  if (read === null || read.state === "unknown") return "pending";
  if (read.state !== "green") return read.state;
  const conclusions = read.checks.map((check) => check.conclusion.toUpperCase());
  if (conclusions.some((conclusion) => FAILED_CHECKS.has(conclusion))) return "failed";
  return conclusions.every((conclusion) => GREEN_CHECKS.has(conclusion)) ? "green" : "pending";
}

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
  if (settings.sessionDone === "pull_request") return "";
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
  pullOpen(item: WorkItemRecord, pullNumber: number): Promise<boolean | null>;
};

export async function finishOpenedSessions(
  store: Db,
  deps: SessionDoneDeps,
  itemId?: string,
): Promise<void> {
  const opened = (await store.run((q) => openedSessionsSteps(q))).filter(
    (session) => itemId === undefined || session.itemId === itemId,
  );
  if (opened.length === 0) return;
  const settings = await readSessionDone(store);
  for (const session of opened) await finishOpenedSession(store, deps, settings, session);
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
    };
  });
  if (!facts?.item) return;
  const { item, pull } = facts;
  const now = deps.now();
  const read: PullCi | null =
    settings.sessionDone !== "pull_request" && pull && item.acceptedHead
      ? await deps.readPullCi(item, { number: pull.pullNumber, head: item.acceptedHead })
      : null;
  const lastCommentAt = pull
    ? await store.run((q) =>
        lastPullActivityAtSteps(
          q,
          item.id,
          pull.pullNumber,
          now - settings.sessionQuietMinutes * 60_000,
        ),
      )
    : null;
  const line = sessionDoneLine(settings, {
    ci: reportedCi(read),
    fixRound: FIX_ROUND_STATES.has(item.state),
    lastCommentAt,
    openedAt: session.openedAt,
    now,
  });
  if (line === null) return;
  if (read?.state === "unknown" && pull && (await deps.pullOpen(item, pull.pullNumber)) === false)
    return;
  await store.transaction(function* (q) {
    const current = yield* getWorkItemSteps(q, item.id);
    if (
      !current ||
      current.version !== item.version ||
      current.acceptedHead !== item.acceptedHead ||
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
        body: line ? `${session.body}\n\n${line}` : session.body,
      },
      now: deps.now(),
    });
  });
}
