import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "../core";
import type { Db } from "./db";
import { OutboxDispatcher } from "./dispatcher";
import { roleRunsJobs, type InstanceRole } from "./instances";
import { JOB_IDLE_CLAIM_MS, JobLoop } from "./loop";
import { LINEAR_PROGRESS_INTERVAL_MS } from "./outbox";

const JOB_LEASE_MS = 120_000;
export const JOB_WORKERS = 64;

/** Poll the job queue and the outbox until `signal` aborts. `prepare` registers handlers first. */
export async function startLoops(input: {
  db: Database | Db;
  /** The async `Db` over `db`, handed to the job loop and the outbox. */
  store?: Db;
  instanceId: string;
  role?: InstanceRole;
  signal: AbortSignal;
  clock?: Clock;
  concurrency?: number;
  prepare?: (loops: { jobs: JobLoop; outbox: OutboxDispatcher }) => void | Promise<void>;
}): Promise<{
  stop: () => Promise<void>;
  jobs: JobLoop;
  outbox: OutboxDispatcher;
}> {
  const clock = input.clock ?? systemClock;
  const runsJobs = roleRunsJobs(input.role ?? "all");
  const jobs = new JobLoop(input.db, clock, {
    ...(input.store ? { store: input.store } : {}),
    workerId: input.instanceId,
    instanceId: input.instanceId,
    concurrency: input.concurrency ?? JOB_WORKERS,
    leaseMs: JOB_LEASE_MS,
    pollMs: JOB_IDLE_CLAIM_MS,
  });
  const outbox = new OutboxDispatcher(input.db, clock, {
    ...(input.store ? { store: input.store } : {}),
    workerId: `outbox:${input.instanceId}`,
    claims: runsJobs,
    progressIntervalMs: LINEAR_PROGRESS_INTERVAL_MS,
  });
  await input.prepare?.({ jobs, outbox });
  const task = runsJobs
    ? Promise.all([jobs.run(input.signal), outbox.run(input.signal)])
    : Promise.resolve();
  void task.catch((caughtError1) => {
    journalCaught(caughtError1, "loops.startLoops", null);
    return undefined;
  });
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
