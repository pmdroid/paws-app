import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeLinearActivityBudget } from "./local/linear-activity-budget";

async function observeCase(kind: "history" | "backoff") {
  const root = mkdtempSync(join(tmpdir(), "paws-activity-budget-"));
  const observations: boolean[] = [];
  try {
    await probeLinearActivityBudget(root, (_name, passed) => observations.push(passed), 300, [
      kind,
    ]);
    return observations;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Chatty runs retain all public history across restarts", async () => {
  const observations = await observeCase("history");
  expect(observations).toHaveLength(5);
  expect(observations.every(Boolean)).toBe(true);
}, 30_000);

test("Chatty runs keep durable provider backoff across restarts", async () => {
  const observations = await observeCase("backoff");
  expect(observations).toHaveLength(2);
  expect(observations.every(Boolean)).toBe(true);
}, 30_000);
