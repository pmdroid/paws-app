import { journalCaught, journalItemId } from "../journal";
import type { Database } from "bun:sqlite";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_POLL_MS,
  isMergeWork,
  JOB_KIND,
  sleep,
  type Clock,
} from "../core";
import { journal } from "./journal";
import { accrueAtJobBoundary } from "./items";
import { claimNextJob, completeJob, extendJobLease, failJob, isJobCurrent, type Job } from "./jobs";

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

  async tick(queues: readonly string[] = [...this.handlers.keys()]): Promise<Job | null> {
    const now = this.clock.now();
    const job = claimNextJob(this.db, {
      workerId: this.options.workerId ?? "job-loop",
      leaseMs: this.options.leaseMs ?? DEFAULT_LEASE_MS,
      now,
      queues,
    });
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
      return job;
    }
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
      () => context.extendLease(),
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
    return job;
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
    const removed = this.db
      .query<{ id: number; queue: string }, string[]>(
        `DELETE FROM job WHERE recurring_every_ms IS NOT NULL
         ${registeredQueues.length ? `AND queue NOT IN (${registeredQueues.map(() => "?").join(",")})` : ""}
         RETURNING id, queue`,
      )
      .all(...registeredQueues);
    for (const job of removed)
      journal(
        `job ${job.id} ${job.queue} recurring definition removed: No handler for ${job.queue}`,
      );
    const worker = async (queues?: () => string[]) => {
      while (!signal.aborted) {
        const job = await this.tick(queues?.());
        if (signal.aborted) break;
        if (job === null) await sleeper(this.pollMs, signal);
      }
    };
    await Promise.all([
      ...Array.from({ length: concurrency }, () => worker()),
      worker(() => [...this.handlers.keys()].filter(isControlQueue)),
    ]);
  }
}
