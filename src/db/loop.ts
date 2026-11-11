import { trackHostOperation } from "../host-operation";
import { journalCaught, journalItemId } from "../journal";
import type { Database } from "bun:sqlite";
import { DEFAULT_LEASE_MS, isMergeWork, JOB_KIND, sleep, type Clock } from "../core";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { sqliteDb, type Db, type Q, type Steps } from "./db";
import { jobInstanceElsewhereSteps } from "./instances";
import { journal } from "./journal";
import { accrueAtJobBoundary } from "./items";
import {
  claimNextJobSteps,
  completeJobSteps,
  extendJobLease,
  failJobSteps,
  isJobCurrentSteps,
  nextClaimableRunAtSteps,
  onJobReady,
  type Job,
} from "./jobs";

/** Idle backstop. Enqueue and a due `run_at` wake the claimer sooner. */
export const JOB_IDLE_CLAIM_MS = 1_000;

/**
 * A due job older than this, with a worker free and no recent claim, is the stall signal.
 * Busy timeout is 5s and the idle claim is 1s, so a live loop claims well inside the minute.
 */
export const JOB_PROGRESS_STALE_MS = 60_000;

export type JobLoopLiveness = {
  /** Workers have entered `run`. False until then, including while Paws is still starting. */
  polling: boolean;
  lastTickAt: number | null;
  lastClaimAt: number | null;
  /** General handlers executing now. A claim that has not reached a handler does not count. */
  inFlight: number;
  /** General slots. The control slot is extra and is not part of this capacity. */
  workerCount: number;
};

type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

export type JobContext = {
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
  isCurrentSteps(q: Q): Steps<boolean>;
  extendLease: (leaseMs?: number) => Promise<boolean>;
};

export type JobHandler = (job: Job, context: JobContext) => Promise<void> | void;

const EXECUTION_QUEUES: readonly string[] = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify];

function isControlQueue(queue: string): boolean {
  return !EXECUTION_QUEUES.includes(queue) && !isMergeWork(queue);
}

export function* removeUnknownRecurringJobsSteps(q: Q, registered: readonly string[]) {
  const { job } = q.t;
  return yield* q.all(
    q.orm
      .delete(job)
      .where(
        and(
          isNotNull(job.recurringEveryMs),
          registered.length ? notInArray(job.queue, [...registered]) : undefined,
        ),
      )
      .returning({ id: job.id, queue: job.queue }),
  );
}

export function* cancelUnhandledJobSteps(q: Q, claimed: Job, reason: string, now: number) {
  const { job } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(job)
      .set({
        status: "cancelled",
        lastError: reason,
        finishedAt: now,
        lockedBy: null,
        lockedUntil: null,
      })
      .where(
        and(
          eq(job.id, claimed.id),
          eq(job.status, "running"),
          eq(job.lockedBy, claimed.lockedBy ?? sql`NULL`),
        ),
      )
      .returning({ id: job.id }),
  );
  return rows.length > 0;
}

export class JobLoop {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly inflight = new Set<Promise<void>>();
  /**
   * Renews the lease of each job this loop is still running. A lease that lapsed while the
   * process was busy (event-loop lag) let the next claim take the running job again, and that
   * second activation ended the first one's claim (PAS-1491).
   */
  private readonly renewals = new Map<number, () => Promise<boolean>>();
  private readonly wakers = new Set<() => void>();
  private anyInFlight = 0;
  private controlInFlight = 0;
  private readyGeneration = 0;
  private polling = false;
  private lastTickAt: number | null = null;
  private lastClaimAt: number | null = null;
  /** Set when a claim throws, so the claimer waits out the lock instead of spinning or dying. */
  private claimFailed = false;
  /** The async `Db` for converted code: `sqliteDb(db)` unless startup passes one. */
  readonly store: Db;

  constructor(
    readonly db: Database,
    readonly clock: Clock,
    readonly options: {
      store?: Db;
      workerId?: string;
      instanceId?: string;
      leaseMs?: number;
      pollMs?: number;
      backoffBaseMs?: number;
      concurrency?: number;
    } = {},
  ) {
    this.store = options.store ?? sqliteDb(db);
  }

  get pollMs(): number {
    return this.options.pollMs ?? JOB_IDLE_CLAIM_MS;
  }

  /** What `/health` reads. Independent of the HTTP listener still accepting connections. */
  liveness(): JobLoopLiveness {
    const concurrency = this.options.concurrency ?? 1;
    return {
      polling: this.polling,
      lastTickAt: this.lastTickAt,
      lastClaimAt: this.lastClaimAt,
      inFlight: this.anyInFlight,
      workerCount: Math.max(1, concurrency),
    };
  }

