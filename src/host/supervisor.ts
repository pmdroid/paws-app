import type { Database } from "bun:sqlite";
import {
  accrueAwakeSteps,
  emitJobReady,
  enqueueJobOnceSteps,
  listWorkItemsByStatesSteps,
  recordWakeSteps,
  sqliteDb,
} from "../db";
import {
  awakeCapReached,
  countsAwakeTime,
  IN_FLIGHT_ITEM_STATES,
  JOB_KIND,
  sleep,
  type Clock,
} from "../core";
import { WakeDetector, type WakeSample } from "./wake";

export class HostSupervisor {
  private stopped = false;
  private lastObservedMono = new Map<string, number>();

  constructor(
    readonly db: Database,
    readonly clock: Clock,
    readonly detector: WakeDetector,
    readonly pollMs = 250,
    /** Stops a live agent whose run ended at the time limit. */
    readonly stopAgent?: (itemId: string) => void,
  ) {}

  async tick(): Promise<void> {
    if (this.stopped) return;
    const sample = this.detector.sample();
    if (sample && sample.gapMs > this.detector.thresholdMs) {
      await this.handleWake(sample);
    }
    if (sample) this.detector.commit(sample);
    await this.accrue();
  }

  stop(): void {
    this.stopped = true;
  }

  async run(
    signal: AbortSignal,
    sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ): Promise<void> {
    while (!signal.aborted && !this.stopped) {
      await this.tick();
      if (signal.aborted || this.stopped) break;
      await sleeper(this.pollMs, signal);
    }
  }

  private async accrue(): Promise<void> {
    const now = this.clock.now();
    const mono = this.clock.mono();
    const observed = new Map<string, number>();
    const stops: string[] = [];
    const lastObservedMono = this.lastObservedMono;
    const jobReady = await sqliteDb(this.db).transaction(function* (q) {
      let ready = false;
      for (const item of yield* listWorkItemsByStatesSteps(q, IN_FLIGHT_ITEM_STATES)) {
        observed.set(item.id, mono);
        if (!countsAwakeTime(item.state, item.checkpoint, item.acceptedHead)) continue;
        // Skipped ticks still advance the baseline in memory, excluding parked time.
        const since = Math.max(
          item.lastMonoMs ?? lastObservedMono.get(item.id) ?? mono,
          lastObservedMono.get(item.id) ?? -Infinity,
        );
        if (mono <= since && !awakeCapReached(item)) continue;
        const accrued = yield* q.transaction((q) => accrueAwakeSteps(q, item.id, mono, now, since));
        ready ||= accrued.jobReady;
        if (accrued.outcome.stopAgent) stops.push(item.id);
      }
      return ready;
    });
    if (jobReady) emitJobReady(this.db);
    this.lastObservedMono = observed;
    for (const id of stops) this.stopAgent?.(id);
  }

  /**
   * A wall-clock gap is only an observation: it does not prove that a worker stopped, that a
   * candidate went stale, or that a person's hold or a parked wait ended. Each item keeps its
   * owner, accepted head, checkpoint and jobs; leases, generation fences, startup recovery and the
   * merge lane's own checks of head, verdict and policy decide what happens next. The gap is
   * recorded once and Linear is caught up.
   */
  private async handleWake(sample: WakeSample): Promise<void> {
    const now = this.clock.now();
    const enqueued = await sqliteDb(this.db).transaction(function* (q) {
      const inserted = yield* recordWakeSteps(q, {
        fromWall: sample.fromWall,
        toWall: sample.toWall,
        sleptMs: sample.gapMs,
        now,
      });
      if (!inserted) return false;
      const job = yield* enqueueJobOnceSteps(q, {
        queue: JOB_KIND.catchup,
        jobKey: `catchup:${sample.fromWall}`,
        payload: { reason: "wake", sleptMs: sample.gapMs, at: sample.toWall },
        now,
      });
      return job.inserted;
    });
    if (enqueued) emitJobReady(this.db);
  }
}
