import { expect, test } from "bun:test";
import { FakeClock } from "../core";
import { trackHostOperation, measureHostOperation } from "../host-operation";
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
  trackHostOperation(
    "job:linear.delivery",
    () => clock.advance(11_000),
    () => clock.mono(),
  );
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

test("awaiting and completed jobs are excluded from stall attribution", async () => {
  const clock = new FakeClock();
  const lines: string[] = [];
  const sample = createLagWatchdog({ clock, log: (line) => lines.push(line), recover: () => {} });
  let resolve!: () => void;
  const pending = trackHostOperation(
    "job:waiting",
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  trackHostOperation("job:finished", () => {});
  trackHostOperation(
    "job:blocking",
    () => clock.advance(10_000),
    () => clock.mono(),
  );

  // Sampling consumes only measured blocking spans, regardless of other active contexts.
  sample();
  resolve();
  await pending;
  expect(lines).toEqual(["event loop stalled 9000 ms operation=job:blocking"]);
});

test("synchronous work after an await retains its operation without attributing the await", async () => {
  const clock = new FakeClock();
  const lines: string[] = [];
  const sample = createLagWatchdog({ clock, log: (line) => lines.push(line), recover: () => {} });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const task = trackHostOperation(
    "job:continuation",
    async () => {
      await gate;
      measureHostOperation(() => clock.advance(11_000));
    },
    () => clock.mono(),
  );
  resume();
  await task;
  sample();
  expect(lines).toEqual(["event loop stalled 10000 ms operation=job:continuation"]);
});
