import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "../core";
import { OutboxDispatcher } from "./dispatcher";
import { JobLoop } from "./loop";
import { LINEAR_PROGRESS_INTERVAL_MS } from "./outbox";

const JOB_LEASE_MS = 120_000;
export const JOB_WORKERS = 64;

/** Poll the job queue and the outbox until `signal` aborts. `prepare` registers handlers first. */
export function startLoops(input: {
  db: Database;
  signal: AbortSignal;
  clock?: Clock;
  concurrency?: number;
  prepare?: (loops: { jobs: JobLoop; outbox: OutboxDispatcher }) => void;
}): {
  stop: () => Promise<void>;
  jobs: JobLoop;
  outbox: OutboxDispatcher;
} {
  const clock = input.clock ?? systemClock;
  const jobs = new JobLoop(input.db, clock, {
    concurrency: input.concurrency ?? JOB_WORKERS,
    leaseMs: JOB_LEASE_MS,
  });
  const outbox = new OutboxDispatcher(input.db, clock, {
    progressIntervalMs: LINEAR_PROGRESS_INTERVAL_MS,
  });
  input.prepare?.({ jobs, outbox });
  const task = Promise.all([jobs.run(input.signal), outbox.run(input.signal)]);
  void task.catch(() => undefined);
  return {
    jobs,
    outbox,
    async stop() {
      // The caller aborts `signal`. This exists so shutdown has a named hook.
      await task;
      await outbox.idle();
    },
  };
}
