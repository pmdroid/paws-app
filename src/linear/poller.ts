import type { Database } from "bun:sqlite";
import { JOB_KIND, parentIssueIdSql, type LinearCommand } from "../core";
import { budgetHoldMs, LinearRateLimitError, type LinearRateBudget } from "./budget";
import { LinearEntityNotFoundError } from "./graphql";
import type {
  IntakePollSource,
  IntakeSighting,
  PolledActivity,
  PolledComment,
  PolledIssue,
  PolledSession,
} from "./catchup";
import { activityKey, promptMetadata, sessionCreatedKey, type AcceptedLinearEvent } from "./events";
import type { InboxStore } from "./inbox";
import type { IntakeQueue } from "./intake-queue";
import { lastVerifiedWebhookMs, webhookVerificationFailures } from "./webhook";

/** Poll as a backstop while nothing says webhooks are failing. */
export const POLL_INTERVAL_WEBHOOK_MS = 12 * 60_000;

/** Poll while webhooks look broken. Never faster. */
export const POLL_INTERVAL_FAILING_MS = 60_000;

/** Poll while less than `LOW_BUDGET_FRACTION` of the Linear request budget is left. */
export const POLL_INTERVAL_LOW_BUDGET_MS = 5 * 60_000;

/** This many signed deliveries rejected in a row means webhooks are failing. */
export const WEBHOOK_FAILURES_FAILING = 3;

export const LOW_BUDGET_FRACTION = 0.2;

/** Wall clock ahead of monotonic time by more than this is a laptop wake. */
export const WAKE_GAP_MS = 30_000;

export const CATCH_UP_CURSOR = "linear";
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;
const OVERLAP_MS = 5_000;
const MISSED_DELIVERY_GRACE_MS = 60_000;
const STOP_COMMENT = /^\/paws\s+stop\b/i;

export type PollSignals = {
  now: number;
  lastWebhookMs: number | null;
  webhookFailures?: number;
  missedDeliveryMs?: number | null;
  budget?: LinearRateBudget | null;
};

/**
 * 12 minutes as a backstop, once a minute when webhooks look broken: none verified yet,
 * repeated verification failures, or a delivery the poll found that no webhook brought.
 * A request budget under 20% stretches it to 5 minutes until the budget resets.
 */
export function pollIntervalMs(signals: PollSignals): number {
  const interval = webhooksFailing(signals) ? POLL_INTERVAL_FAILING_MS : POLL_INTERVAL_WEBHOOK_MS;
  if (budgetIsLow(signals.budget ?? null, signals.now)) {
    return Math.max(interval, POLL_INTERVAL_LOW_BUDGET_MS);
  }
  return interval;
}

function webhooksFailing(signals: PollSignals): boolean {
  if (signals.lastWebhookMs === null) return true;
  if ((signals.webhookFailures ?? 0) >= WEBHOOK_FAILURES_FAILING) return true;
  const missed = signals.missedDeliveryMs ?? null;
  return missed !== null && missed > signals.lastWebhookMs;
}

