import type { Database } from "bun:sqlite";
import { JOB_KIND, parentIssueIdSql, retryBackoffMs, type LinearCommand } from "../core";
import { budgetHoldMs, LinearRateLimitError, type LinearRateBudget } from "./budget";
import { LinearEntityNotFoundError } from "./graphql";
import type {
  IntakePollSource,
  PolledActivity,
  PolledComment,
  PolledIssue,
  PolledSession,
} from "./catchup";
import { activityKey, promptMetadata, type AcceptedLinearEvent } from "./events";
import type { InboxStore } from "./inbox";

/** Poll while a work item is open or a question is unanswered. */
export const POLL_INTERVAL_ACTIVE_MS = 5_000;

/** Poll while nothing is in flight and no question is open. */
export const POLL_INTERVAL_IDLE_MS = 15_000;

/** Wall clock ahead of monotonic time by more than this is a laptop wake. */
export const WAKE_GAP_MS = 30_000;

const CURSOR_NAME = "linear";
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;
const OVERLAP_MS = 5_000;
const STOP_COMMENT = /^\/paws\s+stop\b/i;

export function pollIntervalMs(workActive: boolean): number {
  return workActive ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_IDLE_MS;
}

/** True when a non-terminal work item exists or a question is still open. */
export function linearWorkIsHot(db: Database): boolean {
  if (
    count(
      db,
      "SELECT COUNT(*) AS n FROM work_item WHERE state NOT IN ('completed', 'merged', 'cancelled')",
    ) > 0
  ) {
    return true;
  }
  return (
    count(db, "SELECT COUNT(*) AS n FROM question WHERE status = 'open' AND cancelled_at IS NULL") >
    0
  );
}

export function sleepGapMs(input: {
  previousWallMs: number;
  previousMonoMs: number;
  wallMs: number;
  monoMs: number;
}): number {
  return input.wallMs - input.previousWallMs - (input.monoMs - input.previousMonoMs);
}

export type Sleeper = {
  wait(ms: number): Promise<void>;
  wake(): void;
};

export type CatchUpPoller = {
  stop(): Promise<void>;
  noteWake(): void;
  pollNow(): Promise<void>;
  budget(): LinearRateBudget | null;
  settled: Promise<void>;
};

export function createTimerSleeper(): Sleeper {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveWait: (() => void) | null = null;
  return {
    wait(ms) {
      return new Promise((resolve) => {
        resolveWait = resolve;
        timer = setTimeout(() => {
          timer = null;
          resolveWait = null;
          resolve();
        }, ms);
        unref(timer);
      });
    },
    wake() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const resolve = resolveWait;
      resolveWait = null;
      resolve?.();
    },
  };
}

/**
 * Intake poll. One tick asks Linear once, dedupes by id, and feeds the inbox.
 * Active work or an open question waits 5s; idle waits 15s. `RATELIMITED` waits
 * out the reset, then the next tick resumes. The cursor is the SQLite sync row.
 */
