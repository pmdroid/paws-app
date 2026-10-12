import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerHttp } from "./local/runner-http";

test("runner HTTPS routes enforce enrollment, current roles and actual mTLS renewal", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-http-"));
  const observations: string[] = [];
  try {
    await probeRunnerHttp(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
