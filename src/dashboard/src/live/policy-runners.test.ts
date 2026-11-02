import { describe, expect, test } from "bun:test";
import {
  clearPolicyRunnerWarning,
  migrate,
  openDatabase,
  savePolicyRunnerWarning,
} from "../../../db";
import { createLiveStatusProvider } from "./provider";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("live status: a runner too old for a Closeout policy key", () => {
  test("the snapshot carries the recorded warning until it clears", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    expect(createLiveStatusProvider(db).snapshot().policyRunnerWarnings).toBeUndefined();
    savePolicyRunnerWarning(db, {
      repository: "pmdroid/paws-app",
      policyDigest: DIGEST,
      runnerVersion: "0.1.48",
      keys: [{ key: "items[].ci", needs: "0.1.49" }],
      checkedAt: Date.parse("2026-10-28T06:43:00.000Z"),
    });
    expect(createLiveStatusProvider(db).snapshot().policyRunnerWarnings).toEqual([
      {
        repository: "pmdroid/paws-app",
        policyDigest: DIGEST,
        runnerVersion: "0.1.48",
        keys: [{ key: "items[].ci", needs: "0.1.49" }],
        checkedAt: "2026-10-28T06:43:00.000Z",
      },
    ]);
    clearPolicyRunnerWarning(db, "pmdroid/paws-app");
    expect(createLiveStatusProvider(db).snapshot().policyRunnerWarnings).toBeUndefined();
  });
});
