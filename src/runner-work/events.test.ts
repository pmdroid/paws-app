import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../db";
import { encryptRunnerEvents } from "./events";

async function sealTraced(autoVacuum: "NONE" | "INCREMENTAL") {
  const dir = mkdtempSync(join(tmpdir(), "paws-runner-event-seal-"));
  try {
    const path = join(dir, "paws.db");
    // auto_vacuum is fixed once the file has tables, so the test writes it into an empty file.
    const fresh = new Database(path);
    fresh.run(`PRAGMA auto_vacuum=${autoVacuum}`);
    fresh.run("VACUUM");
    fresh.close();
    const db = openDatabase(path);
    migrate(db);
    db.run("PRAGMA foreign_keys=OFF");
    for (let sequence = 1; sequence <= 600; sequence++)
      db.run(
        "INSERT INTO runner_event(run_id,generation,sequence,payload,received_at) VALUES(?,?,?,?,?)",
        ["run", 1, sequence, JSON.stringify({ type: "progress", text: `Step ${sequence}` }), 0],
      );
    const mode = db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()!.auto_vacuum;
    const statements: string[] = [];
    for (const method of ["run", "exec", "query", "prepare"] as const) {
      const original = db[method].bind(db) as (sql: string, ...rest: unknown[]) => unknown;
      Object.assign(db, {
        [method]: (sql: string, ...rest: unknown[]) => {
          statements.push(sql.trim());
          return original(sql, ...rest);
        },
      });
    }
    const result = await encryptRunnerEvents({ db, key: randomBytes(32) });
    const unsealed = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM runner_event WHERE key_id IS NULL",
      )
      .get()!.count;
    db.close();
    return { mode, result, unsealed, statements };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [autoVacuum, mode, vacuums] of [
  ["NONE", 0, 0],
  ["INCREMENTAL", 2, 1],
] as const)
  test(`sealing checkpoints the WAL without VACUUM, auto_vacuum=${mode}`, async () => {
    const { result, unsealed, statements, ...traced } = await sealTraced(autoVacuum);
    expect(traced.mode).toBe(mode);
    expect(result).toEqual({ sealed: 600 });
    expect(unsealed).toBe(0);
    expect(statements).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(statements.filter((sql) => /^VACUUM\b/i.test(sql))).toEqual([]);
    expect(statements.filter((sql) => /incremental_vacuum/i.test(sql))).toHaveLength(vacuums);
  });
