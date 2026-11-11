import { describe, expect, test } from "bun:test";
import { JOB_KIND, isTerminalWorkItemState } from "../src/core";
import { applyLinearCommand, claimNextJob, completeJob, getWorkItem, sqliteDb } from "../src/db";
import { questionEffects } from "../src/loop";
import { answer } from "./questions";
import {
  FIXTURES,
  HOUR,
  MINUTE,
  World,
  allowWrites,
  dump,
  factsOf,
  failWrites,
  leaseRunnerWork,
  unexpectedViolations,
  type Fixture,
  type ItemFacts,
} from "./workflow-world";

type Action =
  | { kind: "crash_start" }
  | { kind: "stop_start" }
  | { kind: "start_again" }
  | { kind: "sweep" }
  | { kind: "settle" }
  | { kind: "advance"; ms: number }
  | { kind: "clock_back"; ms: number }
  | { kind: "answer"; item: number; delivery: number }
  | { kind: "stop"; item: number }
  | { kind: "write_failure"; point: number }
  | { kind: "reconnect"; item: number }
  | { kind: "ack"; twice: boolean; crashBefore: boolean };

type Sequence = { seed: number; fixtures: Fixture[]; actions: Action[] };

const WRITE_POINTS = [
  "AFTER INSERT ON job",
  "AFTER UPDATE ON job",
  "AFTER UPDATE ON work_item",
  "AFTER INSERT ON question",
  "AFTER UPDATE ON run",
];
const ACK_QUEUES = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify, JOB_KIND.merge];
const HOLDS = new Set(["paused", "manual", "failed"]);

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function generate(seed: number, steps = 14, size = 7): Sequence {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const fixtures = [...FIXTURES].sort(() => next() - 0.5).slice(0, size);
  const actions: Action[] = [];
  for (let step = 0; step < steps; step++) {
    const item = Math.floor(next() * size);
    const roll = next();
    actions.push(
      roll < 0.16
        ? { kind: "crash_start" }
        : roll < 0.24
          ? { kind: "stop_start" }
          : roll < 0.3
            ? { kind: "start_again" }
            : roll < 0.4
              ? { kind: "sweep" }
              : roll < 0.46
                ? { kind: "settle" }
                : roll < 0.56
                  ? { kind: "advance", ms: pick([MINUTE, 6 * MINUTE, 30 * MINUTE, 3 * HOUR]) }
                  : roll < 0.6
                    ? { kind: "clock_back", ms: pick([MINUTE, HOUR]) }
                    : roll < 0.7
                      ? { kind: "answer", item, delivery: Math.floor(next() * 2) }
                      : roll < 0.76
                        ? { kind: "stop", item }
                        : roll < 0.84
                          ? {
                              kind: "write_failure",
                              point: Math.floor(next() * WRITE_POINTS.length),
                            }
                          : roll < 0.9
                            ? { kind: "reconnect", item }
                            : { kind: "ack", twice: next() < 0.5, crashBefore: next() < 0.5 },
    );
  }
  return { seed, fixtures, actions };
}

