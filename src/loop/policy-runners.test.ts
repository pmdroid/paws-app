import { describe, expect, test } from "bun:test";
import { listPolicyRunnerWarnings, type Db } from "../db";
import { setJournalSink } from "../journal";
import { checkPolicyRunners } from "./policy-runners";
import { seed, withoutForeignKeys } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

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

async function database() {
  const db = (await tempStore()).db;
  await withoutForeignKeys(db);
  return db;
}

function runner(db: Db, id: string, version: string, lastSeenAt: number) {
  return seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id,
        workspaceId: "ws",
        ownerUserId: "user",
        name: id,
        status: "active",
        createdAt: NOW,
        lastSeenAt,
      }),
    (q) =>
      q.orm
        .insert(q.t.runnerHostStatus)
        .values({ runnerId: id, runnerVersion: version, reportedAt: lastSeenAt }),
  );
}

function check(db: Db, digest = DIGEST) {
  return checkPolicyRunners(db, {
    repository: REPOSITORY,
    digest,
    files: CI_POLICY,
    now: NOW,
  });
}

describe("a Closeout policy key the lowest online runner does not know", () => {
  test("is recorded for the dashboard and journaled once", async () => {
    const db = await database();
    await runner(db, "new", "0.1.53", NOW - 1_000);
    await runner(db, "old", "0.1.48", NOW - 1_000);
    // Offline for ten minutes: it takes no work, so it does not count.
    await runner(db, "gone", "0.1.40", NOW - 600_000);
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      for (let pass = 0; pass < 3; pass++)
        expect(await check(db)).toEqual({
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
    expect(await listPolicyRunnerWarnings(db)).toEqual([
      {
        repository: REPOSITORY,
        policyDigest: DIGEST,
        runnerVersion: "0.1.48",
        keys: [{ key: "items[].ci", needs: "0.1.53" }],
        checkedAt: NOW,
      },
    ]);
  });

  test("clears once every online runner knows the policy's keys", async () => {
    const db = await database();
    await runner(db, "old", "0.1.48", NOW - 1_000);
    expect(await check(db)).not.toBeNull();
    await seed(db, (q) => q.orm.update(q.t.runnerHostStatus).set({ runnerVersion: "0.1.53" }));
    expect(await check(db)).toBeNull();
    expect(await listPolicyRunnerWarnings(db)).toEqual([]);
  });

  test("with no runner online there is nothing to compare", async () => {
    const db = await database();
    await runner(db, "gone", "0.1.40", NOW - 600_000);
    expect(await check(db)).toBeNull();
    expect(await listPolicyRunnerWarnings(db)).toEqual([]);
  });
});
