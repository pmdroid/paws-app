import { describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTableName } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { PG_MIGRATIONS_FOLDER, pgSchema } from "../src/db";
import { tempHome } from "./helpers";
import { pgliteDb } from "./pglite";

const ROOT = new URL("..", import.meta.url).pathname;

function drizzleKit(home: string) {
  cpSync(PG_MIGRATIONS_FOLDER, join(home, "drizzle-pg"), { recursive: true });
  writeFileSync(
    join(home, "drizzle.pg.config.ts"),
    `export default ${JSON.stringify({ dialect: "postgresql", schema: join(ROOT, "src/db/schema-pg/index.ts"), out: "./drizzle-pg" })};\n`,
  );
  const run = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      join(ROOT, "node_modules/drizzle-kit/bin.cjs"),
      "generate",
      "--config=drizzle.pg.config.ts",
    ],
    { cwd: home, stdout: "pipe", stderr: "pipe" },
  );
  expect(run.exitCode).toBe(0);
  return readdirSync(join(home, "drizzle-pg"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function migrationsBefore(tag: string): string {
  const out = join(tempHome(), "migrations");
  cpSync(PG_MIGRATIONS_FOLDER, out, { recursive: true });
  const path = join(out, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as { entries: { tag: string }[] };
  const index = journal.entries.findIndex((entry) => entry.tag.endsWith(`_${tag}`));
  expect(index).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, index);
  writeFileSync(path, JSON.stringify(journal));
  return out;
}

describe("Postgres drizzle-kit migrations", () => {
  test("the migrations apply to a fresh PGlite database, once each, with every table", async () => {
    const db = await pgliteDb();
    try {
      await migrate(db, { migrationsFolder: PG_MIGRATIONS_FOLDER });
      const applied = await db.$client.query("SELECT hash FROM drizzle.__drizzle_migrations");
      const journal = JSON.parse(
        readFileSync(join(PG_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
      ) as { entries: unknown[] };
      expect(applied.rows).toHaveLength(journal.entries.length);
      const tables = await db.$client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      );
      const expected = Object.values(pgSchema).map((table) => getTableName(table));
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual(expected.sort());
    } finally {
      await db.$client.close();
    }
  });

  test("a NOCASE column is citext, so it compares case-insensitively", async () => {
    const db = await pgliteDb();
    try {
      const columns = await db.$client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.columns WHERE column_name = 'repository' AND udt_name = 'citext'",
      );
      expect(columns.rows.map((row) => row.table_name).sort()).toEqual([
        "improvement",
        "retro_collection_lock",
        "retro_coverage_gap",
        "retro_evidence",
        "retro_item",
        "retro_repository",
        "retro_watermark",
      ]);
      const equal = await db.$client.query<{ equal: boolean }>(
        "SELECT 'Org/Repo'::citext = 'org/repo' AS equal",
      );
      expect(equal.rows).toEqual([{ equal: true }]);
    } finally {
      await db.$client.close();
    }
  });

  test("journal starts with 0000_baseline", () => {
    const journal = JSON.parse(
      readFileSync(join(PG_MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8"),
    ) as { dialect: string; entries: { tag: string }[] };
    expect(journal.dialect).toBe("postgresql");
    expect(journal.entries[0]?.tag).toBe("0000_baseline");
  });

  test("the Postgres schema has no change without a migration", () => {
    expect(drizzleKit(tempHome())).toEqual(
      readdirSync(PG_MIGRATIONS_FOLDER)
        .filter((name) => name.endsWith(".sql"))
        .sort(),
    );
  });

  test("dropping job_activation keeps each job's activation id and issues later ones above every earlier one", async () => {
    const pg = await pgliteDb({ migrationsFolder: migrationsBefore("drop_dead_tables") });
    try {
      for (const id of [1, 2, 3])
        await pg.$client.query(
          `INSERT INTO job (id, queue, run_at, created_at) VALUES (${id}, 'work', 0, 0)`,
        );
      for (const [id, jobId] of [
        [1, 1],
        [2, 2],
        [3, 2],
        [4, 3],
        [5, 1],
      ])
        await pg.$client
          .query(`INSERT INTO job_activation (job_id) VALUES (${jobId}) RETURNING id`)
          .then((result) => expect(result.rows).toEqual([{ id }]));
      await pg.$client.exec(
        "UPDATE job SET activation_id = CASE id WHEN 1 THEN 5 WHEN 2 THEN 3 ELSE 4 END; DELETE FROM job WHERE id = 1",
      );
      await pg.$client.exec(
        "INSERT INTO paws_alive (id, at) VALUES (1, 10); INSERT INTO linear_input VALUES ('s', 't', 'a', 'u', 'image/png', 1, 'h'); INSERT INTO linear_item_caller_request VALUES ('i', 'outbox', 2)",
      );
      const before = await pg.$client.query(
        "SELECT id::int AS id, activation_id::int AS activation FROM job ORDER BY id",
      );
      expect(before.rows).toEqual([
        { id: 2, activation: 3 },
        { id: 3, activation: 4 },
      ]);

      await migrate(pg, { migrationsFolder: PG_MIGRATIONS_FOLDER });

      const after = await pg.$client.query(
        "SELECT id::int AS id, activation_id::int AS activation FROM job ORDER BY id",
      );
      expect(after.rows).toEqual(before.rows);
      const added = await pg.$client.query(
        "INSERT INTO job (queue, run_at, created_at) VALUES ('work', 0, 0) RETURNING activation_id::int AS activation",
      );
      expect(added.rows).toEqual([{ activation: 6 }]);
      for (const table of [
        "paws_alive",
        "run_review_rounds",
        "linear_item_caller_request",
        "linear_input",
        "job_activation",
      ]) {
        const gone = await pg.$client.query(`SELECT to_regclass('${table}') AS name`);
        expect(gone.rows).toEqual([{ name: null }]);
      }
    } finally {
      await pg.$client.close();
    }
  });

  test("dropping github_delivery.payload keeps each delivery's id, event and time", async () => {
    const pg = await pgliteDb({
      migrationsFolder: migrationsBefore("drop_github_delivery_payload"),
    });
    try {
      await pg.$client.exec(
        "INSERT INTO github_delivery VALUES ('d-1', 'check_run', '{}', 1000), ('d-2', 'pull_request', '{\"action\":\"opened\"}', 2000)",
      );
      const read =
        "SELECT delivery_id, event, received_at::int AS at FROM github_delivery ORDER BY delivery_id";
      const before = await pg.$client.query(read);
      expect(before.rows).toEqual([
        { delivery_id: "d-1", event: "check_run", at: 1000 },
        { delivery_id: "d-2", event: "pull_request", at: 2000 },
      ]);

      await migrate(pg, { migrationsFolder: PG_MIGRATIONS_FOLDER });

      expect((await pg.$client.query(read)).rows).toEqual(before.rows);
      const columns = await pg.$client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'github_delivery' AND column_name = 'payload'",
      );
      expect(columns.rows).toEqual([]);
    } finally {
      await pg.$client.close();
    }
  });
});