  register(queue: string, handler: JobHandler): void {
    this.handlers.set(queue, handler);
  }

  async tick(
    queues: readonly string[] = [...this.handlers.keys()],
    countsCapacity = true,
  ): Promise<Job | null> {
    this.noteTick();
    const launched = await trackHostOperation("loop.tick", () =>
      this.launch(queues, countsCapacity ? "any" : "control", countsCapacity),
    );
    if (launched === null) return null;
    await launched.done;
    return launched.job;
  }

  /** Closeout time counts only while a job holds the item, so settle it at each claim and end. */
  private async settleAwake(job: Job, boundary: "claimed" | "ending"): Promise<void> {
    try {
      await accrueAtJobBoundary(this.store, job, boundary, this.clock.mono(), this.clock.now());
    } catch (error) {
      journalCaught(error, "loop.settleAwake", journalItemId(job.payload));
    }
  }

  async run(
    signal: AbortSignal,
    sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ): Promise<void> {
    const concurrency = this.options.concurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new Error("Invalid job concurrency");
    // run() starts after prepare has registered the complete handler set.
    for (const job of await this.removeUnknownRecurring())
      journal(
        `job ${job.id} ${job.queue} recurring definition removed: No handler for ${job.queue}`,
      );
    this.polling = true;
    // One claimer fills free slots. The control slot still runs when every general slot is busy.
    const stopWake = onJobReady((db) => {
      if (db === this.db || db === this.store) this.wake();
    });
    try {
      while (!signal.aborted) {
        await this.fill(signal, concurrency);
        if (signal.aborted) break;
        const waitMs = await this.nextWaitMs(concurrency);
        await this.pause(waitMs > 0 ? waitMs : this.pollMs, signal, sleeper);
      }
      await Promise.all(this.inflight);
    } finally {
      stopWake();
    }
  }

  private async removeUnknownRecurring(): Promise<{ id: number; queue: string }[]> {
    const registered = [...this.handlers.keys()];
    try {
      const instanceId = this.options.instanceId;
      const now = this.clock.now();
      if (await this.store.run((q) => jobInstanceElsewhereSteps(q, instanceId, now))) return [];
      return await this.store.run((q) => removeUnknownRecurringJobsSteps(q, registered));
    } catch (error) {
      // The same lock that used to reject tick also rejected run() before workers existed.
      journalCaught(error, "loop.run.removeUnknownRecurring", null);
      return [];
    }
  }

  /** Claim until every free slot has a job or nothing due is claimable. */
  private async fill(signal: AbortSignal, concurrency: number): Promise<void> {
    this.noteTick();
    const queues = () => [...this.handlers.keys()];
    while (this.anyInFlight < concurrency && !signal.aborted) {
      // The control slot claims other queues and must not look like progress on this one.
      if ((await this.launch(queues(), "any", true)) === null) break;
    }
    if (this.anyInFlight < concurrency || this.controlInFlight > 0 || signal.aborted) return;
    await this.launch(queues().filter(isControlQueue), "control", false);
  }

  private async nextWaitMs(concurrency: number): Promise<number> {
    if (this.claimFailed) return this.pollMs;
    if (this.anyInFlight >= concurrency && this.controlInFlight > 0) return this.pollMs;
    const queues = [...this.handlers.keys()];
    const eligible = this.anyInFlight < concurrency ? queues : queues.filter(isControlQueue);
    let next: number | null;
    try {
      const options = { now: this.clock.now(), queues: eligible };
      next = await this.store.run((q) => nextClaimableRunAtSteps(q, options));
    } catch (error) {
      journalCaught(error, "loop.nextWaitMs", null);
      return this.pollMs;
    }
    if (next === null) return this.pollMs;
    const delta = next - this.clock.now();
    if (delta <= 0) return 0;
    return Math.min(delta, this.pollMs);
  }

