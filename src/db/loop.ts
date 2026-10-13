import type { Database } from "bun:sqlite";
import { DEFAULT_LEASE_MS, DEFAULT_POLL_MS, sleep, type Clock } from "../core";
import { claimNextJob, completeJob, extendJobLease, failJob, isJobCurrent, type Job } from "./jobs";

export type JobContext = {
  signal: AbortSignal;
  isCurrent(): boolean;
  extendLease: (leaseMs?: number) => boolean;
};

export type JobHandler = (job: Job, context: JobContext) => Promise<void> | void;

export class JobLoop {
  private readonly handlers = new Map<string, JobHandler>();

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
    return this.options.pollMs ?? DEFAULT_POLL_MS;
  }

  register(queue: string, handler: JobHandler): void {
    this.handlers.set(queue, handler);
  }

  async tick(): Promise<Job | null> {
    const now = this.clock.now();
    const job = claimNextJob(this.db, {
      workerId: this.options.workerId ?? "job-loop",
      leaseMs: this.options.leaseMs ?? DEFAULT_LEASE_MS,
      now,
      queues: [...this.handlers.keys()],
    });
    if (job === null) return null;
    const handler = this.handlers.get(job.queue);
    if (handler === undefined) {
      failJob(this.db, job, new Error(`No handler for ${job.queue}`), {
        now,
        baseMs: this.options.backoffBaseMs,
      });
      return job;
    }
    const controller = new AbortController();
    const current = () => {
      if (!controller.signal.aborted && !isJobCurrent(this.db, job, this.clock.now()))
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
      () => context.extendLease(),
      Math.max(1, Math.min(10_000, leaseMs / 3)),
    );
    renewal.unref?.();
    try {
      await handler(job, context);
      if (current()) completeJob(this.db, job, this.clock.now());
    } catch (error) {
      if (current())
        failJob(this.db, job, error, { now: this.clock.now(), baseMs: this.options.backoffBaseMs });
    } finally {
      clearInterval(renewal);
    }
    return job;
  }

  async run(
    signal: AbortSignal,
    sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ): Promise<void> {
    const concurrency = this.options.concurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new Error("Invalid job concurrency");
    const worker = async () => {
      while (!signal.aborted) {
        const job = await this.tick();
        if (signal.aborted) break;
        if (job === null) await sleeper(this.pollMs, signal);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
}
