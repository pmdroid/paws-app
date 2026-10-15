import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeRunnerPlacement } from "./local/runner-placement";

test("Runner placement uses actual ownership, explicit sharing, provider evidence and independent review", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-placement-"));
  try {
    const observations: boolean[] = [];
    await probeRunnerPlacement(root, (_name, passed) => observations.push(passed));
    expect(observations).toHaveLength(16);
    expect(observations.every(Boolean)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
