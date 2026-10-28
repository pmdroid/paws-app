import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import { RUN_GRANT_GRACE_MS, runGrantValid } from "../src/runner-work";
import { workspaceTokenHash } from "../src/workspace";

test("a run grant stays valid for a grace period after it expires, then is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-grant-grace-"));
  const db = openDatabase(join(root, "paws.sqlite"));
  try {
    migrate(db);
    db.run("PRAGMA foreign_keys=OFF");
    const expiresAt = Date.now();
    db.run("INSERT INTO runner_work_grant VALUES(?,?,?,?)", [
      workspaceTokenHash("grant-token"),
      "run",
      3,
      expiresAt,
    ]);
    const grant = { token: "grant-token", runId: "run", generation: 3 };

    expect(runGrantValid(db, grant, expiresAt - 1)).toBe(true);
    expect(runGrantValid(db, grant, expiresAt + 30_000)).toBe(true);
    expect(runGrantValid(db, grant, expiresAt + RUN_GRANT_GRACE_MS)).toBe(false);
    expect(runGrantValid(db, { ...grant, generation: 4 }, expiresAt - 1)).toBe(false);
    expect(runGrantValid(db, { ...grant, token: "other" }, expiresAt - 1)).toBe(false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
