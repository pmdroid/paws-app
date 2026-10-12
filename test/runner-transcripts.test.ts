import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerTranscripts } from "./local/runner-transcripts";

test("remote transcripts preserve full output outside SQLite with immutable scoped object receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-transcripts-"));
  const observations: string[] = [];
  try {
    await probeRunnerTranscripts(root, (name, passed) => {
      expect(passed).toBe(true);
      observations.push(name);
    });
    expect(observations).toHaveLength(7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
