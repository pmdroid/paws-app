import { expect, test } from "bun:test";
import { enqueueJob, enqueueOutbox, getJob, getOutbox } from "../src/db";
import { migration } from "../src/db/migrations/20261027T2209_dead_code_cleanup";
import { tempDb } from "./helpers";

const DROPPED = [
  "github_poll_state",
  "github_seen",
  "github_label_state",
  "runner_verifier",
  "runner_check_execution",
  "runner_check_attempt",
];

test("migrating drops the tables no code reads or writes", () => {
  const db = tempDb();
  try {
    for (const name of DROPPED)
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name)).toBeNull();
  } finally {
    db.close();
  }
});

test("the cleanup renames linear.activity rows and cancels linear.epic.reconcile jobs", () => {
  const db = tempDb();
  try {
    const legacy = enqueueOutbox(db, {
      target: "linear",
      op: "linear.activity",
      idempotencyKey: "legacy",
      payload: { kind: "thought", body: "hello" },
    });
    const elicitation = enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      idempotencyKey: "ask",
      payload: {},
    });
    const epic = enqueueJob(db, { queue: "linear.epic.reconcile", payload: {}, now: 1 });
    const sweep = enqueueJob(db, { queue: "linear.epics.reconcile", payload: {}, now: 1 });
    db.run(migration.sql);
    expect(getOutbox(db, legacy)?.op).toBe("activity");
    expect(getOutbox(db, elicitation)?.op).toBe("elicitation");
    expect(getJob(db, epic)?.status).toBe("cancelled");
    expect(getJob(db, sweep)?.status).toBe("pending");
  } finally {
    db.close();
  }
});
