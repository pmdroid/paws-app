import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeStandaloneAttribution } from "./local/standalone-attribution";

test("standalone Linear code passes App attribution, recovery, signed runner dispatch and actual ACP commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-standalone-attribution-"));
  try {
    expect(await probeStandaloneAttribution(root)).toHaveLength(4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
