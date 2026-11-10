import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerJournal } from "./local/runner-journal";

test("runner execution recovery survives an actual writer SIGKILL without duplicate admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-journal-proof-"));
  try {
    const observations: boolean[] = [];
    await probeRunnerJournal(root, (_name, passed) => observations.push(passed));
    expect(observations).toEqual([true, true, true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
