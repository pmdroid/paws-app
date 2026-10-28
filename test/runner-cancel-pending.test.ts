import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, runnerCancelPending } from "../src/db";

test("only an unexpired, unacknowledged cancel holds a runner's new work back", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-cancel-pending-"));
  const db = openDatabase(join(root, "paws.sqlite"));
  try {
    migrate(db);
    const now = Date.now();
    db.run("PRAGMA foreign_keys=OFF");
    const cancel = (id: string, expiresAt: number, acknowledgedAt: number | null = null) =>
      db.run(
        "INSERT INTO runner_command(id,runner_id,kind,envelope,expires_at,acknowledged_at) VALUES(?,?,'cancel','{}',?,?)",
        [id, "box", expiresAt, acknowledgedAt],
      );
    expect(runnerCancelPending(db, "box", now)).toBe(false);
    cancel("expired", now - 60_000);
    expect(runnerCancelPending(db, "box", now)).toBe(false);
    cancel("acknowledged", now + 60_000, now);
    expect(runnerCancelPending(db, "box", now)).toBe(false);
    cancel("live", now + 60_000);
    expect(runnerCancelPending(db, "box", now)).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
