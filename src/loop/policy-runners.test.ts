import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listPolicyRunnerWarnings, migrate, openDatabase } from "../db";
import { setJournalSink } from "../journal";
import { checkPolicyRunners } from "./policy-runners";

const NOW = Date.parse("2026-10-28T06:43:00.000Z");
const REPOSITORY = "pmdroid/paws-app";
const DIGEST = `sha256:${"a".repeat(64)}`;

const CI_POLICY = new Map([
  [
    ".agents/closeout.yaml",
    new TextEncoder().encode(`specVersion: "0.1"
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test"]
    timeoutSeconds: 600
    ci: "test (*)"
`),
  ],
]);

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  // The runners stand alone here: no workspace members to own them.
  db.run("PRAGMA foreign_keys=OFF");
  return db;
}

function runner(db: Database, id: string, version: string, lastSeenAt: number): void {
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
    [id, "ws", "user", id, NOW, lastSeenAt],
  );
  db.run("INSERT INTO runner_host_status(runner_id,runner_version,reported_at) VALUES(?,?,?)", [
    id,
    version,
    lastSeenAt,
  ]);
}

function check(db: Database, digest = DIGEST) {
  return checkPolicyRunners(db, { repository: REPOSITORY, digest, files: CI_POLICY, now: NOW });
}

describe("a Closeout policy key the lowest online runner does not know", () => {
  test("is recorded for the dashboard and journaled once", () => {
    const db = database();
    runner(db, "new", "0.1.53", NOW - 1_000);
    runner(db, "old", "0.1.48", NOW - 1_000);
    // Offline for ten minutes: it takes no work, so it does not count.
    runner(db, "gone", "0.1.40", NOW - 600_000);
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      for (let pass = 0; pass < 3; pass++)
        expect(check(db)).toEqual({
          repository: REPOSITORY,
          policyDigest: DIGEST,
          runnerVersion: "0.1.48",
          keys: [{ key: "items[].ci", needs: "0.1.53" }],
          checkedAt: NOW,
        });
    } finally {
      restore();
    }
    expect(lines.filter((line) => line.includes("items[].ci (runner 0.1.53)"))).toHaveLength(1);
    expect(lines[0]).toContain("the lowest online runner is 0.1.48");
    expect(listPolicyRunnerWarnings(db)).toEqual([
      {
        repository: REPOSITORY,
        policyDigest: DIGEST,
        runnerVersion: "0.1.48",
        keys: [{ key: "items[].ci", needs: "0.1.53" }],
        checkedAt: NOW,
      },
    ]);
  });

  test("clears once every online runner knows the policy's keys", () => {
    const db = database();
    runner(db, "old", "0.1.48", NOW - 1_000);
    expect(check(db)).not.toBeNull();
    db.run("UPDATE runner_host_status SET runner_version='0.1.53'");
    expect(check(db)).toBeNull();
    expect(listPolicyRunnerWarnings(db)).toEqual([]);
  });

  test("with no runner online there is nothing to compare", () => {
    const db = database();
    runner(db, "gone", "0.1.40", NOW - 600_000);
    expect(check(db)).toBeNull();
    expect(listPolicyRunnerWarnings(db)).toEqual([]);
  });
});
