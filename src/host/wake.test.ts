import { describe, expect, test } from "bun:test";
import { FakeClock, WAKE_GAP_MS } from "../core";
import { WakeDetector } from "./wake";

describe("wake detector", () => {
  test("a gap of exactly 30s is the baseline, and the next sample starts fresh", () => {
    const clock = new FakeClock(1_000);
    const detector = new WakeDetector(clock);
    expect(detector.sample()).toBeNull();

    clock.sleep(WAKE_GAP_MS);
    const exact = detector.sample();
    expect(exact?.gapMs).toBe(WAKE_GAP_MS);
    expect(exact !== null && exact.gapMs > WAKE_GAP_MS).toBe(false);
    if (exact) detector.commit(exact);

    clock.sleep(1);
    const justOver = detector.sample();
    expect(justOver?.gapMs).toBe(1);
  });

  test("a 30s+1ms wall jump with a frozen monotonic clock is sleep", () => {
    const clock = new FakeClock(0);
    const detector = new WakeDetector(clock);
    detector.sample();
    clock.sleep(WAKE_GAP_MS + 1);
    expect(detector.sample()?.gapMs).toBe(WAKE_GAP_MS + 1);
  });

  test("a stall that moves both clocks is not sleep", () => {
    const clock = new FakeClock(0);
    const detector = new WakeDetector(clock);
    detector.sample();
    clock.advance(60_000);
    expect(detector.sample()?.gapMs).toBe(0);
  });
});
