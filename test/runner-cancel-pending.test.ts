import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, runnerCancelPending } from "../src/db";

test("an expired cancel holds a runner back until it reports its live runs without that run", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-cancel-pending-"));
  const db = openDatabase(join(root, "paws.sqlite"));
  try {
    migrate(db);
    const now = Date.now();
    db.run("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('box','ws','me','box','active',?,?)",
      [now, now],
    );
    const cancel = (id: string, expiresAt: number, acknowledgedAt: number | null = null) =>
      db.run(
        "INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at,acknowledged_at) VALUES(?,?,'run',1,'cancel','{}',?,?)",
        [id, "box", expiresAt, acknowledgedAt],
      );
    expect(runnerCancelPending(db, "box", now)).toBe(false);
    cancel("live", now + 60_000);
    expect(runnerCancelPending(db, "box", now)).toBe(true);
    db.run("DELETE FROM runner_command");
    cancel("expired", now - 60_000);
    expect(runnerCancelPending(db, "box", now)).toBe(true);
    db.run("UPDATE runner SET live_reported_at=? WHERE id='box'", [now]);
    expect(runnerCancelPending(db, "box", now)).toBe(false);

    const work = (generation: number, endedAt: number | null) =>
      db.run(
        "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,confirmed_at,ended_at) VALUES('run','box','ws',?,0,?,?,?,?)",
        [generation, `work-${generation}`, now, now - 1_000, endedAt],
      );
    work(2, now - 500);
    expect(runnerCancelPending(db, "box", now)).toBe(false);
    db.run("DELETE FROM runner_work");
    work(1, null);
    expect(runnerCancelPending(db, "box", now)).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
