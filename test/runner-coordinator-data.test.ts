import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerCoordinatorData } from "./local/runner-coordinator-data";

test("normal coordinator mounts authenticated repository and evidence data routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-coordinator-data-"));
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  await probeRunnerCoordinatorData(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(`Evidence ${root}`);
  expect(observations.map((entry) => entry.passed)).toEqual([true, true, true, true]);
}, 30_000);
