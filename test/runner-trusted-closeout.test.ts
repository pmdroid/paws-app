import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerTrustedCloseout } from "./local/runner-trusted-closeout";

test("trusted Closeout dispatch uses production mTLS and canonical check authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-trusted-closeout-"));
  const observations: { name: string; passed: boolean; observed: unknown }[] = [];
  await probeRunnerTrustedCloseout(root, (name, passed, observed) =>
    observations.push({ name, passed, observed }),
  );
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(`Evidence ${root}`);
  expect(observations.map((entry) => entry.passed)).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
}, 30_000);
