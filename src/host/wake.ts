import { WAKE_GAP_MS, type Clock } from "../core";

export type WakeSample = {
  gapMs: number;
  fromWall: number;
  toWall: number;
  mono: number;
};

/**
 * A stall moves the wall clock and the monotonic clock together. A host suspension or a
 * wall-clock correction moves only the wall clock. The gap is the difference; it says nothing
 * about whether any worker, lease or candidate changed meanwhile.
 */
export class WakeDetector {
  private lastWall: number | null = null;
  private lastMono: number | null = null;

  constructor(
    readonly clock: Clock,
    readonly thresholdMs = WAKE_GAP_MS,
  ) {}

  /** First call only establishes a baseline and reports nothing. */
  sample(): WakeSample | null {
    const wall = this.clock.now();
    const mono = this.clock.mono();
    if (this.lastWall === null || this.lastMono === null) {
      this.lastWall = wall;
      this.lastMono = mono;
      return null;
    }
    const gapMs = wall - this.lastWall - (mono - this.lastMono);
    return { gapMs, fromWall: this.lastWall, toWall: wall, mono };
  }

  commit(sample: WakeSample): void {
    this.lastWall = sample.toWall;
    this.lastMono = sample.mono;
  }
}
