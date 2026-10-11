import type { Database } from "bun:sqlite";
import {
  accrueAwake,
  applyDecision,
  enqueueJobOnce,
  immediate,
  listInFlightItems,
  postPauseNote,
} from "../db";
import type { WorkItemRecord } from "../db";
import { decideWake, JOB_KIND, pauseOutcome, sleep, type Clock } from "../core";
import { WakeDetector, type WakeSample } from "./wake";

export type AgentAlive = (runId: string) => boolean;

export class HostSupervisor {
  private stopped = false;
  readonly restartFromMain: (item: WorkItemRecord) => void;

  constructor(
    readonly db: Database,
    readonly clock: Clock,
    readonly detector: WakeDetector,
    /** ACP reports whether the agent child survived wake. The default keeps the current session. */
    readonly agentAlive: AgentAlive = () => true,
    readonly pollMs = 250,
    restartFromMain: (item: WorkItemRecord) => void = () => {},
  ) {
    this.restartFromMain = restartFromMain;
  }

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
    for (const item of listInFlightItems(this.db)) {
      accrueAwake(this.db, item.id, mono, now);
    }
  }

  private handleWake(sample: WakeSample): void {
    const sleptMs = sample.gapMs;
    const now = this.clock.now();
    const restarts: WorkItemRecord[] = [];
    immediate(this.db, () => {
      const inserted = this.db
        .query(
          `INSERT INTO wake (from_wall, to_wall, slept_ms, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(from_wall) DO NOTHING`,
        )
        .run(sample.fromWall, sample.toWall, sleptMs, now);
      if (inserted.changes === 0) return;

      const stamp = { fromWall: sample.fromWall, toWall: sample.toWall, sleptMs };
      for (const item of listInFlightItems(this.db)) {
        const decision = decideWake({
          sleptMs,
          itemState: item.state,
          agentAlive: item.currentRunId !== null ? this.agentAlive(item.currentRunId) : false,
          checkpoint: item.checkpoint,
        });
        applyDecision(this.db, item, decision, now, stamp);
        if (decision.type === "restart_from_main") restarts.push(item);
        const outcome = pauseOutcome(decision);
        if (outcome) postPauseNote(this.db, item, sleptMs, outcome, sample.fromWall, now);
      }
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.catchup,
        jobKey: `catchup:${sample.fromWall}`,
        payload: { reason: "wake", sleptMs, at: sample.toWall },
        now,
      });
    });
    for (const item of restarts) {
      try {
        this.restartFromMain(item);
      } catch {
        // item.start is already queued with from: fresh_main. The WIP branch stays as it was.
      }
    }
  }
}
