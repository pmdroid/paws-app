import { describe, expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import { listJobs, type Job } from "../src/db";
import {
  AGENT_QUEUES,
  FIXTURES,
  HOUR,
  MINUTE,
  ORPHANED_MERGE_CALL,
  STARTUP_RESUME_DUPLICATE,
  SETTLE_MS,
  World,
  allowWrites,
  dump,
  factsOf,
  failWrites,
  unexpectedViolations,
  violations,
  type Fixture,
} from "./workflow-world";

type Entry = { startup: boolean; longGap?: true; run: (w: World) => Promise<void> };

const WRITE_FAILURES = [
  "AFTER INSERT ON job",
  "AFTER UPDATE ON work_item",
  "AFTER INSERT ON work_item_event",
];

const ENTRIES: Record<string, Entry> = {
  crash: {
    startup: true,
    run: async (w) => {
      w.crash();
      w.start();
    },
  },
  sigterm: {
    startup: true,
    run: async (w) => {
      w.stop();
      w.start();
    },
  },
  repeated_startup: {
    startup: true,
    run: async (w) => {
      for (let n = 0; n < 3; n++) {
        w.crash();
        w.advance(MINUTE);
        w.start();
      }
    },
  },
  partition: {
    startup: false,
    run: async (w) => {
      for (let elapsed = 0; elapsed < SETTLE_MS; elapsed += MINUTE) {
        w.advance(MINUTE);
        w.renewJobLeases();
        await w.sweep();
      }
    },
  },
  clock_back: {
    startup: true,
    run: async (w) => {
      w.crash();
      w.advance(-HOUR);
      w.start();
    },
  },
  clock_jump: {
    startup: true,
    longGap: true,
    run: async (w) => {
      w.stop();
      w.advance(3 * HOUR);
      w.start();
    },
  },
  ...Object.fromEntries(
    WRITE_FAILURES.map((point) => [
      `write_failure ${point}`,
      {
        startup: true,
        run: async (w: World) => {
          w.crash();
          const before = dump(w.db);
          failWrites(w.db, point);
          expect(() => w.start()).toThrow("injected write failure");
          allowWrites(w.db);
          expect(dump(w.db)).toEqual(before);
          w.crash();
          w.start();
        },
      },
    ]),
  ),
};

const UNCHANGED: readonly Fixture[] = [
  "queued",
  "paused",
  "awaiting_input",
  "awaiting_merge_help",
  "manual",
  "failed",
  "completed",
  "merged",
  "cancelled",
];
const REVERIFIERS: readonly Fixture[] = [
  "verifying_candidate",
  "verifying_leased",
  "verifying_rejected",
];
const KEEP_PLACE: readonly Fixture[] = ["merge_queue", "merge_inflight"];
const WAITERS: readonly Fixture[] = ["parked_wait", "transient_retry"];

function itemJobs(w: World, id: string): Job[] {
  return listJobs(w.db).filter((job) => (job.payload as { itemId?: string }).itemId === id);
}

function live(jobs: Job[]): Job[] {
  return jobs.filter((job) => job.status === "pending" || job.status === "running");
}

async function expectations(
  w: World,
  entry: Entry,
  initial: Map<Fixture, InitialFacts>,
): Promise<void> {
  for (const id of UNCHANGED) {
    const held = (facts: Awaited<ReturnType<typeof factsOf>>) =>
      facts.state === "awaiting_input" ? { ...facts, runStatus: "released" } : facts;
    expect([id, held(await factsOf(w.db, id))]).toEqual([id, held(initial.get(id)!.facts)]);
  }
  for (const id of REVERIFIERS) {
    const jobs = live(itemJobs(w, id)).filter((job) => job.status === "pending");
    expect([id, jobs.filter((job) => AGENT_QUEUES.includes(job.queue))]).toEqual([id, []]);
    expect([id, (await factsOf(w.db, id)).state]).not.toEqual([id, "merge_queue"]);
  }
  expect((await factsOf(w.db, "verifying_rejected")).acceptedHead).toBeNull();
  expect(itemJobs(w, "verifying_rejected").some((job) => job.queue === JOB_KIND.merge)).toBe(false);
  for (const id of KEEP_PLACE) {
    const facts = await factsOf(w.db, id);
    expect([id, facts.state, facts.mergeCall]).toEqual([
      id,
      "merge_queue",
      id === "merge_inflight",
    ]);
    const merge = live(itemJobs(w, id)).filter((job) => job.queue === JOB_KIND.merge);
    expect([id, merge.map((job) => job.id)]).toEqual([id, initial.get(id)!.jobIds]);
    expect(itemJobs(w, id).some((job) => job.queue === JOB_KIND.reverify)).toBe(false);
  }
  for (const id of WAITERS) {
    const jobs = live(itemJobs(w, id));
    expect([id, jobs.map((job) => [job.id, job.status, job.payload])]).toEqual([
      id,
      initial.get(id)!.jobs.map((job) => [job.id, "pending", job.payload]),
    ]);
    expect((await factsOf(w.db, id)).recoveryAttempts).toBe(0);
  }
  if (!entry.longGap) expect((await factsOf(w.db, "running_leased")).recoveryAttempts).toBe(0);
  const resumed = await factsOf(w.db, "running_resumed");
  if (entry.longGap) {
    expect(resumed.restartHold).toBe(false);
    expect(resumed.liveJobs.filter((job) => job.endsWith(":pending"))).toEqual([
      "run.resume:pending",
    ]);
  } else if (entry.startup) {
    expect(resumed.restartHold).toBe(true);
    expect(resumed.liveJobs).toEqual(["item.ask:pending"]);
  } else expect(resumed.state).toBe("running");
}

type InitialFacts = { facts: Awaited<ReturnType<typeof factsOf>>; jobs: Job[]; jobIds: number[] };

describe("every combined state through every recovery entry", () => {
  for (const [name, entry] of Object.entries(ENTRIES))
    test(name, async () => {
      const w = await new World().seed(FIXTURES);
      try {
        expect(await violations(w.db, w.now)).toEqual([]);
        const initial = new Map<Fixture, InitialFacts>();
        for (const id of FIXTURES) {
          const jobs = live(itemJobs(w, id));
          const merge = jobs.filter((job) => job.queue === JOB_KIND.merge).map((job) => job.id);
          initial.set(id, { facts: await factsOf(w.db, id), jobs, jobIds: merge });
        }
        await entry.run(w);
        expect(await unexpectedViolations(w.db, w.now)).toEqual([]);
        await expectations(w, entry, initial);
        await w.settle();
        expect(await unexpectedViolations(w.db, w.now)).toEqual([]);
        await expectations(w, entry, initial);
      } finally {
        w.close();
      }
    });
});

describe("preserved reproducers for open gaps", () => {
  test.failing(
    `${STARTUP_RESUME_DUPLICATE} (fix pending; remove .failing when it lands)`,
    async () => {
      const w = await new World().seed(["recovering"]);
      try {
        w.crash();
        w.start();
        expect(await violations(w.db, w.now)).toEqual([]);
      } finally {
        w.close();
      }
    },
  );

  test.failing(`${ORPHANED_MERGE_CALL} (fix pending; remove .failing when it lands)`, async () => {
    const w = await new World().seed(["merge_inflight"]);
    try {
      w.db.run(
        "UPDATE job SET status='dead', last_error='attempts exhausted', finished_at=? WHERE queue=?",
        [w.now, JOB_KIND.merge],
      );
      await w.settle();
      expect(await violations(w.db, w.now)).toEqual([]);
    } finally {
      w.close();
    }
  });
});
