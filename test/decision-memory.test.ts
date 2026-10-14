import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDecisionMemory } from "./local/decision-memory";

test("decision memory requires accessible confirmed human answers and never resumes on a search match", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-decisions-"));
  try {
    expect(await probeDecisionMemory(root)).toHaveLength(5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
