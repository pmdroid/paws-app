import { afterEach, expect, test } from "bun:test";
import { FakeClock } from "../core";
import { OUTBOX_IDLE_CLAIM_MS, OutboxDispatcher, enqueueOutbox, enqueueOutboxOnce } from "./index";
import { tempStore } from "../../test/pglite";

const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});

async function running() {
  const clock = new FakeClock(5_000);
  const { db, close } = await tempStore();
  closes.push(close);
  const dispatcher = new OutboxDispatcher(db, clock, { backoffBaseMs: 1_000 });
  const tick = dispatcher.tick.bind(dispatcher);
  let claims = 0;
  dispatcher.tick = () => {
    claims += 1;
    return tick();
  };
  const sleeps: number[] = [];
  let elapse: (() => void) | null = null;
  const sleeper = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      sleeps.push(ms);
      const done = () => {
        elapse = null;
        resolve();
      };
      elapse = () => {
        clock.advance(ms);
        done();
      };
      signal?.addEventListener("abort", done, { once: true });
    });
  const controller = new AbortController();
  const seen: number[] = [];
  let fail = 0;
  dispatcher.setHandler(() => {
    seen.push(clock.now());
    if (fail-- > 0) throw new Error("try again");
  });
  const asleep = () => elapse !== null;
  const task = dispatcher.run(controller.signal, sleeper);
  const settled = async () => {
    for (let i = 0; i < 1_000 && !asleep(); i++) await Bun.sleep(1);
    await dispatcher.idle();
    for (let i = 0; i < 1_000 && !asleep(); i++) await Bun.sleep(1);
  };
  closes.unshift(() => (controller.abort(), task));
  await settled();
  const failNext = () => (fail = 1);
  return {
    clock,
    db,
    seen,
    sleeps,
    settled,
    failNext,
    claims: () => claims,
    elapse: () => elapse?.(),
  };
}

const row = (key: string, now: number) => ({
  ...{ target: "linear" as const, op: "activity", orderingKey: `ses-${key}` },
  ...{ idempotencyKey: key, payload: { text: key }, now },
});

test("an enqueue is delivered without waiting for the idle poll", async () => {
  const { clock, db, seen, sleeps, settled } = await running();
  expect(sleeps).toEqual([OUTBOX_IDLE_CLAIM_MS]);
  const delays: number[] = [];
  for (let i = 0; i < 6; i++) {
    await (i % 2 ? enqueueOutboxOnce : enqueueOutbox)(db, row(`k${i}`, clock.now()));
    const started = performance.now();
    while (seen.length <= i && performance.now() - started < 1_000) await Bun.sleep(1);
    delays.push(performance.now() - started);
    await settled();
  }
  expect(seen).toEqual(Array(6).fill(5_000));
  expect(sleeps.every((ms) => ms === OUTBOX_IDLE_CLAIM_MS)).toBe(true);
  expect(Math.min(...delays)).toBeLessThan(50);
});

test("with nothing queued it claims at most once per idle poll", async () => {
  const { claims, elapse, settled, sleeps } = await running();
  for (let i = 0; i < 4; i++) {
    elapse();
    await settled();
  }
  expect(claims()).toBe(5);
  expect(sleeps).toEqual(Array(5).fill(OUTBOX_IDLE_CLAIM_MS));
});

test("a retry is picked up at its retry time", async () => {
  const { clock, db, seen, sleeps, settled, failNext, elapse } = await running();
  failNext();
  await enqueueOutbox(db, row("a", clock.now()));
  await settled();
  expect(seen).toEqual([5_000]);
  expect(sleeps.at(-1)).toBe(1_000);
  elapse();
  await settled();
  expect(seen).toEqual([5_000, 6_000]);
});
