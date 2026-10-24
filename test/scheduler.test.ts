import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJournalSink } from "../src/db";
import { probeScheduler } from "./local/scheduler";

test("Scheduler dispatch is durable and admits each ready item once across processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-scheduler-"));
  const observations: string[] = [];
  const journaled: string[] = [];
  const restore = setJournalSink((line) => journaled.push(line));
  try {
    await probeScheduler(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.deepEqual(observations, [
      "Twenty processes atomically admit every ready item once",
      "Reserved jobs claim concurrently but the same item cannot resume twice",
      "Restart retains queued or active reservations",
      "overlap footprints execute independently in separate task workspaces",
      "hot footprints execute independently in separate task workspaces",
      "unknown footprints execute independently in separate task workspaces",
      "Root-segment globs do not serialize private task workspaces",
      "A claimed start retains its locks until the actual job holder releases",
      "Removing admissions cancels pending and expired starts before a later restart",
      "A live merge admits a same-session sibling with an overlapping footprint",
      "Active or provisioning runs do not block another ready item",
      "A waiting task without live work releases capacity for two independent tasks",
      "Separate sessions cannot execute the same Linear issue concurrently",
      "Failure after job insertion rolls back the whole dispatch",
      "Critical path wins before age with deterministic ties",
      "Workspace dispatch requires an authoritative snapshot and retracts stale queued jobs",
      "Two canonical sessions admit every ready item and each activates one",
      "Pending reconciliation effects prevent and retract queued admissions",
      "Unknown project identity does not cap ready items across repositories",
      "Queued restart cannot claim while its previous run is still draining",
      "A durable thirty-second scheduler tick recurs without duplicate starts",
      "Opted-in production job workers execute both reserved handlers together",
    ]);
    assert.deepEqual(
      journaled.filter((line) => line.startsWith("claim gate disagreement")),
      [],
    );
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});
