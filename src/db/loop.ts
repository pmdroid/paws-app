import { journalCaught, journalItemId } from "../journal";
import type { Database } from "bun:sqlite";
import { DEFAULT_LEASE_MS, isMergeWork, JOB_KIND, sleep, type Clock } from "../core";
import { journal } from "./journal";
import { accrueAtJobBoundary } from "./items";
import {
  claimNextJob,
  completeJob,
  extendJobLease,
  failJob,
  isJobCurrent,
  nextClaimableRunAt,
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
  isCurrent(): boolean;
  extendLease: (leaseMs?: number) => boolean;
};

export type JobHandler = (job: Job, context: JobContext) => Promise<void> | void;

const EXECUTION_QUEUES: readonly string[] = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify];

function isControlQueue(queue: string): boolean {
  return !EXECUTION_QUEUES.includes(queue) && !isMergeWork(queue);
}

export class JobLoop {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly wakers = new Set<() => void>();
  private anyInFlight = 0;
  private controlInFlight = 0;
  private readyGeneration = 0;
  private polling = false;
  private lastTickAt: number | null = null;
  private lastClaimAt: number | null = null;
  /** Set when a claim throws, so the claimer waits out the lock instead of spinning or dying. */
  private claimFailed = false;

  constructor(
    readonly db: Database,
    readonly clock: Clock,
    readonly options: {
      workerId?: string;
      leaseMs?: number;
      pollMs?: number;
      backoffBaseMs?: number;
      concurrency?: number;
    } = {},
  ) {}

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
    const launched = this.launch(queues);
    if (launched === null) return null;
    if (countsCapacity) this.lastClaimAt = this.clock.now();
    this.track(launched.done, countsCapacity ? "any" : "control");
    await launched.done;
    return launched.job;
  }

  /** Closeout time counts only while a job holds the item, so settle it at each claim and end. */
  private settleAwake(job: Job, boundary: "claimed" | "ending"): void {
    try {
      accrueAtJobBoundary(this.db, job, boundary, this.clock.mono(), this.clock.now());
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
    const registeredQueues = [...this.handlers.keys()];
    let removed: { id: number; queue: string }[] = [];
    try {
      removed = this.db
        .query<{ id: number; queue: string }, string[]>(
          `DELETE FROM job WHERE recurring_every_ms IS NOT NULL
           ${registeredQueues.length ? `AND queue NOT IN (${registeredQueues.map(() => "?").join(",")})` : ""}
           RETURNING id, queue`,
        )
        .all(...registeredQueues);
    } catch (error) {
      // The same lock that used to reject tick also rejected run() before workers existed.
      journalCaught(error, "loop.run.removeUnknownRecurring", null);
    }
    for (const job of removed)
      journal(
        `job ${job.id} ${job.queue} recurring definition removed: No handler for ${job.queue}`,
      );
    this.polling = true;
    // One claimer fills free slots. The control slot still runs when every general slot is busy.
    const stopWake = onJobReady((db) => {
      if (db === this.db) this.wake();
    });
    try {
      while (!signal.aborted) {
        this.fill(signal, concurrency);
        if (signal.aborted) break;
        const waitMs = this.nextWaitMs(concurrency);
        await this.pause(waitMs > 0 ? waitMs : this.pollMs, signal, sleeper);
      }
      await Promise.all(this.inflight);
    } finally {
      stopWake();
    }
  }

  /** Claim until every free slot has a job or nothing due is claimable. */
  private fill(signal: AbortSignal, concurrency: number): void {
    this.noteTick();
    const queues = () => [...this.handlers.keys()];
    while (this.anyInFlight < concurrency && !signal.aborted) {
      const launched = this.launch(queues());
      if (launched === null) break;
      // The control slot claims other queues and must not look like progress on this one.
      this.lastClaimAt = this.clock.now();
      this.track(launched.done, "any");
    }
    if (this.anyInFlight < concurrency || this.controlInFlight > 0 || signal.aborted) return;
    const launched = this.launch(queues().filter(isControlQueue));
    if (launched) this.track(launched.done, "control");
  }

  private nextWaitMs(concurrency: number): number {
    if (this.claimFailed) return this.pollMs;
    if (this.anyInFlight >= concurrency && this.controlInFlight > 0) return this.pollMs;
    const queues = [...this.handlers.keys()];
    const eligible = this.anyInFlight < concurrency ? queues : queues.filter(isControlQueue);
    let next: number | null;
    try {
      next = nextClaimableRunAt(this.db, { now: this.clock.now(), queues: eligible });
    } catch (error) {
      journalCaught(error, "loop.nextWaitMs", null);
      return this.pollMs;
    }
    if (next === null) return this.pollMs;
    const delta = next - this.clock.now();
    if (delta <= 0) return 0;
    return Math.min(delta, this.pollMs);
  }

  private launch(queues: readonly string[]): { job: Job; done: Promise<void> } | null {
    const now = this.clock.now();
    // claimNextJob used to sit outside the handler try. A locked or closed database rejected
    // the claimer permanently; the process kept serving HTTP and renewed nothing. The job
    // already claimed by another slot keeps its lease and its handler.
    let job: Job | null;
    try {
      job = claimNextJob(this.db, {
        workerId: this.options.workerId ?? "job-loop",
        leaseMs: this.options.leaseMs ?? DEFAULT_LEASE_MS,
        now,
        queues,
      });
    } catch (error) {
      journalCaught(error, "loop.tick.claimNextJob", null);
      this.claimFailed = true;
      return null;
    }
    this.claimFailed = false;
    if (job === null) return null;
    const handler = this.handlers.get(job.queue);
    if (handler === undefined) {
      const reason = `No handler for ${job.queue}`;
      const result = this.db.run(
        `UPDATE job SET status = 'cancelled', last_error = ?, finished_at = ?,
         locked_by = NULL, locked_until = NULL
         WHERE id = ? AND status = 'running' AND locked_by = ?`,
        [reason, now, job.id, job.lockedBy],
      );
      if (result.changes > 0) journal(`job ${job.id} ${job.queue} cancelled: ${reason}`);
      return { job, done: Promise.resolve() };
    }
    return { job, done: this.execute(job, handler) };
  }

  private async execute(job: Job, handler: JobHandler): Promise<void> {
    this.settleAwake(job, "claimed");
    const controller = new AbortController();
    const current = () => {
      if (!controller.signal.aborted && !isJobCurrent(this.db, job))
        controller.abort(new Error("Job claim is no longer current"));
      return !controller.signal.aborted;
    };
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    const context: JobContext = {
      signal: controller.signal,
      isCurrent: current,
      extendLease: (duration = leaseMs) => {
        if (!current()) return false;
        if (extendJobLease(this.db, job, this.clock.now(), duration)) return true;
        controller.abort(new Error("Job claim renewal failed"));
        return false;
      },
    };
    const renewal = setInterval(
      () => {
        this.noteTick();
        context.extendLease();
      },
      Math.max(1, Math.min(10_000, leaseMs / 3)),
    );
    renewal.unref?.();
    try {
      await handler(job, context);
      if (current()) {
        this.settleAwake(job, "ending");
        completeJob(this.db, job, this.clock.now());
      }
    } catch (error) {
      journalCaught(error, "loop.tick.handler", journalItemId(job.payload));
      if (current()) {
        this.settleAwake(job, "ending");
        failJob(this.db, job, error, { now: this.clock.now(), baseMs: this.options.backoffBaseMs });
      }
    } finally {
      clearInterval(renewal);
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