function budgetIsLow(budget: LinearRateBudget | null, now: number): boolean {
  if (budget === null) return false;
  const { requestsRemaining, requestsLimit, requestsResetMs } = budget;
  if (requestsRemaining === null || requestsLimit === null || requestsLimit <= 0) return false;
  if (requestsResetMs !== null && now >= requestsResetMs) return false;
  return requestsRemaining / requestsLimit < LOW_BUDGET_FRACTION;
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
 * Intake poll. One tick asks Linear once, dedupes by id, and feeds the inbox. With an
 * intake queue, `created` and `prompted` events are only recorded and handed to its worker.
 * The first tick runs at start; later ticks wait `pollIntervalMs`. `RATELIMITED` waits
 * out the reset, then the next tick resumes. The cursor is the SQLite sync row.
 */
export function startCatchUpPoller(options: {
  source: IntakePollSource;
  store: InboxStore;
  onEvent: (event: AcceptedLinearEvent) => Promise<void | boolean> | void | boolean;
  /** Takes `created` and `prompted` events. The poller records them and wakes it. */
  intake?: IntakeQueue;
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
  const control = { stopped: false };
  let wakeRequested = false;
  let active: Promise<void> | null = null;
  let pending = false;
  let latestBudget: LinearRateBudget | null = null;
  let missedDeliveryMs: number | null = null;

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
      if (options.intake?.accepts(event)) continue;
      await deliverOrSkip(event);
    }
    const saved = options.store.getCursor(CATCH_UP_CURSOR);
    const since = saved === null ? now() - INITIAL_LOOKBACK_MS : Math.max(0, saved - OVERLAP_MS);
    let sighting: IntakeSighting;
    do {
      sighting = await options.source.poll(since);
      if (sighting.budget !== null) latestBudget = sighting.budget;
      if (!sighting.queried) return;
      await record(sighting, since);
    } while (!sighting.caughtUp && !control.stopped);
    options.intake?.wake();
    if (sighting.caughtUp) options.store.setCursor(CATCH_UP_CURSOR, now());
  }

  async function record(sighting: IntakeSighting, since: number): Promise<void> {
    const sessionByIssue = new Map<string, string>();
    for (const activity of sighting.activities) {
      if (activity.issueId !== null && activity.sessionId !== null) {
        sessionByIssue.set(activity.issueId, activity.sessionId);
      }
    }
    for (const session of sighting.sessions)
      if (!session.stoppedAtMs && !session.endedAtMs)
        sessionByIssue.set(session.issueId, session.id);
    const sessionHasTask = (sessionId: string) =>
      options.db?.query("SELECT 1 FROM work_item WHERE session_key=? LIMIT 1").get(sessionId) !=
      null;
    const issueEvents = sighting.issues
      .map((issue) => issueEvent(issue, sessionByIssue, options.store, sessionHasTask))
      .filter((event): event is AcceptedLinearEvent => event !== null);
    const events = [
      ...issueEvents,
      ...sighting.sessions
        .filter(
          (session) =>
            session.stoppedAtMs || !issueEvents.some((event) => event.sessionId === session.id),
        )
        .map((session) => sessionEvent(session, since, options.store, sessionHasTask)),
      ...sighting.comments.map((comment) => commentEvent(comment)),
      ...sighting.activities.map((activity) => activityEvent(activity)),
    ].filter((event): event is AcceptedLinearEvent => event !== null);
    events.sort((left, right) => left.updatedAtMs - right.updatedAtMs || rank(left) - rank(right));
    for (const event of events) {
      const committed = options.store.commit(event);
      if (committed.inserted && webhookMissed(event)) missedDeliveryMs = now();
      if (!committed.inserted && committed.handled) continue;
      if (options.intake?.accepts(event)) {
        if (committed.inserted) options.intake.arrive(event);
        continue;
      }
      await deliverOrSkip(event);
    }
  }

  function webhookMissed(event: AcceptedLinearEvent): boolean {
    const lastWebhookMs = lastVerifiedWebhookMs(options.store);
    if (lastWebhookMs === null || event.updatedAtMs <= lastWebhookMs) return false;
    if (event.updatedAtMs > now() - MISSED_DELIVERY_GRACE_MS || event.signal === "stop") {
      return false;
    }
    if (event.action === "created") {
      return event.sessionId !== null && event.dedupeKey === sessionCreatedKey(event.sessionId);
    }
    return (
      event.action === "prompted" &&
      event.sessionId !== null &&
      event.activityId !== null &&
      event.dedupeKey === activityKey(event.activityId) &&
      options.store.get(sessionCreatedKey(event.sessionId)) !== null
    );
  }

  async function deliverOrSkip(event: AcceptedLinearEvent): Promise<void> {
    try {
      await deliver(event);
    } catch (error) {
      if (error instanceof LinearRateLimitError || control.stopped) throw error;
      const message = error instanceof Error ? error.message : "delivery failed";
      console.error(`linear event ${event.dedupeKey} stays pending: ${message}`);
    }
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
      let delay = POLL_INTERVAL_FAILING_MS;
      try {
        await pollOnce();
        delay = Math.max(
          pollIntervalMs({
            now: now(),
            lastWebhookMs: lastVerifiedWebhookMs(options.store),
            webhookFailures: webhookVerificationFailures(options.store),
            missedDeliveryMs,
            budget: latestBudget,
          }),
          budgetHoldMs(latestBudget, now()),
        );
      } catch (error) {
        if (control.stopped) return;
        if (error instanceof LinearRateLimitError) {
          latestBudget = error.budget;
          delay = Math.max(POLL_INTERVAL_FAILING_MS, error.retryAfterMs);
          console.error(
            `linear intake poll rate-limited; retrying in ${Math.ceil(delay / 1000)}s: ${error.message}`,
          );
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
  sessionHasTask: (sessionId: string) => boolean,
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
  const delegatedAt = store.getCursor(`delegated:${session.issueId}`);
  const redelegated =
    delegatedAt !== null &&
    delegatedAt > session.createdAtMs + REDELEGATION_MARGIN_MS &&
    !sessionHasTask(session.id);
  if (!redelegated && prior?.sessionId === session.id) return null;
  if (!redelegated && prior === null && session.updatedAtMs < since) return null;
  return inboxEvent({
    dedupeKey: redelegated
      ? `session:${session.id}:created:${delegatedAt}`
      : `session:${session.id}:created`,
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

const REDELEGATION_MARGIN_MS = 60_000;

function issueEvent(
  issue: PolledIssue,
  sessionByIssue: ReadonlyMap<string, string>,
  store: InboxStore,
  sessionHasTask: (sessionId: string) => boolean,
): AcceptedLinearEvent | null {
  const sessionId = sessionByIssue.get(issue.id) ?? null;
  if (issue.labeled || issue.delegated) {
    const prior = store.get(`issue:${issue.id}:intake`);
    const mode = issue.labeled && issue.delegated ? "both" : issue.labeled ? "label" : "delegate";
    const delegatedAt = store.getCursor(`delegated:${issue.id}`);
    const redelegated =
      prior !== null &&
      sessionId !== null &&
      issue.delegated &&
      delegatedAt !== null &&
      delegatedAt > prior.updatedAtMs + REDELEGATION_MARGIN_MS &&
      !sessionHasTask(sessionId);
    return inboxEvent({
      dedupeKey:
        prior !== null && sessionId !== null && prior.sessionId !== sessionId
          ? `session:${sessionId}:created`
          : redelegated
            ? `issue:${issue.id}:intake:${delegatedAt}`
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
  const mode = prior === null ? null : intakeMode(prior.payload);
  if (mode === null) return null;
  const reason = mode === "delegate" ? "delegate" : "label";
  return inboxEvent({
    dedupeKey: `issue:${issue.id}:un${reason}:${issue.updatedAtMs}`,
    action: "other",
    sessionId,
    issueId: issue.id,
    body: null,
    signal: "stop",
    updatedAtMs: issue.updatedAtMs,
    payload: { kind: "stop", reason },
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

function intakeMode(payload: string): "label" | "delegate" | "both" | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) return null;
    const mode = parsed["mode"];
    return mode === "label" || mode === "delegate" || mode === "both" ? mode : null;
  } catch {
    return null;
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