export function startCatchUpPoller(options: {
  source: IntakePollSource;
  store: InboxStore;
  onEvent: (event: AcceptedLinearEvent) => Promise<void | boolean> | void | boolean;
  hot?: () => boolean;
  submitCommand?: (command: LinearCommand) => void;
  db?: Database;
  beforeDelay?: () => Promise<void>;
  sleeper?: Sleeper;
  now?: () => number;
  mono?: () => number;
}): CatchUpPoller {
  const sleeper = options.sleeper ?? createTimerSleeper();
  const now = options.now ?? Date.now;
  const mono = options.mono ?? (() => performance.now());
  const hot =
    options.hot ?? (() => (options.db === undefined ? false : linearWorkIsHot(options.db)));
  const control = { stopped: false };
  let wakeRequested = false;
  let active: Promise<void> | null = null;
  let pending = false;
  let rateAttempts = 0;
  let latestBudget: LinearRateBudget | null = null;

  function pollOnce(): Promise<void> {
    if (control.stopped) return Promise.resolve();
    if (active) {
      pending = true;
      return active;
    }
    active = Promise.resolve()
      .then(async () => {
        do {
          pending = false;
          await pollBody();
        } while (pending && !control.stopped);
      })
      .finally(() => {
        active = null;
      });
    return active;
  }

  async function pollBody(): Promise<void> {
    for (const event of options.store.listUnhandled()) {
      await deliver(event);
    }
    const saved = options.store.getCursor(CURSOR_NAME);
    const since = saved === null ? now() - INITIAL_LOOKBACK_MS : Math.max(0, saved - OVERLAP_MS);
    const sighting = await options.source.poll(since);
    if (sighting.budget !== null) latestBudget = sighting.budget;
    if (!sighting.queried) return;
    const sessionByIssue = new Map<string, string>();
    for (const activity of sighting.activities) {
      if (activity.issueId !== null && activity.sessionId !== null) {
        sessionByIssue.set(activity.issueId, activity.sessionId);
      }
    }
    for (const session of sighting.sessions)
      if (!session.stoppedAtMs && !session.endedAtMs)
        sessionByIssue.set(session.issueId, session.id);
    const issueEvents = sighting.issues
      .map((issue) => issueEvent(issue, sessionByIssue, options.store))
      .filter((event): event is AcceptedLinearEvent => event !== null);
    const events = [
      ...issueEvents,
      ...sighting.sessions
        .filter(
          (session) =>
            session.stoppedAtMs || !issueEvents.some((event) => event.sessionId === session.id),
        )
        .map((session) => sessionEvent(session, since, options.store)),
      ...sighting.comments.map((comment) => commentEvent(comment)),
      ...sighting.activities.map((activity) => activityEvent(activity)),
    ].filter((event): event is AcceptedLinearEvent => event !== null);
    events.sort((left, right) => left.updatedAtMs - right.updatedAtMs || rank(left) - rank(right));
    for (const event of events) {
      const committed = options.store.commit(event);
      if (!committed.inserted && committed.handled) continue;
      await deliver(event);
    }
    if (sighting.caughtUp) options.store.setCursor(CURSOR_NAME, now());
    rateAttempts = 0;
  }

  async function deliver(event: AcceptedLinearEvent): Promise<void> {
    let accepted: boolean | void;
    try {
      accepted = await options.onEvent(event);
    } catch (error) {
      if (!(error instanceof LinearEntityNotFoundError) || error.entity !== "AgentSession")
        throw error;
      console.error(`linear session ${event.sessionId ?? "unknown"} no longer exists; skipped`);
      options.store.markHandled(event.dedupeKey);
      return;
    }
    if (accepted !== false && event.signal === "stop") submitStops(event);
    options.store.markHandled(event.dedupeKey);
  }

  function submitStops(event: AcceptedLinearEvent): void {
    const submit = options.submitCommand;
    if (submit === undefined) return;
    const targets = stopTargets(options.db, event.issueId, event.sessionId);
    const requestedAt = event.updatedAtMs > 0 ? event.updatedAtMs : now();
    for (const itemId of targets) {
      try {
        submit({ type: "stop", itemId, source: "linear", requestedAt });
      } catch (error) {
        if (!isUnique(error)) throw error;
      }
    }
  }

  const settled = (async () => {
    while (!control.stopped) {
      let delay = pollIntervalMs(hot());
      try {
        await pollOnce();
        delay = Math.max(delay, budgetHoldMs(latestBudget, now()));
      } catch (error) {
        if (control.stopped) return;
        if (error instanceof LinearRateLimitError) {
          rateAttempts += 1;
          latestBudget = error.budget;
          const backoff = retryBackoffMs(rateAttempts, POLL_INTERVAL_ACTIVE_MS, 60_000);
          delay = Math.max(backoff, error.retryAfterMs);
        } else {
          const message = error instanceof Error ? error.message : "intake poll failed";
          console.error(`linear intake poll failed: ${message}`);
        }
      }
      if (control.stopped) return;
      if (wakeRequested) {
        wakeRequested = false;
        continue;
      }
      const previousWallMs = now();
      const previousMonoMs = mono();
      await options.beforeDelay?.();
      if (control.stopped) return;
      await sleeper.wait(delay);
      if (control.stopped) return;
      const gap = sleepGapMs({
        previousWallMs,
        previousMonoMs,
        wallMs: now(),
        monoMs: mono(),
      });
      if (gap > WAKE_GAP_MS || wakeRequested) wakeRequested = false;
    }
  })();

  return {
    async stop() {
      control.stopped = true;
      sleeper.wake();
      await Promise.allSettled([settled, active]);
    },
    noteWake() {
      wakeRequested = true;
      sleeper.wake();
    },
    pollNow: pollOnce,
    budget: () => latestBudget,
    settled,
  };
}

