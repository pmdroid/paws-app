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
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
