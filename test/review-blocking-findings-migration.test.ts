import { expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_FOLDER, migrate, openDatabase, sqliteDb } from "../src/db";
import { insertWorkItem } from "./dialects";
import { tempHome } from "./helpers";

function beforeMigration(): string {
  const out = join(tempHome(), "migrations");
  cpSync(MIGRATIONS_FOLDER, out, { recursive: true });
  const path = join(out, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_review_blocking_findings"),
  );
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  writeFileSync(path, JSON.stringify(journal));
  return out;
}

test("rebuilding review_finding keeps which acme items reported each finding", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db, { migrationsFolder: beforeMigration() });
    await insertWorkItem(sqliteDb(db), "acme-1");
    db.run(`INSERT INTO review_finding
      (id, dedupe_key, repository, path, lines, severity, review, text, bug_class, why,
       first_item_id, first_head, first_seen_at, last_item_id, last_head, last_seen_at)
      VALUES (7, 'acme-key', 'acme/widgets', 'src/acme.ts', '3', 'P2', 'correctness', 'Acme drifts',
       'logic', 'pre-existing', 'acme-1', 'h1', 10, 'acme-1', 'h1', 10)`);
    db.run(`INSERT INTO review_finding_item (finding_id, item_id, head_sha, seen_at)
      VALUES (7, 'acme-1', 'h1', 10)`);

    migrate(db);

    expect(db.query("SELECT id, why FROM review_finding").all()).toEqual([
      { id: 7, why: "pre-existing" },
    ]);
    expect(
      db
        .query(
          "SELECT finding_id AS findingId, item_id AS itemId, head_sha AS head, seen_at AS seenAt FROM review_finding_item",
        )
        .all(),
    ).toEqual([{ findingId: 7, itemId: "acme-1", head: "h1", seenAt: 10 }]);
    expect(
      db.query("SELECT 1 FROM sqlite_master WHERE name = '__keep_review_finding_item'").get(),
    ).toBeNull();
    db.run("UPDATE review_finding SET why = 'meets failOn' WHERE id = 7");
  } finally {
    db.close();
  }
});