function sessionEvent(
  session: PolledSession,
  since: number,
  store: InboxStore,
): AcceptedLinearEvent | null {
  const prior = store.get(`issue:${session.issueId}:intake`);
  if (session.stoppedAtMs != null) {
    if (!store.get(`session:${session.id}:created`) && prior?.sessionId !== session.id) return null;
    return inboxEvent({
      dedupeKey: `session:${session.id}:stop:${session.stoppedAtMs}`,
      action: "prompted",
      sessionId: session.id,
      issueId: session.issueId,
      body: null,
      signal: "stop",
      updatedAtMs: session.stoppedAtMs,
      payload: { kind: "stop", reason: "session" },
    });
  }
  if (session.endedAtMs != null) return null;
  if (prior?.sessionId === session.id) return null;
  if (prior === null && session.updatedAtMs < since) return null;
  return inboxEvent({
    dedupeKey: `session:${session.id}:created`,
    action: "created",
    sessionId: session.id,
    issueId: session.issueId,
    body: null,
    signal: null,
    updatedAtMs: session.updatedAtMs,
    payload: { kind: "session" },
  });
}

/** Queue a stop in the same shape `submitCommand` drains, without applying it here. */
export function persistStopCommand(db: Database, command: LinearCommand): void {
  try {
    db.run(
      `INSERT INTO job (
         queue, job_key, payload, priority, run_at, max_attempts, created_at, recurring_every_ms, lane
       ) VALUES (?, ?, ?, 0, ?, 10, ?, NULL, 'default')`,
      [
        JOB_KIND.command,
        `cmd:${command.type}:${command.itemId}:${command.requestedAt}`,
        JSON.stringify(command),
        command.requestedAt,
        command.requestedAt,
      ],
    );
  } catch (error) {
    if (!isUnique(error)) throw error;
  }
}

function issueEvent(
  issue: PolledIssue,
  sessionByIssue: ReadonlyMap<string, string>,
  store: InboxStore,
): AcceptedLinearEvent | null {
  const sessionId = sessionByIssue.get(issue.id) ?? null;
  if (issue.labeled || issue.delegated) {
    const prior = store.get(`issue:${issue.id}:intake`);
    const mode = issue.labeled && issue.delegated ? "both" : issue.labeled ? "label" : "delegate";
    return inboxEvent({
      dedupeKey:
        prior !== null && sessionId !== null && prior.sessionId !== sessionId
          ? `session:${sessionId}:created`
          : `issue:${issue.id}:intake`,
      action: "created",
      sessionId,
      issueId: issue.id,
      body: null,
      signal: null,
      updatedAtMs: issue.updatedAtMs,
      payload: { kind: "intake", mode, identifier: issue.identifier },
    });
  }
  const prior = store.get(`issue:${issue.id}:intake`);
  if (prior === null || !intakeWasLabeled(prior.payload)) return null;
  return inboxEvent({
    dedupeKey: `issue:${issue.id}:unlabel:${issue.updatedAtMs}`,
    action: "other",
    sessionId,
    issueId: issue.id,
    body: null,
    signal: "stop",
    updatedAtMs: issue.updatedAtMs,
    payload: { kind: "stop", reason: "label" },
  });
}

function commentEvent(comment: PolledComment): AcceptedLinearEvent | null {
  if (!isPawsStop(comment.body)) return null;
  return inboxEvent({
    dedupeKey: `comment:${comment.id}`,
    action: "other",
    sessionId: null,
    issueId: comment.issueId,
    body: comment.body,
    signal: "stop",
    updatedAtMs: comment.updatedAtMs,
    payload: { kind: "stop", reason: "comment" },
  });
}

