import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { FakeClock, type Checkpoint } from "../core";
import { RUNNER_LEASE_GRACE_MS } from "../runner-protocol";
import {
  beginImplementRun,
  applyWorkItemEvent,
  closeExpiredRunnerLeases,
  enqueueJob,
  claimNextJob,
  halt,
  getRun,
  getWorkItem,
  insertQueuedItem,
  recoverOnStartup,
  runnerHasCapacity,
  runnerLeaseLive,
  runnerOccupancy,
  runnerSlotFree,
  slotWaitRunners,
  runnerSlotsHeldBetweenCommands,
  runnerWorkSettled,
  runnerHoldsRunWork,
  runnerWorkHasResult,
  type Db,
} from "./index";
import { seed, withoutForeignKeys } from "../../test/dialects";
import { tempStore } from "../../test/pglite";
import { seedCommand, seedResult, seedRunner, seedWork } from "../../test/runner-rows";

type WorkChange = { endedAt?: number | null; leaseUntil?: number; teardownConfirmedAt?: number };

function updateWork(db: Db, runIds: string[], set: WorkChange) {
  return seed(db, (q) =>
    q.orm.update(q.t.runnerWork).set(set).where(inArray(q.t.runnerWork.runId, runIds)),
  );
}

function seedCapacity(db: Db, runnerId: string, capacity: number) {
  return seed(db, (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId, capacity }));
}

function workEnded(db: Db, runId: string) {
  return db.run(function* (q) {
    const row = yield* q.one(
      q.orm
        .select({ endedAt: q.t.runnerWork.endedAt })
        .from(q.t.runnerWork)
        .where(eq(q.t.runnerWork.runId, runId)),
    );
    return row?.endedAt;
  });
}

const RENEWAL_MS = 60_000;
const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 2, baseSha: "base" };

/** One running item whose runner renewed its lease at the start time, as `renew()` does. */
const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});

async function leased() {
  const clock = new FakeClock(1_000_000);
  const { db, close } = await tempStore();
  closes.push(close);
  const item = await insertQueuedItem(db, { now: clock.now() });
  const { run } = await beginImplementRun(db, item.id, clock.now(), checkpoint);
  await withoutForeignKeys(db);
  const leaseUntil = clock.now() + RENEWAL_MS;
  await seedWork(db, run.id, "runner", { commandId: "command", leaseUntil });
  return { clock, db, item, run, leaseUntil };
}

// Paws away for 59 s, for 59 s past the lease (the old 60 s cutoff), at the last grace
// millisecond, and past the grace.
const INSIDE = [
  ["59 s after the renewal", 59_000],
  ["59 s after the lease", RENEWAL_MS + 59_000],
  ["at the end of the grace", RENEWAL_MS + RUNNER_LEASE_GRACE_MS - 1],
] as const;
const PAST = RENEWAL_MS + RUNNER_LEASE_GRACE_MS;

