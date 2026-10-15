import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerTranscriptStorage } from "./local/runner-transcript-config";

test("protected transcript configuration feeds explicit storage and startup without a runner answers health", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-transcript-config-test-"));
  const observations: string[] = [];
  try {
    await probeRunnerTranscriptStorage(root, (name, passed) => {
      expect(passed).toBe(true);
      observations.push(name);
    });
    expect(observations).toHaveLength(9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
