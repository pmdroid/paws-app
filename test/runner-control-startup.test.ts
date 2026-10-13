import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerControlStartup } from "./local/runner-control-startup";

test("normal startup preserves local mode and sends remote agent probes through mTLS", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-startup-"));
  const names: string[] = [];
  try {
    await probeRunnerControlStartup(root, (name, passed) => {
      assert(passed, name);
      names.push(name);
    });
    assert.equal(names.length, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
