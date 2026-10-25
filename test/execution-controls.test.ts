import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enqueueJob, getJob } from "../src/db";
import { createExecutionControlsFixture, probeExecutionControls } from "./local/execution-controls";

test("Workspace execution controls reach canonical Stop, Pause and Resume with current authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-"));
  try {
    const observations = await probeExecutionControls(root);
    assert.equal(observations.length, 10);
    assert(observations.every((entry) => entry.passed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Retry puts a dead job of an authorized item back to pending and refuses everything else", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-retry-"));
  const fixture = createExecutionControlsFixture(root);
  try {
    const { db, origin } = fixture;
    const retry = (target: unknown, identity = "member") =>
      fetch(`${origin}/api/execution-controls`, {
        method: "POST",
        headers: fixture.headers(identity),
        body: JSON.stringify({ action: "retry", target }),
      });
    const dead = (itemId: string) =>
      enqueueJob(db, {
        queue: "test.unhandled",
        payload: { itemId },
        jobKey: `dead:${itemId}`,
        runAt: Date.now() + 3_600_000,
      });
    const mine = dead("controlled");
    const foreign = dead("foreign");
    db.run("UPDATE job SET status = 'dead', last_error = 'runner lost' WHERE id IN (?, ?)", [
      mine,
      foreign,
    ]);

    assert.equal((await retry("job:x")).status, 400);
    assert.equal((await retry(`job:${mine}`, "observer")).status, 403);
    assert.equal((await retry(`job:${foreign}`, "owner")).status, 403);
    assert.equal(getJob(db, foreign)!.status, "dead");
    assert.equal((await retry(`job:${mine}`)).status, 200);
    assert.equal(getJob(db, mine)!.status, "pending");
    assert.equal(getJob(db, mine)!.attempts, 0);
    assert.equal((await retry(`job:${mine}`)).status, 403);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
