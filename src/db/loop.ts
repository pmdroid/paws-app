import type { Database } from "bun:sqlite";
import { DEFAULT_LEASE_MS, DEFAULT_POLL_MS, sleep, type Clock } from "../core";
import { claimNextJob, completeJob, extendJobLease, failJob, type Job } from "./jobs";

export type JobContext = {
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
    try {
      await handler(job, {
        extendLease: (leaseMs) =>
          extendJobLease(
            this.db,
            job,
            this.clock.now(),
            leaseMs ?? this.options.leaseMs ?? DEFAULT_LEASE_MS,
          ),
      });
      completeJob(this.db, job, this.clock.now());
    } catch (error) {
      failJob(this.db, job, error, { now: this.clock.now(), baseMs: this.options.backoffBaseMs });
    }
    return job;
  }

  async run(
    signal: AbortSignal,
    sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ): Promise<void> {
    while (!signal.aborted) {
      const job = await this.tick();
      if (signal.aborted) break;
      if (job === null) await sleeper(this.pollMs, signal);
    }
  }
}
