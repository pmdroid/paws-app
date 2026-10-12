import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerChecks } from "./local/runner-checks";

test("trusted check commands and results bind enrolled signatures, grants and generations", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-checks-"));
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  await probeRunnerChecks(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(`Evidence ${root}`);
  expect(observations.map((entry) => entry.passed)).toEqual([true, true, true]);
}, 30_000);
