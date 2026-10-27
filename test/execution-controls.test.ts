import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLEANUP_BLOCKED_NOTICE,
  blockConversation,
  enqueueJob,
  enqueueOutbox,
  getConversation,
  getJob,
  getOutbox,
  getWorkItem,
} from "../src/db";
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

    // A dead job from an earlier state of the item is refused, so its work is not revived.
    const stale = dead("controlled-stale");
    db.run("UPDATE job SET payload = json_set(payload, '$.itemId', 'controlled') WHERE id = ?", [
      stale,
    ]);
    db.run("UPDATE job SET status = 'dead', item_version = -1 WHERE id = ?", [stale]);
    assert.equal((await retry(`job:${stale}`)).status, 409);
    assert.equal(getJob(db, stale)!.status, "dead");

    // Once the session is stopped, only its dead final Stop delivery can be retried.
    const session = getWorkItem(db, "controlled")!.sessionKey!;
    const stop = enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: session,
      delivery: "stop",
      idempotencyKey: "stop:controlled:retry-test",
      payload: { itemId: "controlled", kind: "response", body: "Stopped." },
    });
    const late = dead("controlled-late");
    db.run("UPDATE job SET payload = json_set(payload, '$.itemId', 'controlled') WHERE id = ?", [
      late,
    ]);
    db.run("UPDATE job SET status = 'dead', item_version = NULL WHERE id = ?", [late]);
    db.run("UPDATE outbox SET status = 'dead', error = 'Linear is down' WHERE id = ?", [stop]);
    db.run("UPDATE linear_session SET stopped_at = ? WHERE session_id = ?", [Date.now(), session]);
    assert.equal((await retry(`job:${late}`)).status, 403);
    assert.equal(getJob(db, late)!.status, "dead");
    assert.equal((await retry(`outbox:${stop}`, "observer")).status, 403);
    assert.equal((await retry(`outbox:${stop}`)).status, 200);
    assert.equal(getOutbox(db, stop)!.status, "pending");
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Clear stuck agent clears a blocked conversation for an owner, refuses a member and is audited", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-controls-stuck-"));
  const fixture = createExecutionControlsFixture(root);
  try {
    const { db, call } = fixture;
    blockConversation(db, "controlled", Date.now());
    const view = (await (await call(undefined, "owner")).json()) as {
      actions: string[];
      notice?: string;
    };
    assert(view.actions.includes("clear_stuck_agent"));
    assert.equal(view.notice, CLEANUP_BLOCKED_NOTICE);
    const member = (await (await call()).json()) as { actions: string[]; notice?: string };
    assert(!member.actions.includes("clear_stuck_agent"));
    assert.equal(member.notice, CLEANUP_BLOCKED_NOTICE);

    assert.equal((await call("clear_stuck_agent")).status, 403);
    assert.equal(getConversation(db, "controlled").blocked, true);
    assert.equal((await call("clear_stuck_agent", "owner")).status, 200);
    assert.equal(getConversation(db, "controlled").blocked, false);
    const audit = db
      .query<{ userId: string; action: string; subject: string }, []>(
        "SELECT user_id AS userId,action,subject FROM workspace_access_audit WHERE action LIKE '%clear_stuck_agent%' OR subject LIKE '%clear_stuck_agent%' ORDER BY id",
      )
      .all();
    assert.deepEqual(audit, [
      {
        userId: "member",
        action: "access.denied",
        subject: "execution.clear_stuck_agent:controlled",
      },
      { userId: "owner", action: "execution.clear_stuck_agent", subject: "controlled" },
    ]);
    // Nothing is blocked any more, so the action is gone.
    assert.equal((await call("clear_stuck_agent", "owner")).status, 409);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
