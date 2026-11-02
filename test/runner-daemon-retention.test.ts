import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { openRunnerDaemon } from "../src/runner-daemon";

const DAY = 24 * 60 * 60_000;

test("routine pruning drops only expired, acknowledged commands and their receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-daemon-retention-"));
  let now = 10 * DAY;
  const daemon = openRunnerDaemon({
    root,
    controlPlaneUrl: "https://paws.invalid",
    runnerApiUrl: "https://runner.paws.invalid",
    now: () => now,
  });
  const db = openDatabase(join(root, "commands.db"));
  try {
    const add = (id: string, expiresAt: number, acknowledged: number | null) => {
      db.run("INSERT INTO command_receipt VALUES (?,?)", [id, expiresAt]);
      if (acknowledged !== null)
        db.run("INSERT INTO pending_command (id,payload,acknowledged) VALUES (?,'{}',?)", [
          id,
          acknowledged,
        ]);
    };
    add("retired", now - 2 * DAY, 2);
    add("rejected", now - 2 * DAY, null);
    add("ack-retrying", now - 2 * DAY, 1);
    add("unacknowledged", now - 2 * DAY, 0);
    add("recently-expired", now - 60_000, 2);
    add("live", now + 5 * DAY, 2);
    add("unexpired-receipt", now + 5 * DAY, null);

    expect(daemon.pruneRetired()).toBe(3);
    const ids = (table: string) =>
      db
        .query<{ id: string }, []>(`SELECT id FROM ${table} ORDER BY id`)
        .all()
        .map(({ id }) => id);
    expect(ids("pending_command")).toEqual([
      "ack-retrying",
      "live",
      "recently-expired",
      "unacknowledged",
    ]);
    expect(ids("command_receipt")).toEqual([
      "ack-retrying",
      "live",
      "recently-expired",
      "unacknowledged",
      "unexpired-receipt",
    ]);

    db.run("UPDATE pending_command SET acknowledged=2 WHERE id='ack-retrying'");
    expect(daemon.pruneRetired()).toBe(0);
    now += 10 * 60_000;
    expect(daemon.pruneRetired()).toBe(2);
    expect(ids("pending_command")).not.toContain("ack-retrying");

    now += 2 * DAY;
    expect(daemon.pruneRetired()).toBe(2);
    expect(ids("pending_command")).toEqual(["live", "unacknowledged"]);
    expect(ids("command_receipt")).toEqual(["live", "unacknowledged", "unexpired-receipt"]);
  } finally {
    db.close();
    daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});