async function apply(w: World, sequence: Sequence, action: Action): Promise<void> {
  const id = (index: number) => sequence.fixtures[index % sequence.fixtures.length]!;
  switch (action.kind) {
    case "crash_start":
      w.crash();
      w.start();
      return;
    case "stop_start":
      w.stop();
      w.start();
      return;
    case "start_again":
      w.start();
      return;
    case "sweep":
      await w.sweep();
      return;
    case "settle":
      await w.settle();
      return;
    case "advance":
      w.advance(action.ms);
      return;
    case "clock_back":
      w.advance(-action.ms);
      return;
    case "answer": {
      const item = getWorkItem(w.db, id(action.item))!;
      if (item.sessionKey === null) return;
      const reply = {
        sessionId: item.sessionKey,
        deliveryId: `reply-${action.delivery}`,
        body: "Go ahead",
        answeredBy: "lead",
        now: w.now,
      };
      const first = await answer(w.db, reply, questionEffects(w.db, { now: w.now }));
      const after = dump(w.db);
      w.crash();
      const again = await answer(w.db, reply, questionEffects(w.db, { now: w.now }));
      if (first.status === "answered") expect(again.status).toBe("duplicate");
      expect(dump(w.db)).toEqual(after);
      return;
    }
    case "stop":
      await applyLinearCommand(sqliteDb(w.db), {
        type: "stop",
        itemId: id(action.item),
        source: "linear",
        requestedAt: w.now,
      });
      return;
    case "write_failure": {
      const before = dump(w.db);
      failWrites(w.db, WRITE_POINTS[action.point]!);
      let failed = false;
      try {
        w.start();
      } catch (error) {
        failed = true;
        expect(String(error)).toContain("injected write failure");
      } finally {
        allowWrites(w.db);
      }
      if (failed) expect(dump(w.db)).toEqual(before);
      w.crash();
      w.start();
      return;
    }
    case "reconnect": {
      const item = getWorkItem(w.db, id(action.item))!;
      const open = w.db
        .query<{ generation: number }, [string]>(
          "SELECT generation FROM runner_work WHERE run_id=? AND ended_at IS NULL",
        )
        .get(item.currentRunId ?? "");
      if (open !== null) leaseRunnerWork(w.db, item.currentRunId!, w.now, MINUTE, open.generation);
      return;
    }
    case "ack": {
      const job = claimNextJob(w.db, { now: w.now, queues: ACK_QUEUES });
      if (job === null) return;
      if (action.crashBefore) {
        w.crash();
        return;
      }
      expect(completeJob(w.db, job, w.now)).toBe(true);
      if (action.twice) expect(completeJob(w.db, job, w.now)).toBe(false);
      return;
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`unknown action ${JSON.stringify(exhaustive)}`);
    }
  }
}

function transitionFailure(
  id: string,
  before: ItemFacts,
  after: ItemFacts,
  action: Action,
  sequence: Sequence,
): string | null {
  const own = (kind: Action["kind"]) =>
    action.kind === kind &&
    "item" in action &&
    sequence.fixtures[action.item % sequence.fixtures.length] === id;
  if (after.version < before.version) return `${id}: version went back`;
  if (isTerminalWorkItemState(before.state) && after.state !== before.state)
    return `${id}: terminal ${before.state} revived as ${after.state}`;
  const released = own("stop") || (own("answer") && before.state === "awaiting_input");
  if ((HOLDS.has(before.state) || before.state === "awaiting_input") && !released)
    if (after.state !== before.state) return `${id}: hold ${before.state} left for ${after.state}`;
  if (!released && after.recoveryAttempts < before.recoveryAttempts)
    return `${id}: recovery budget reset from ${before.recoveryAttempts}`;
  if (before.mergeCall && !after.mergeCall) return `${id}: unknown merge outcome forgotten`;
  if (id === "verifying_rejected" && after.acceptedHead !== null)
    return `${id}: rejected head accepted again`;
  if (id === "verifying_rejected" && after.state === "merge_queue")
    return `${id}: rejected head reached the merge queue`;
  return null;
}

async function failure(sequence: Sequence): Promise<string | null> {
  const w = await new World().seed(sequence.fixtures);
  const ids = sequence.fixtures;
  try {
    for (const [step, action] of sequence.actions.entries()) {
      const before = new Map<Fixture, ItemFacts>();
      for (const id of ids) before.set(id, await factsOf(w.db, id));
      try {
        await apply(w, sequence, action);
      } catch (error) {
        return `step ${step} ${action.kind} threw: ${String(error)}`;
      }
      for (const id of ids) {
        const broken = transitionFailure(
          id,
          before.get(id)!,
          await factsOf(w.db, id),
          action,
          sequence,
        );
        if (broken) return `step ${step} ${action.kind}: ${broken}`;
      }
      const unsafe = await unexpectedViolations(w.db, w.now, { liveness: false });
      if (unsafe.length > 0) return `step ${step} ${action.kind}: ${unsafe.join("; ")}`;
    }
    w.crash();
    w.start();
    await w.settle();
    const stuck = await unexpectedViolations(w.db, w.now);
    if (stuck.length > 0) return `after settling: ${stuck.join("; ")}`;
    return null;
  } finally {
    w.close();
  }
}

