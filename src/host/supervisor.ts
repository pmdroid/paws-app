import type { Database } from "bun:sqlite";
import { accrueAwake, enqueueJobOnce, immediate, listInFlightItems } from "../db";
import { awakeCapReached, countsAwakeTime, JOB_KIND, sleep, type Clock } from "../core";
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

  tick(): void {
    if (this.stopped) return;
    const sample = this.detector.sample();
    if (sample && sample.gapMs > this.detector.thresholdMs) {
      this.handleWake(sample);
    }
    if (sample) this.detector.commit(sample);
    this.accrue();
  }

  stop(): void {
    this.stopped = true;
  }

  async run(
    signal: AbortSignal,
    sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ): Promise<void> {
    while (!signal.aborted && !this.stopped) {
      this.tick();
      if (signal.aborted || this.stopped) break;
      await sleeper(this.pollMs, signal);
    }
  }

  private accrue(): void {
    const now = this.clock.now();
    const mono = this.clock.mono();
    const observed = new Map<string, number>();
    const stops: string[] = [];
    immediate(this.db, () => {
      for (const item of listInFlightItems(this.db)) {
        observed.set(item.id, mono);
        if (!countsAwakeTime(item.state, item.checkpoint, item.acceptedHead)) continue;
        // Skipped ticks still advance the baseline in memory, excluding parked time.
        const since = Math.max(
          item.lastMonoMs ?? this.lastObservedMono.get(item.id) ?? mono,
          this.lastObservedMono.get(item.id) ?? -Infinity,
        );
        if (mono <= since && !awakeCapReached(item)) continue;
        if (accrueAwake(this.db, item.id, mono, now, since).stopAgent) stops.push(item.id);
      }
    });
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
  private handleWake(sample: WakeSample): void {
    const now = this.clock.now();
    immediate(this.db, () => {
      const inserted = this.db
        .query(
          `INSERT INTO wake (from_wall, to_wall, slept_ms, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(from_wall) DO NOTHING`,
        )
        .run(sample.fromWall, sample.toWall, sample.gapMs, now);
      if (inserted.changes === 0) return;
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.catchup,
        jobKey: `catchup:${sample.fromWall}`,
        payload: { reason: "wake", sleptMs: sample.gapMs, at: sample.toWall },
        now,
      });
    });
  }
}
