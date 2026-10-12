import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerEvidenceRelays } from "./local/runner-evidence-relays";

test("daemon evidence relays use real mTLS and immutable fenced storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-relays-"));
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  await probeRunnerEvidenceRelays(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(`Evidence ${root}`);
  expect(observations.map((entry) => entry.passed)).toEqual([true, true, true, true]);
}, 30_000);
