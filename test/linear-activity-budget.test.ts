import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeLinearActivityBudget } from "./local/linear-activity-budget";

test("Chatty runs retain bounded progress and durable provider backoff without losing critical replies", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-activity-budget-"));
  const observations: boolean[] = [];
  try {
    await probeLinearActivityBudget(root, (_name, passed) => observations.push(passed), 300);
    expect(observations).toHaveLength(7);
    expect(observations.every(Boolean)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
