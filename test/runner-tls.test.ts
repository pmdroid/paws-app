import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { probeRunnerTls } from "./local/runner-tls";

test("runner identity uses real TLS certificates, peer verification and immediate revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-tls-"));
  const observations: string[] = [];
  try {
    await probeRunnerTls(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
