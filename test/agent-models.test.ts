import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAgentModels } from "./local/agent-models";

test("signed background model discovery persists isolated ACP choices and per-model effort", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-agent-models-"));
  const observations: string[] = [];
  try {
    await probeAgentModels(root, (name, passed) => {
      assert(passed, name);
      observations.push(name);
    });
    assert.equal(observations.length, 11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
