import { afterEach, expect, test } from "bun:test";
import {
  clearPolicyRunnerWarningSteps,
  listPolicyRunnerWarningsSteps,
  policyKeysLowestRunnerLacksSteps,
  savePolicyRunnerWarningSteps,
} from "../src/db";
import { policyKeysAbove } from "../src/runner-protocol";
import { forEachDialect, seed, withoutForeignKeys, type DialectDb } from "./dialects";
import { seedRunner } from "./runner-rows";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const warning = (runnerVersion: string) => ({
  repository: "acme/paws",
  policyDigest: "d1",
  runnerVersion,
  keys: [{ key: "checks.proof", needs: "9.9.9" }],
  checkedAt: 100,
});

forEachDialect((connect) => {
  test("a policy runner warning reports once per change and clears once", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;

    expect(await db.run((q) => savePolicyRunnerWarningSteps(q, warning("1.0.0")))).toBe(true);
    expect(await db.run((q) => savePolicyRunnerWarningSteps(q, warning("1.0.0")))).toBe(false);
    expect(await db.run((q) => savePolicyRunnerWarningSteps(q, warning("1.0.1")))).toBe(true);
    expect(await db.run(listPolicyRunnerWarningsSteps)).toEqual([warning("1.0.1")]);

    expect(await db.run((q) => clearPolicyRunnerWarningSteps(q, "acme/paws"))).toBe(true);
    expect(await db.run((q) => clearPolicyRunnerWarningSteps(q, "acme/paws"))).toBe(false);
    expect(await db.run(listPolicyRunnerWarningsSteps)).toEqual([]);
  });

  test("the lowest online runner release decides which policy keys it lacks", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await withoutForeignKeys(db);
    const keys = ["checks", "proof"];
    expect(await db.run((q) => policyKeysLowestRunnerLacksSteps(q, keys, 10))).toBeNull();

    await seedRunner(db, "new", { lastSeenAt: 20 });
    await seedRunner(db, "old", { lastSeenAt: 20 });
    await seedRunner(db, "offline", { lastSeenAt: 5 });
    await seedRunner(db, "revoked", { lastSeenAt: 20, status: "revoked" });
    await seedRunner(db, "unreported", { lastSeenAt: 20 });
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerHostStatus).values([
        { runnerId: "new", runnerVersion: "0.9.10", reportedAt: 0 },
        { runnerId: "old", runnerVersion: "0.9.2", reportedAt: 0 },
        { runnerId: "offline", runnerVersion: "0.1.0", reportedAt: 0 },
        { runnerId: "revoked", runnerVersion: "0.1.0", reportedAt: 0 },
        { runnerId: "unreported", runnerVersion: null, reportedAt: 0 },
      ]),
    );
    expect(await db.run((q) => policyKeysLowestRunnerLacksSteps(q, keys, 10))).toEqual({
      runnerVersion: "0.9.2",
      keys: policyKeysAbove(keys, "0.9.2"),
    });
  });
});
