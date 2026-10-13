import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORK_ITEM_STATES, TERMINAL_WORK_ITEM_STATES } from "../src/core";
import { probeExecutionStopStates } from "./local/execution-stop-states";

test("Production HTTP Stop joins selected remote work from each nonterminal canonical state", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-stop-states-"));
  try {
    const observations = await probeExecutionStopStates(root);
    assert.equal(observations.length, WORK_ITEM_STATES.length - TERMINAL_WORK_ITEM_STATES.length);
    assert(observations.every((entry) => entry.passed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
