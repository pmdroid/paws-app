import { acknowledgeNewSession } from "./acknowledge";
import type { TrackerAdapter, TrackerRequestOptions } from "./adapter";
import { linearCaller, LinearRateLimitError, type LinearLedger } from "./budget";
import type { AcceptedLinearEvent } from "./events";
import { LinearEntityNotFoundError } from "./graphql";
import type { InboxStore, QueuedLinearEvent } from "./inbox";

/** Intakes that run at once. The rest wait in `inbox_event`, oldest first. */
export const INTAKE_CONCURRENCY = 2;

/** Wait after the 1st, 2nd, 3rd, 4th failed attempt, then the last entry from then on. */
export const INTAKE_RETRY_MS = [30_000, 60_000, 120_000, 5 * 60_000, 10 * 60_000] as const;

/** Wait before retrying an event that has failed `attempts` times. */
export function intakeRetryMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), INTAKE_RETRY_MS.length) - 1;
  return INTAKE_RETRY_MS[index]!;
}

/** `created` and `prompted` events go through the intake queue. Stops stay immediate. */
export function isQueuedIntake(event: AcceptedLinearEvent): boolean {
  return (event.action === "created" || event.action === "prompted") && event.signal !== "stop";
}

export type IntakeQueue = {
  accepts(event: AcceptedLinearEvent): boolean;
  /** A newly recorded event: post the first activity now, then let the worker take it. */
  arrive(event: AcceptedLinearEvent): void;
  wake(): void;
  /** Resolves when no arrival or intake is running. */
  idle(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * One worker over the durable inbox. Runs up to `concurrency` intakes at once, oldest first,
 * and keeps each session's events in order. A failed event waits out its own retry schedule
 * (`intakeRetryMs`) without blocking the others. The worker starts an intake only while the
 * shared Linear ledger admits it, and pauses the whole queue during a rate-limit hold.
 */
export function createIntakeQueue(options: {
  store: InboxStore;
  arrive: (event: AcceptedLinearEvent) => Promise<void | boolean>;
  deliver: (event: AcceptedLinearEvent, attempts: number) => Promise<void | boolean>;
  ledger?: LinearLedger;
  concurrency?: number;
  now?: () => number;
  log?: (line: string) => void;
}): IntakeQueue {
  const store = options.store;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const concurrency = options.concurrency ?? INTAKE_CONCURRENCY;
  const arriving = new Map<string, Promise<void>>();
  const running = new Map<string, Promise<void>>();
  let pausedUntil = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const arm = (delayMs: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        pump();
      },
      Math.max(0, delayMs),
    );
    timer.unref?.();
  };

  const pump = () => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const at = now();
    if (pausedUntil > at) return arm(pausedUntil - at);
    const ordered = new Set<string>();
    let next: number | null = null;
    for (const queued of store.listQueued()) {
      const key = queued.event.dedupeKey;
      const lane = queued.event.sessionId ?? queued.event.issueId;
      const behind = lane !== null && ordered.has(lane);
      if (lane !== null) ordered.add(lane);
      if (behind || running.has(key) || arriving.has(key)) continue;
      if (queued.nextAttemptAt !== null && queued.nextAttemptAt > at) {
        next = Math.min(next ?? Infinity, queued.nextAttemptAt);
        continue;
      }
      if (running.size >= concurrency) return;
      const held = options.ledger?.admit("intake", "normal") ?? null;
      if (held !== null) {
        pausedUntil = at + held.retryAfterMs;
        return arm(held.retryAfterMs);
      }
      start(queued);
    }
    if (next !== null) arm(next - at);
  };

  const start = (queued: QueuedLinearEvent) => {
    const event = queued.event;
    const work = (async () => {
      try {
        await options.deliver(store.get(event.dedupeKey) ?? event, queued.attempts);
        store.markHandled(event.dedupeKey);
      } catch (error) {
        if (stopped) return;
        if (error instanceof LinearEntityNotFoundError && error.entity === "AgentSession") {
          log(`linear session ${event.sessionId ?? "unknown"} no longer exists; skipped`);
          store.markHandled(event.dedupeKey);
          return;
        }
        const at = now();
        const message = error instanceof Error ? error.message : "intake failed";
        if (error instanceof LinearRateLimitError) {
          pausedUntil = Math.max(pausedUntil, at + error.retryAfterMs);
          store.markFailed(event.dedupeKey, {
            error: message,
            nextAttemptAt: at + error.retryAfterMs,
            counted: false,
          });
          return;
        }
        const attempts = queued.attempts + 1;
        const waitMs = intakeRetryMs(attempts);
        store.markFailed(event.dedupeKey, {
          error: message,
          nextAttemptAt: at + waitMs,
          counted: true,
        });
        log(
          `linear intake ${event.dedupeKey} failed (attempt ${attempts}), retrying in ${Math.round(waitMs / 1000)}s: ${message}`,
        );
      }
    })().finally(() => {
      running.delete(event.dedupeKey);
      pump();
    });
    running.set(event.dedupeKey, work);
  };

  const idle = async () => {
    while (arriving.size > 0 || running.size > 0)
      await Promise.allSettled([...arriving.values(), ...running.values()]);
  };

  return {
    accepts: isQueuedIntake,
    arrive(event) {
      if (stopped || arriving.has(event.dedupeKey) || running.has(event.dedupeKey)) return;
      const work = options
        .arrive(event)
        .then((accepted) => {
          if (accepted === false) store.markHandled(event.dedupeKey);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "first activity failed";
          log(`linear first activity for ${event.dedupeKey} failed: ${message}`);
        })
        .finally(() => {
          arriving.delete(event.dedupeKey);
          pump();
        });
      arriving.set(event.dedupeKey, work);
    },
    wake: pump,
    idle,
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await idle();
    },
  };
}

