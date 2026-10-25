import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/db";

const sha = (seed: string) => `sha512-${seed.repeat(86)}==`;
const pin = JSON.stringify([{ name: "@openai/codex", version: "0.9.0", integrity: sha("N") }]);

/** A database just before 133 with three stored agent targets. Foreign keys stay off, so no runner row is needed. */
function before133(): Database {
  const db = new Database(":memory:");
  migrate(db, { until: "132_runner_agent" });
  // Columns as 132 created them: the fourth from the end marks a switch back to an installed version.
  const insert = db.prepare("INSERT INTO runner_agent_target VALUES(?,?,?,?,?,?,?,?,?,?)");
  insert.run("r", "codex", "update", "0.9.0", sha("A"), "0.9.0", pin, 0, "u", 1);
  insert.run("r", "claude", "switch-back", "1.8.0", null, null, "[]", 1, "u", 2);
  insert.run("r", "grok", "no-packages", "1.0.0", sha("B"), "1.0.0", "[]", 0, "u", 3);
  return db;
}

test("133 keeps updates with their integrity and checked packages, and drops every other target", () => {
  const db = before133();
  try {
    migrate(db);
    expect(db.query("SELECT runner_id,agent,id,integrity FROM runner_agent_target").all()).toEqual([
      { runner_id: "r", agent: "codex", id: "update", integrity: sha("A") },
    ]);
    const columns = db
      .query<{ name: string; notnull: number }, []>("PRAGMA table_info(runner_agent_target)")
      .all();
    expect(columns.map((column) => column.name)).toEqual([
      "runner_id",
      "agent",
      "id",
      "version",
      "integrity",
      "native_version",
      "packages",
      "requested_by",
      "requested_at",
    ]);
    expect(columns.find((column) => column.name === "integrity")!.notnull).toBe(1);
    const insert = (integrity: string | null, packages: string) =>
      db.run(
        `INSERT INTO runner_agent_target(runner_id,agent,id,version,integrity,native_version,packages,requested_by,requested_at)
         VALUES('r','grok','x','1.0.0',?,NULL,?,'u',4)`,
        [integrity, packages],
      );
    expect(() => insert(null, pin)).toThrow();
    expect(() => insert(sha("C"), "[]")).toThrow();
  } finally {
    db.close();
  }
});
