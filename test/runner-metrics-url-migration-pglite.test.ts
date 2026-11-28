import { expect, test } from "bun:test";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { openPawsStore, PG_MIGRATIONS_FOLDER, pgSchema, postgresDb, type Db } from "../src/db";
import { tempHome } from "./helpers";
import { sqlRows, sqlRun } from "./pglite";
import journal from "../src/db/drizzle-pg/meta/_journal.json";

async function migratedBefore(dir: string, tag: string) {
  const folder = join(tempHome(), "drizzle-pg");
  cpSync(PG_MIGRATIONS_FOLDER, folder, { recursive: true });
  const entries = journal.entries.slice(
    0,
    journal.entries.findIndex((entry) => entry.tag === tag),
  );
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  const client = new PGlite(dir, { extensions: { citext } });
  const pg = drizzle({ client, schema: pgSchema });
  await migrate(pg, { migrationsFolder: folder });
  return { store: postgresDb(pg), close: () => client.close() };
}

const metricsColumns = (store: Db) =>
  sqlRows<{ column_name: string }>(
    store,
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'runner' AND column_name LIKE 'metrics_%' ORDER BY column_name",
  );

test("migrating drops the runner metrics URL columns and only the Prometheus discovery token secret", async () => {
  const dir = join(tempHome(), "pglite");
  const old = await migratedBefore(dir, "0056_drop_runner_metrics_url");
  expect(await metricsColumns(old.store)).toEqual([
    { column_name: "metrics_reported_at" },
    { column_name: "metrics_url" },
  ]);
  for (const name of ["prometheus-sd-token", "telemetry-otlp-header", "prometheus-sd-token.bak"])
    await sqlRun(
      old.store,
      `INSERT INTO secret (name, ciphertext, updated_at) VALUES ('${name}', 'sealed-${name}', 100)`,
    );
  await old.close();

  const migrated = await openPawsStore({ url: null, pgliteDir: dir });
  try {
    expect(await metricsColumns(migrated.store)).toEqual([]);
    expect(
      await sqlRows(migrated.store, "SELECT name, ciphertext FROM secret ORDER BY name"),
    ).toEqual([
      { name: "prometheus-sd-token.bak", ciphertext: "sealed-prometheus-sd-token.bak" },
      { name: "telemetry-otlp-header", ciphertext: "sealed-telemetry-otlp-header" },
    ]);
  } finally {
    await migrated.close();
  }
});