  /** Claim one job and start it. It counts as in flight before the claimer resumes. */
  private async launch(
    queues: readonly string[],
    lane: "any" | "control",
    notesClaim: boolean,
  ): Promise<{ job: Job; done: Promise<void> } | null> {
    const now = this.clock.now();
    // Renewed after `now`, so a claim at `now` cannot see a job of this loop as expired.
    for (const [id, renew] of [...this.renewals])
      try {
        await renew();
      } catch (error) {
        journalCaught(error, "loop.tick.renewLease", null, `job ${id}`);
      }
    // claimNextJob used to sit outside the handler try. A locked or closed database rejected
    // the claimer permanently; the process kept serving HTTP and renewed nothing. The job
    // already claimed by another slot keeps its lease and its handler.
    let job: Job | null;
    try {
      const options = {
        workerId: this.options.workerId ?? "job-loop",
        leaseMs: this.options.leaseMs ?? DEFAULT_LEASE_MS,
        now,
        queues,
      };
      // The claim is one `UPDATE … RETURNING`, so each claim is its own transaction.
      job = await trackHostOperation(
        "loop.tick",
        () => this.store.run((q) => claimNextJobSteps(q, options)),
        () => this.clock.mono(),
      );
    } catch (error) {
      journalCaught(error, "loop.tick.claimNextJob", null);
      this.claimFailed = true;
      return null;
    }
    this.claimFailed = false;
    if (job === null) return null;
    const claimed = job;
    const started = (done: Promise<void>) => {
      if (notesClaim) this.lastClaimAt = this.clock.now();
      this.track(done, lane);
      return { job: claimed, done };
    };
    const handler = this.handlers.get(job.queue);
    if (handler === undefined) {
      const reason = `No handler for ${job.queue}`;
      const cancelled = await this.store.run((q) => cancelUnhandledJobSteps(q, job, reason, now));
      if (cancelled) journal(`job ${job.id} ${job.queue} cancelled: ${reason}`);
      return started(Promise.resolve());
    }
    return started(this.execute(job, handler));
  }

  private async execute(job: Job, handler: JobHandler): Promise<void> {
    await this.settleAwake(job, "claimed");
    const controller = new AbortController();
    function* currentSteps(q: Q) {
      if (!controller.signal.aborted && !(yield* isJobCurrentSteps(q, job)))
        controller.abort(new Error("Job claim is no longer current"));
      return !controller.signal.aborted;
    }
    const stillCurrent = () => this.store.run(currentSteps);
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    const context: JobContext = {
      signal: controller.signal,
      isCurrent: stillCurrent,
      isCurrentSteps: currentSteps,
      extendLease: async (duration = leaseMs) => {
        if (!(await stillCurrent())) return false;
        if (await extendJobLease(this.store, job, this.clock.now(), duration)) return true;
        controller.abort(new Error("Job claim renewal failed"));
        return false;
      },
    };
    const renewal = setInterval(
      () => {
        this.noteTick();
        context.extendLease().catch((error: unknown) => {
          journalCaught(error, "loop.tick.renewLease", null, `job ${job.id}`);
        });
      },
      Math.max(1, Math.min(10_000, leaseMs / 3)),
    );
    renewal.unref?.();
    const renew = () => context.extendLease();
    this.renewals.set(job.id, renew);
    try {
      await trackHostOperation(`job:${job.queue}`, () => handler(job, context));
      if (await stillCurrent()) {
        await this.settleAwake(job, "ending");
        const now = this.clock.now();
        await this.store.run((q) => completeJobSteps(q, job, now));
      }
    } catch (error) {
      journalCaught(error, "loop.tick.handler", journalItemId(job.payload));
      if (await stillCurrent()) {
        await this.settleAwake(job, "ending");
        const options = { now: this.clock.now(), baseMs: this.options.backoffBaseMs };
        await this.store.run((q) => failJobSteps(q, job, error, options));
      }
    } finally {
      clearInterval(renewal);
      if (this.renewals.get(job.id) === renew) this.renewals.delete(job.id);
    }
  }

  private track(done: Promise<void>, lane: "any" | "control"): void {
    if (lane === "any") this.anyInFlight += 1;
    else this.controlInFlight += 1;
    const finished = done.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(finished);
    void finished.finally(() => {
      this.inflight.delete(finished);
      if (lane === "any") this.anyInFlight -= 1;
      else this.controlInFlight -= 1;
      this.wake();
    });
  }

  private noteTick(): void {
    this.lastTickAt = this.clock.now();
  }

  private wake(): void {
    this.readyGeneration += 1;
    const pending = [...this.wakers];
    this.wakers.clear();
    for (const waker of pending) waker();
  }

  private pause(ms: number, signal: AbortSignal, sleeper: Sleeper): Promise<void> {
    if (signal.aborted || ms <= 0) return Promise.resolve();
    const started = this.readyGeneration;
    const child = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.wakers.delete(finish);
        signal.removeEventListener("abort", finish);
        child.abort();
        resolve();
      };
      this.wakers.add(finish);
      signal.addEventListener("abort", finish, { once: true });
      if (this.readyGeneration !== started || signal.aborted) {
        finish();
        return;
      }
      void sleeper(ms, child.signal).then(finish, finish);
    });
  }
}