async function shrink(sequence: Sequence): Promise<Sequence> {
  let current = sequence;
  for (let changed = true; changed;) {
    changed = false;
    for (let index = 0; index < current.actions.length; index++) {
      const actions = current.actions.filter((_, other) => other !== index);
      const candidate = { ...current, actions };
      if ((await failure(candidate)) !== null) {
        current = candidate;
        changed = true;
        break;
      }
    }
    for (let index = 0; index < current.fixtures.length && !changed; index++) {
      if (current.fixtures.length === 1) break;
      const fixtures = current.fixtures.filter((_, other) => other !== index);
      const candidate = { ...current, fixtures };
      if ((await failure(candidate)) !== null) {
        current = candidate;
        changed = true;
      }
    }
  }
  return current;
}

async function check(sequence: Sequence): Promise<void> {
  const found = await failure(sequence);
  if (found === null) return;
  const minimal = await shrink(sequence);
  throw new Error(
    `seed ${sequence.seed}: ${found}\nminimal reproducer (add to REPRODUCERS):\n${JSON.stringify({
      ...minimal,
      failure: await failure(minimal),
    })}`,
  );
}

const SEEDS = Number(process.env.PAWS_WORKFLOW_SEEDS ?? 16);
const FIRST_SEED = Number(process.env.PAWS_WORKFLOW_FIRST_SEED ?? 1);

const REPRODUCERS: { name: string; sequence: Sequence }[] = [
  {
    name: "PAS-953: a startup re-verify beside kept merge places cancels only its own jobs",
    sequence: {
      seed: 0,
      fixtures: ["merge_active_run", "merge_queue", "merge_inflight"],
      actions: [{ kind: "crash_start" }, { kind: "start_again" }, { kind: "settle" }],
    },
  },
  {
    name: "PAS-952/965: an expired runner lease in verification re-verifies after restarts",
    sequence: {
      seed: 0,
      fixtures: ["verifying_leased", "verifying_candidate"],
      actions: [
        { kind: "advance", ms: 30 * MINUTE },
        { kind: "sweep" },
        { kind: "stop_start" },
        { kind: "settle" },
        { kind: "crash_start" },
      ],
    },
  },
  {
    name: "PAS-941: repeated startups, lost acknowledgements and an answer keep one decision",
    sequence: {
      seed: 0,
      fixtures: ["running_resumed", "awaiting_input"],
      actions: [
        { kind: "crash_start" },
        { kind: "ack", twice: true, crashBefore: false },
        { kind: "crash_start" },
        { kind: "answer", item: 1, delivery: 0 },
        { kind: "answer", item: 1, delivery: 0 },
        { kind: "answer", item: 1, delivery: 1 },
        { kind: "settle" },
      ],
    },
  },
  {
    name: "PAS-956: a stop and restarts while a merge outcome is unknown keep the lane's claim",
    sequence: {
      seed: 0,
      fixtures: ["merge_inflight"],
      actions: [
        { kind: "stop", item: 0 },
        { kind: "write_failure", point: 0 },
        { kind: "clock_back", ms: HOUR },
        { kind: "crash_start" },
        { kind: "settle" },
      ],
    },
  },
  {
    name: "PAS-955: parked and backed-off waits survive crashes, sweeps and clock steps",
    sequence: {
      seed: 0,
      fixtures: ["parked_wait", "transient_retry"],
      actions: [
        { kind: "crash_start" },
        { kind: "clock_back", ms: HOUR },
        { kind: "start_again" },
        { kind: "advance", ms: 3 * HOUR },
        { kind: "stop_start" },
        { kind: "settle" },
      ],
    },
  },
];

describe("seeded workflow sequences", () => {
  for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++)
    test(`seed ${seed}`, async () => await check(generate(seed)));
});

describe("preserved reproducers", () => {
  for (const { name, sequence } of REPRODUCERS) test(name, async () => await check(sequence));

  test("a generated sequence is the same for the same seed", () => {
    expect(generate(7)).toEqual(generate(7));
  });
});
