import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJournalSink } from "../src/db";
import {
  contenderExited,
  probeSchedulerAdmission,
  probeSchedulerFootprints,
  probeSchedulerLocks,
  probeSchedulerMerges,
  probeSchedulerReservations,
  probeSchedulerRest,
  spawnContender,
} from "./local/scheduler";

async function probed(
  probe: (root: string, observe: (name: string, passed: boolean) => void) => Promise<void>,
  expected: string[],
) {
  const root = mkdtempSync(join(tmpdir(), "paws-scheduler-"));
  const observations: string[] = [];
  const journaled: string[] = [];
  const restore = setJournalSink((line) => journaled.push(line));
  try {
    await probe(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.deepEqual(observations, expected);
    assert.deepEqual(
      journaled.filter((line) => line.startsWith("claim gate disagreement")),
      [],
    );
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
}

test("Twenty scheduler processes admit each ready item once", async () => {
  await probed(probeSchedulerAdmission, [
    "Twenty processes atomically admit every ready item once",
  ]);
}, 60_000);

test("Scheduler reservations survive concurrent claims and restarts", async () => {
  await probed(
    (_root, observe) => probeSchedulerReservations(observe),
    [
      "Reserved jobs claim concurrently but the same item cannot resume twice",
      "Restart retains queued or active reservations",
    ],
  );
}, 60_000);

test("Scheduler footprints run in separate task workspaces", async () => {
  await probed(
    (_root, observe) => probeSchedulerFootprints(observe),
    [
      "overlap footprints execute independently in separate task workspaces",
      "hot footprints execute independently in separate task workspaces",
      "unknown footprints execute independently in separate task workspaces",
      "Root-segment globs do not serialize private task workspaces",
    ],
  );
}, 60_000);

test("Scheduler releases locks and cancels removed starts", async () => {
  await probed(
    (_root, observe) => probeSchedulerLocks(observe),
    [
      "A claimed start retains its locks until the actual job holder releases",
      "Removing admissions cancels pending and expired starts before a later restart",
    ],
  );
}, 60_000);

test("Scheduler admits around merges and keeps sessions apart", async () => {
  await probed(
    (_root, observe) => probeSchedulerMerges(observe),
    [
      "A live merge admits a same-session sibling with an overlapping footprint",
      "Active or provisioning runs do not block another ready item",
      "Separate sessions cannot execute the same Linear issue concurrently",
    ],
  );
}, 60_000);

test("Scheduler dispatch orders, retracts and recurs durably", async () => {
  await probed(
    (_root, observe) => probeSchedulerRest(observe),
    [
      "A waiting task without live work releases capacity for two independent tasks",
      "Failure after job insertion rolls back the whole dispatch",
      "Critical path wins before age with deterministic ties",
      "Workspace dispatch requires an authoritative snapshot and retracts stale queued jobs",
      "Two canonical sessions admit every ready item and each activates one",
      "Pending reconciliation effects prevent and retract queued admissions",
      "Unknown project identity does not cap ready items across repositories",
      "Queued restart cannot claim while its previous run is still draining",
      "A durable thirty-second scheduler tick recurs without duplicate starts",
      "Opted-in production job workers execute both reserved handlers together",
    ],
  );
}, 60_000);

test("A failing scheduler contender names its error in the assertion", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-scheduler-contender-"));
  try {
    // A file where the contender expects its directory: it cannot read the database URL.
    writeFileSync(join(root, "file"), "");
    await assert.rejects(
      contenderExited(spawnContender(join(root, "file"), 0)),
      /exited 1 \(signal none\)\nstderr: Scheduler contender 0 failed: .*ENOTDIR: not a directory, open/s,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
