/** Wall time jumps across laptop sleep. Monotonic time does not. */
export interface Clock {
  now(): number;
  mono(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  mono: () => Number(process.hrtime.bigint() / 1_000_000n),
};

/**
 * Test clock. `advance` moves both timelines. `sleep` moves only the wall
 * clock, which is the signal the wake detector looks for.
 */
export class FakeClock implements Clock {
  private wallMs: number;
  private monoMs: number;

  constructor(start = 0) {
    this.wallMs = start;
    this.monoMs = start;
  }

  now(): number {
    return this.wallMs;
  }

  mono(): number {
    return this.monoMs;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error("FakeClock cannot move backwards");
    this.wallMs += ms;
    this.monoMs += ms;
  }

  sleep(ms: number): void {
    if (ms < 0) throw new Error("FakeClock cannot move backwards");
    this.wallMs += ms;
  }
}