describe("the runner lease grace", () => {
  test("a lease is live until the grace ends", () => {
    expect(runnerLeaseLive(1_000, 1_000 + RUNNER_LEASE_GRACE_MS - 1)).toBe(true);
    expect(runnerLeaseLive(1_000, 1_000 + RUNNER_LEASE_GRACE_MS)).toBe(false);
  });

  for (const [label, away] of INSIDE) {
    test(`recovery keeps the run ${label}`, async () => {
      const { clock, db, item, run } = await leased();
      clock.advance(away);
      expect(await recoverOnStartup(db, clock.now())).toMatchObject([
        { type: "resume", reattach: true },
      ]);
      expect(await getWorkItem(db, item.id)).toMatchObject({
        state: "running",
        recoveryAttempts: 0,
      });
      expect((await getRun(db, run.id))?.status).toBe("active");
    });

    test(`capacity counts the slot ${label}`, async () => {
      const { clock, db, run } = await leased();
      clock.advance(away);
      expect(await runnerOccupancy(db, "runner", clock.now())).toEqual({
        capacity: 1,
        occupied: 1,
      });
      expect(await runnerHasCapacity(db, "runner", clock.now())).toBe(false);
      expect(await runnerHasCapacity(db, "runner", clock.now(), run.id)).toBe(true);
      expect(await runnerSlotsHeldBetweenCommands(db, "runner", clock.now())).toBe(0);
    });

    test(`the halt core waits ${label}`, async () => {
      const { clock, db, run } = await leased();
      clock.advance(away);
      expect(await runnerWorkSettled(db, run.id, clock.now())).toBe(false);
    });
  }

  test("recovery fences the run past the grace", async () => {
    const { clock, db, item } = await leased();
    clock.advance(PAST);
    expect(await recoverOnStartup(db, clock.now())).toEqual([
      { type: "resume", freshSession: true, checkpoint },
    ]);
    expect(await getWorkItem(db, item.id)).toMatchObject({
      state: "recovering",
      recoveryAttempts: 1,
    });
  });

  test("capacity frees the lease past the grace and closes the run that never ended", async () => {
    const { clock, db, run, item } = await leased();
    clock.advance(PAST);
    expect(await runnerOccupancy(db, "runner", clock.now())).toEqual({
      capacity: 1,
      occupied: 0,
    });
    expect(await runnerSlotsHeldBetweenCommands(db, "runner", clock.now())).toBe(0);
    // Counting is read-only, including the caller's excluded run.
    expect(await runnerSlotsHeldBetweenCommands(db, "runner", clock.now(), run.id)).toBe(0);
    expect((await getRun(db, run.id))?.status).toBe("active");
    expect(await closeExpiredRunnerLeases(db, clock.now())).toEqual([run.id]);
    expect((await getRun(db, run.id))?.status).toBe("lost");
    expect((await getWorkItem(db, item.id))?.state).toBe("recovering");
    expect(await workEnded(db, run.id)).toBe(clock.now());
  });

  test("the sweep leaves expired work to its live placement owner", async () => {
    const { db, clock, run } = await leased();
    const item = (await getRun(db, run.id))!;
    await enqueueJob(db, {
      queue: "run.resume",
      payload: { itemId: item.itemId },
      now: clock.now(),
    });
    const job = (await claimNextJob(db, {
      now: clock.now(),
      leaseMs: PAST + 60_000,
      queues: ["run.resume"],
    }))!;
    expect(job).not.toBeNull();
    clock.advance(PAST);
    expect(await closeExpiredRunnerLeases(db, clock.now())).toEqual([]);
    expect(await runnerSlotsHeldBetweenCommands(db, "runner", clock.now(), run.id)).toBe(0);
    expect((await getRun(db, run.id))?.status).toBe("active");
    expect(await workEnded(db, run.id)).toBeNull();
  });

  for (const state of ["verifying", "merge_queue"] as const) {
    test(`expired abandoned ${state} work transitions with its lost run`, async () => {
      const { db, clock, run, item } = await leased();
      await applyWorkItemEvent(db, item.id, "turn_ended");
      if (state === "merge_queue") await applyWorkItemEvent(db, item.id, "closeout_accepted");
      clock.advance(PAST);
      expect(await closeExpiredRunnerLeases(db, clock.now())).toEqual([run.id]);
      expect((await getRun(db, run.id))?.status).toBe("lost");
      expect((await getWorkItem(db, item.id))?.state).toBe(
        state === "merge_queue" ? "verifying" : "recovering",
      );
      expect(await runnerSlotsHeldBetweenCommands(db, "runner", clock.now())).toBe(0);
      expect(await closeExpiredRunnerLeases(db, clock.now())).toEqual([]);
    });
  }

  test("a finished command still holds its slot after the lease grace", async () => {
    const { clock, db, run } = await leased();
    await updateWork(db, [run.id], { endedAt: clock.now(), teardownConfirmedAt: clock.now() });
    clock.advance(PAST);
    expect(await runnerSlotsHeldBetweenCommands(db, "runner", clock.now())).toBe(1);
    expect((await getRun(db, run.id))?.status).toBe("active");
  });

  test("halt keeps an unsettled runner occupied through the grace", async () => {
    const { clock, db, item, run } = await leased();
    clock.advance(RENEWAL_MS + 59_000);
    await halt(db, (await getWorkItem(db, item.id))!, clock.now());
    expect((await getRun(db, run.id))?.status).toBe("ended");
    expect(await runnerHasCapacity(db, "runner", clock.now())).toBe(false);
    clock.advance(RUNNER_LEASE_GRACE_MS);
    expect(await runnerHasCapacity(db, "runner", clock.now())).toBe(true);
  });

  test("the halt core may release past the grace", async () => {
    const { clock, db, run } = await leased();
    clock.advance(PAST);
    expect(await runnerWorkSettled(db, run.id, clock.now())).toBe(true);
  });

  test("the halt core may release inside the grace once the runner sent its result", async () => {
    const { clock, db, run } = await leased();
    clock.advance(RENEWAL_MS + 59_000);
    await seedResult(db, run.id, "command", {});
    expect(await runnerWorkSettled(db, run.id, clock.now())).toBe(true);
  });

  test("recovery retains a delivered current-command result after lease grace", async () => {
    const { clock, db, item, run } = await leased();
    clock.advance(PAST);
    expect(await runnerHoldsRunWork(db, run.id, clock.now())).toBe(false);
    await seedResult(db, run.id, "other", {});
    expect(await runnerWorkHasResult(db, run.id)).toBe(false);
    await seed(db, (q) =>
      q.orm
        .update(q.t.runnerResult)
        .set({ commandId: "command" })
        .where(eq(q.t.runnerResult.runId, run.id)),
    );
    expect(await runnerHoldsRunWork(db, run.id, clock.now())).toBe(true);
    expect(await runnerWorkHasResult(db, run.id)).toBe(true);
    expect(await closeExpiredRunnerLeases(db, clock.now())).toEqual([]);
    expect(await runnerSlotsHeldBetweenCommands(db, "runner", clock.now())).toBe(1);
    expect((await getRun(db, run.id))?.status).toBe("active");
    expect(await runnerHoldsRunWork(db, run.id, clock.now(), true)).toBe(false);
    expect(await recoverOnStartup(db, clock.now())).toMatchObject([
      { type: "resume", reattach: true },
    ]);
    expect((await getWorkItem(db, item.id))?.state).toBe("running");
    expect((await getRun(db, run.id))?.status).toBe("active");
    await updateWork(db, [run.id], { endedAt: clock.now() });
    expect(await runnerWorkHasResult(db, run.id)).toBe(false);
  });

  test("the halt core may release inside the grace once the runner acknowledged a cancel", async () => {
    const { clock, db, run } = await leased();
    clock.advance(RENEWAL_MS + 59_000);
    await seedCommand(db, "cancel", {
      runnerId: "runner",
      runId: run.id,
      kind: "cancel",
      expiresAt: clock.now() + 65_000,
    });
    expect(await runnerWorkSettled(db, run.id, clock.now())).toBe(false);
    await seed(db, (q) =>
      q.orm
        .update(q.t.runnerCommand)
        .set({ acknowledgedAt: clock.now() })
        .where(eq(q.t.runnerCommand.id, "cancel")),
    );
    expect(await runnerWorkSettled(db, run.id, clock.now())).toBe(true);
  });
});