function activityEvent(activity: PolledActivity): AcceptedLinearEvent | null {
  const stop = activity.signal === "stop" || isPawsStop(activity.body);
  if (stop) {
    return inboxEvent({
      dedupeKey: `activity:${activity.id}:stop`,
      action: "prompted",
      sessionId: activity.sessionId,
      issueId: activity.issueId,
      activityId: activity.id,
      body: activity.body,
      signal: "stop",
      updatedAtMs: activity.updatedAtMs,
      payload: {
        kind: "stop",
        reason: "agent",
        actorId: activity.actorId ?? null,
        activityCreatedAtMs: activity.activityCreatedAtMs ?? null,
      },
    });
  }
  return inboxEvent({
    dedupeKey: activityKey(activity.id),
    action: "prompted",
    sessionId: activity.sessionId,
    issueId: activity.issueId,
    activityId: activity.id,
    body: activity.body,
    signal: activity.signal,
    updatedAtMs: activity.updatedAtMs,
    payload: {
      activityId: activity.id,
      actorId: activity.actorId ?? null,
      activityCreatedAtMs: activity.activityCreatedAtMs ?? null,
      sessionId: activity.sessionId,
      body: activity.body,
      signal: activity.signal,
    },
  });
}

function inboxEvent(input: {
  dedupeKey: string;
  action: AcceptedLinearEvent["action"];
  sessionId: string | null;
  issueId: string | null;
  activityId?: string | null;
  body: string | null;
  signal: string | null;
  updatedAtMs: number;
  payload: Record<string, unknown>;
}): AcceptedLinearEvent {
  return {
    dedupeKey: input.dedupeKey,
    deliveryId: null,
    source: "poll",
    action: input.action,
    sessionId: input.sessionId,
    issueId: input.issueId,
    activityId: input.activityId ?? null,
    body: input.body,
    signal: input.signal,
    updatedAtMs: input.updatedAtMs,
    payload: JSON.stringify(input.payload),
    ...promptMetadata(JSON.stringify(input.payload)),
  };
}

function intakeWasLabeled(payload: string): boolean {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) return false;
    return parsed["mode"] === "label" || parsed["mode"] === "both";
  } catch {
    return false;
  }
}

function isPawsStop(body: string | null): boolean {
  if (body === null) return false;
  return STOP_COMMENT.test(body.trim());
}

function rank(eventRow: AcceptedLinearEvent): number {
  return eventRow.signal === "stop" ? 1 : 0;
}

function stopTargets(
  db: Database | undefined,
  linearIssueId: string | null,
  sessionId: string | null,
): string[] {
  if (db === undefined) return linearIssueId === null ? [] : [linearIssueId];
  const ids: string[] = [];
  const push = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  try {
    if (linearIssueId !== null && sessionId === null) {
      const rows = db
        .query<{ id: string }, [string, string]>(
          `SELECT work_item.id AS id
           FROM work_item
           WHERE work_item.state NOT IN ('completed', 'merged', 'cancelled')
             AND (work_item.linear_issue_id = ? OR ${parentIssueIdSql("work_item")} = ?)
           ORDER BY work_item.position, work_item.id`,
        )
        .all(linearIssueId, linearIssueId);
      for (const row of rows) push(row.id);
    }
    if (sessionId !== null) {
      const rows = db
        .query<{ id: string }, [string]>(
          `SELECT id FROM work_item
           WHERE session_key = ? AND state NOT IN ('completed', 'merged', 'cancelled')
           ORDER BY position, id`,
        )
        .all(sessionId);
      for (const row of rows) push(row.id);
    }
  } catch {
    return linearIssueId === null || sessionId !== null ? [] : [linearIssueId];
  }
  if (ids.length === 0 && linearIssueId !== null && sessionId === null) ids.push(linearIssueId);
  return ids;
}

function count(db: Database, sql: string): number {
  try {
    const row = db.query<{ n: number }, []>(sql).get();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnique(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return code.includes("SQLITE_CONSTRAINT") || error.message.includes("UNIQUE constraint");
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const unrefTimer = timer.unref;
    if (typeof unrefTimer === "function") unrefTimer.call(timer);
  }
}
