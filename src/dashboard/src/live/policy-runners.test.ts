import { afterEach, describe, expect, test } from "bun:test";
import { clearPolicyRunnerWarning, savePolicyRunnerWarning } from "../../../db";
import { createLiveStatusProvider } from "./provider";
import { tempStore } from "../../../../test/pglite";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("live status: a runner too old for a Closeout policy key", () => {
  test("the merge queue carries the recorded warning until it clears", async () => {
    const { db, close } = await tempStore();
    open.push(close);
    expect((await createLiveStatusProvider(db).mergeQueue()).policyRunnerWarnings).toEqual([]);
    await savePolicyRunnerWarning(db, {
      repository: "pmdroid/paws-app",
      policyDigest: DIGEST,
      runnerVersion: "0.1.48",
      keys: [{ key: "items[].ci", needs: "0.1.49" }],
      checkedAt: Date.parse("2026-10-28T06:43:00.000Z"),
    });
    expect((await createLiveStatusProvider(db).mergeQueue()).policyRunnerWarnings).toEqual([
      {
        repository: "pmdroid/paws-app",
        policyDigest: DIGEST,
        runnerVersion: "0.1.48",
        keys: [{ key: "items[].ci", needs: "0.1.49" }],
        checkedAt: "2026-10-28T06:43:00.000Z",
      },
    ]);
    await clearPolicyRunnerWarning(db, "pmdroid/paws-app");
    expect((await createLiveStatusProvider(db).mergeQueue()).policyRunnerWarnings).toEqual([]);
  });
});
