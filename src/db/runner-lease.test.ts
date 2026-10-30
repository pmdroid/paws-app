import { describe, expect, test } from "bun:test";
import { FakeClock, type Checkpoint } from "../core";
import { RUNNER_LEASE_GRACE_MS } from "../runner-protocol";
import {
  beginImplementRun,
  halt,
  getRun,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  recoverOnStartup,
  runnerHasCapacity,
  runnerLeaseLive,
  runnerOccupancy,
  runnerSlotsHeldBetweenCommands,
  runnerWorkSettled,
  runnerHoldsRunWork,
  runnerWorkHasResult,
} from "./index";

const RENEWAL_MS = 60_000;
const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 2, baseSha: "base" };

/** One running item whose runner renewed its lease at the start time, as `renew()` does. */
function leased() {
  const clock = new FakeClock(1_000_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { now: clock.now() });
  const { run } = beginImplementRun(db, item.id, clock.now(), checkpoint);
  db.run("PRAGMA foreign_keys=OFF");
  const leaseUntil = clock.now() + RENEWAL_MS;
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,?,?,?,?,?,?)",
    [run.id, "runner", "workspace", 1, 0, "command", leaseUntil],
  );
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
    test(`recovery keeps the run ${label}`, () => {
      const { clock, db, item, run } = leased();
      clock.advance(away);
      expect(recoverOnStartup(db, clock.now())).toMatchObject([{ type: "resume", reattach: true }]);
      expect(getWorkItem(db, item.id)).toMatchObject({ state: "running", recoveryAttempts: 0 });
      expect(getRun(db, run.id)?.status).toBe("active");
    });

    test(`capacity counts the slot ${label}`, () => {
      const { clock, db, run } = leased();
      clock.advance(away);
      expect(runnerOccupancy(db, "runner", clock.now())).toEqual({ capacity: 1, occupied: 1 });
      expect(runnerHasCapacity(db, "runner", clock.now())).toBe(false);
      expect(runnerHasCapacity(db, "runner", clock.now(), run.id)).toBe(true);
      expect(runnerSlotsHeldBetweenCommands(db, "runner", clock.now())).toBe(0);
    });

    test(`the halt core waits ${label}`, () => {
      const { clock, db, run } = leased();
      clock.advance(away);
      expect(runnerWorkSettled(db, run.id, clock.now())).toBe(false);
    });
  }

  test("recovery fences the run past the grace", () => {
    const { clock, db, item } = leased();
    clock.advance(PAST);
    expect(recoverOnStartup(db, clock.now())).toEqual([
      { type: "resume", freshSession: true, checkpoint },
    ]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
  });

  test("capacity frees the lease past the grace and closes the run that never ended", () => {
    const { clock, db, run } = leased();
    clock.advance(PAST);
    expect(runnerOccupancy(db, "runner", clock.now())).toEqual({ capacity: 1, occupied: 0 });
    expect(runnerSlotsHeldBetweenCommands(db, "runner", clock.now())).toBe(0);
    expect(getRun(db, run.id)?.status).toBe("lost");
    expect(
      db
        .query<{ endedAt: number | null }, [string]>(
          "SELECT ended_at AS endedAt FROM runner_work WHERE run_id=?",
        )
        .get(run.id)?.endedAt,
    ).toBe(clock.now());
  });

  test("a finished command still holds its slot after the lease grace", () => {
    const { clock, db, run } = leased();
    db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [clock.now(), run.id]);
    clock.advance(PAST);
    expect(runnerSlotsHeldBetweenCommands(db, "runner", clock.now())).toBe(1);
    expect(getRun(db, run.id)?.status).toBe("active");
  });

  test("halt keeps an unsettled runner occupied through the grace", () => {
    const { clock, db, item, run } = leased();
    clock.advance(RENEWAL_MS + 59_000);
    halt(db, getWorkItem(db, item.id)!, clock.now());
    expect(getRun(db, run.id)?.status).toBe("ended");
    expect(runnerHasCapacity(db, "runner", clock.now())).toBe(false);
    clock.advance(RUNNER_LEASE_GRACE_MS);
    expect(runnerHasCapacity(db, "runner", clock.now())).toBe(true);
  });

  test("the halt core may release past the grace", () => {
    const { clock, db, run } = leased();
    clock.advance(PAST);
    expect(runnerWorkSettled(db, run.id, clock.now())).toBe(true);
  });

  test("the halt core may release inside the grace once the runner sent its result", () => {
    const { clock, db, run } = leased();
    clock.advance(RENEWAL_MS + 59_000);
    db.run(
      "INSERT INTO runner_result(run_id,generation,command_id,payload,received_at) VALUES(?,1,'command','{}',?)",
      [run.id, clock.now()],
    );
    expect(runnerWorkSettled(db, run.id, clock.now())).toBe(true);
  });

  test("recovery retains a delivered current-command result after lease grace", () => {
    const { clock, db, item, run } = leased();
    clock.advance(PAST);
    expect(runnerHoldsRunWork(db, run.id, clock.now())).toBe(false);
    db.run(
      "INSERT INTO runner_result(run_id,generation,command_id,payload,received_at) VALUES(?,1,'other','{}',?)",
      [run.id, clock.now()],
    );
    expect(runnerWorkHasResult(db, run.id)).toBe(false);
    db.run("UPDATE runner_result SET command_id='command' WHERE run_id=?", [run.id]);
    expect(runnerHoldsRunWork(db, run.id, clock.now())).toBe(true);
    expect(runnerWorkHasResult(db, run.id)).toBe(true);
    expect(runnerSlotsHeldBetweenCommands(db, "runner", clock.now())).toBe(1);
    expect(getRun(db, run.id)?.status).toBe("active");
    expect(runnerHoldsRunWork(db, run.id, clock.now(), true)).toBe(false);
    expect(recoverOnStartup(db, clock.now())).toMatchObject([{ type: "resume", reattach: true }]);
    expect(getWorkItem(db, item.id)?.state).toBe("running");
    expect(getRun(db, run.id)?.status).toBe("active");
    db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [clock.now(), run.id]);
    expect(runnerWorkHasResult(db, run.id)).toBe(false);
    db.close();
  });

  test("the halt core may release inside the grace once the runner acknowledged a cancel", () => {
    const { clock, db, run } = leased();
    clock.advance(RENEWAL_MS + 59_000);
    db.run(
      "INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at,acknowledged_at) VALUES('cancel','runner',?,1,'cancel','{}',?,NULL)",
      [run.id, clock.now() + 65_000],
    );
    expect(runnerWorkSettled(db, run.id, clock.now())).toBe(false);
    db.run("UPDATE runner_command SET acknowledged_at=? WHERE id='cancel'", [clock.now()]);
    expect(runnerWorkSettled(db, run.id, clock.now())).toBe(true);
  });
});
