import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeRunnerPolicyBrowser } from "./local/runner-policy-browser";

test("Runner policy and usage require owner consent and current workspace authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-policy-"));
  try {
    const observations: boolean[] = [];
    await probeRunnerPolicyBrowser(root, (_name, passed) => observations.push(passed));
    expect(observations).toHaveLength(5);
    expect(observations.every(Boolean)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