export type LinearEventDelivery = ((event: AcceptedLinearEvent) => Promise<void | boolean>) & {
  close(): Promise<void>;
};

/**
 * Delivery of accepted Linear events (`onEvent`) plus the intake queue over the same inbox.
 * `onEvent` runs an event end to end now. The queue posts the first activity on arrival and
 * leaves the rest of intake to its worker.
 */
export function createLinearIntake(options: {
  store: InboxStore;
  tracker: TrackerAdapter | null;
  followUp?: (
    event: AcceptedLinearEvent,
    tracker: TrackerAdapter | null,
  ) => Promise<void | boolean>;
  beforeEvent?: (event: AcceptedLinearEvent, request?: TrackerRequestOptions) => Promise<boolean>;
  progressReporter?: (event: AcceptedLinearEvent) => TrackerAdapter["postProgress"];
  signal: AbortSignal;
  ledger?: LinearLedger;
  concurrency?: number;
  now?: () => number;
  log?: (line: string) => void;
}): { onEvent: LinearEventDelivery; queue: IntakeQueue } {
  const { tracker, followUp, beforeEvent, progressReporter, signal } = options;
  const inflight = new Map<string, Promise<void | boolean>>();
  const acknowledged = new Set<string>();
  /** Events whose access check and first activity already ran on arrival. */
  const arrived = new Set<string>();
  let closed = false;

  const run = (
    event: AcceptedLinearEvent,
    mode: { phase: "all" | "arrive" | "intake"; attempts: number },
  ) => {
    if (closed) return Promise.reject(new Error("Linear event delivery is shutting down"));
    const key = mode.phase === "arrive" ? `arrive:${event.dedupeKey}` : event.dedupeKey;
    const existing = inflight.get(key);
    if (existing !== undefined) return existing;
    const checked = mode.phase === "intake" && mode.attempts === 0 && arrived.has(event.dedupeKey);
    if (mode.phase === "intake") arrived.delete(event.dedupeKey);
    const request = checked ? undefined : initialActivityRequest(event);
    const reportProgress = progressReporter?.(event);
    const work = linearCaller("events", async () => {
      signal.throwIfAborted();
      if (!checked && beforeEvent !== undefined && !(await beforeEvent(event, request)))
        return false;
      signal.throwIfAborted();
      request?.signal?.throwIfAborted();
      if (tracker === null) {
        if (mode.phase === "arrive") return true;
        if (event.signal === "stop") {
          return followUp?.(event, null);
        }
        throw new Error("Linear is not connected.");
      }
      const acknowledger = reportProgress ? { ...tracker, postProgress: reportProgress } : tracker;
      if (mode.phase === "arrive") {
        await acknowledgeNewSession(acknowledger, event, undefined, request, {
          acknowledged,
          signal,
        });
        arrived.add(event.dedupeKey);
        return true;
      }
      return acknowledgeNewSession(
        acknowledger,
        event,
        (accepted) =>
          linearCaller("intake", () => followUp?.(accepted, tracker) ?? Promise.resolve()),
        request,
        {
          acknowledged,
          signal,
          acknowledgedOnArrival: checked,
          reportFailure: mode.attempts === 0,
        },
      );
    }).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, work);
    return work;
  };

  const onEvent = Object.assign(
    (event: AcceptedLinearEvent) => run(event, { phase: "all", attempts: 0 }),
    {
      async close() {
        closed = true;
        await Promise.allSettled([...inflight.values()]);
      },
    },
  );
  const queue = createIntakeQueue({
    store: options.store,
    arrive: (event) => run(event, { phase: "arrive", attempts: 0 }),
    deliver: (event, attempts) => run(event, { phase: "intake", attempts }),
    ledger: options.ledger,
    concurrency: options.concurrency,
    now: options.now,
    log: options.log,
  });
  return { onEvent, queue };
}

function initialActivityRequest(event: AcceptedLinearEvent): TrackerRequestOptions | undefined {
  return event.action === "created" && event.sessionId !== null && event.signal !== "stop"
    ? { signal: AbortSignal.timeout(10_000) }
    : undefined;
}