describe("slots held between commands", () => {
  test("runs holding slots on a full runner compete only with its live commands", async () => {
    const clock = new FakeClock(1_000_000);
    const { db, close } = await tempStore();
    await withoutForeignKeys(db);
    await seedCapacity(db, "runner", 2);
    const runs = [];
    for (const index of [1, 2, 3, 4]) {
      const item = await insertQueuedItem(db, { id: `item-${index}`, now: clock.now() });
      const { run } = await beginImplementRun(db, item.id, clock.now(), checkpoint);
      await seedWork(db, run.id, "runner", { leaseUntil: clock.now(), endedAt: clock.now() });
      await updateWork(db, [run.id], { teardownConfirmedAt: clock.now() });
      runs.push(run);
    }
    expect(await runnerSlotsHeldBetweenCommands(db, "runner", clock.now(), "new-run")).toBe(4);
    expect(await runnerSlotFree(db, ["runner"], clock.now())).toBe(false);
    for (const run of runs) {
      expect(await runnerSlotsHeldBetweenCommands(db, "runner", clock.now(), run.id)).toBe(0);
      expect(await runnerSlotFree(db, ["runner"], clock.now(), run.id)).toBe(true);
    }
    await updateWork(db, [runs[0]!.id, runs[1]!.id], {
      endedAt: null,
      leaseUntil: clock.now() + RENEWAL_MS,
    });
    expect(await runnerSlotFree(db, ["runner"], clock.now(), runs[2]!.id)).toBe(false);
    await close();
  });

  test("a run never placed also wakes for a runner that came online during its wait", async () => {
    const clock = new FakeClock(1_000_000);
    const { db, close } = await tempStore();
    await withoutForeignKeys(db);
    for (const id of ["busy", "free"]) {
      await seedRunner(db, id, { lastSeenAt: clock.now() });
      await seedCapacity(db, id, 1);
    }
    const started = [];
    for (const id of ["busy", "fresh", "tied"])
      started.push(
        (
          await beginImplementRun(
            db,
            (await insertQueuedItem(db, { id, now: clock.now() })).id,
            clock.now(),
            checkpoint,
          )
        ).run,
      );
    const [busy, fresh, tied] = started;
    await seedWork(db, busy!.id, "busy", {
      commandId: "busy",
      leaseUntil: clock.now() + RENEWAL_MS,
    });
    await seedWork(db, tied!.id, "busy", {
      commandId: "tied",
      leaseUntil: clock.now(),
      endedAt: clock.now(),
    });
    const wait = { since: clock.now(), attempt: 0, runnerIds: ["busy"] };
    const free = async (runId: string, online?: string[]) =>
      await runnerSlotFree(
        db,
        await slotWaitRunners(db, runId, online ? { ...wait, online } : wait, clock.now()),
        clock.now(),
        runId,
      );
    expect(await free(fresh!.id, ["busy"])).toBe(true);
    expect(await free(fresh!.id, ["busy", "free"])).toBe(false);
    expect(await free(fresh!.id)).toBe(true);
    expect(await free(tied!.id, ["busy"])).toBe(false);
    await close();
  });
});
