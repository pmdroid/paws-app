import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeRunnerTaskAuthority } from "./local/runner-task-authority";

test("signed response tasks preserve live Linear authority with optional read-only repositories", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-task-authority-"));
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  await probeRunnerTaskAuthority(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(`Evidence ${root}`);
  expect(observations.map((value) => value.passed)).toEqual([true, true, true, true, true, true]);
}, 30_000);
