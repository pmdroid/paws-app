import { expect, test } from "bun:test";
import { FakeClock, trackHostOperation } from "../core";
import { createLagWatchdog } from "./lag";

test("a ten second stall journals once with the operation and recovers once", () => {
  const clock = new FakeClock();
  const lines: string[] = [];
  const recovered: number[][] = [];
  const sample = createLagWatchdog({
    clock,
    log: (line) => lines.push(line),
    recover: (...args) => recovered.push(args),
  });
  trackHostOperation("job:linear.delivery", () => clock.advance(11_000));
  sample();
  clock.advance(1000);
  sample();
  expect(lines).toEqual(["event loop stalled 10000 ms operation=job:linear.delivery"]);
  expect(recovered).toEqual([[10_000, 0]]);
});

test("wall clock changes and ordinary timer jitter do not recover authority", () => {
  const clock = new FakeClock();
  const lines: string[] = [];
  const sample = createLagWatchdog({
    clock,
    log: (line) => lines.push(line),
    recover: () => {
      throw new Error("unexpected recovery");
    },
  });
  clock.sleep(130_000);
  clock.advance(1000);
  sample();
  expect(lines).toEqual([]);
});
