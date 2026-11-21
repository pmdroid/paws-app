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

const KINDS = ["linear_project", "slack_channel", "user_private"] as const;
const SCOPED_TABLES = [
  "context_scope",
  "context_source",
  "context_record",
  "context_audit",
  "context_summary",
  "context_session",
] as const;

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

async function seed(store: Db, kind: string) {
  const ns = `'ws-1', '${kind}', '${kind}-1'`;
  await sqlRun(
    store,
    `INSERT INTO context_scope (workspace_id, scope_kind, scope_id, status, generation, changed_at, dreamed_at) VALUES (${ns}, 'connected', 3, 100, 90)`,
  );
  await sqlRun(
    store,
    `INSERT INTO context_source (workspace_id, scope_kind, scope_id, source_kind, source_id, status, restriction, changed_at) VALUES (${ns}, 'src', 's-1', 'active', '{"teamIds":["team-a"]}', 100)`,
  );
  await sqlRun(
    store,
    `INSERT INTO context_record (id, workspace_id, scope_kind, scope_id, source_kind, source_id, source_revision, source_revision_at, observed_at, record_key, layer, classification, importance, body, body_bytes, content_hash, audience, audience_lineage, restriction, version, status, expires_at, created_at) VALUES ('record-${kind}', ${ns}, 'src', 's-1', 'rev-1', 100, 100, 'key-1', 'observation', 'reported_fact', 1, 'body ${kind}', 10, 'hash', 'aud', 'aud@1', '{"teamIds":["team-a"]}', 1, 'current', 1000, 100)`,
  );
  await sqlRun(
    store,
    `INSERT INTO context_audit (id, workspace_id, scope_kind, scope_id, action, at) VALUES ('audit-${kind}', ${ns}, 'ingest', 100)`,
  );
  await sqlRun(
    store,
    `INSERT INTO context_summary (id, workspace_id, scope_kind, scope_id, partition, audience, audience_lineage, restriction, version, status, body, body_bytes, covered, attempts, changed_at) VALUES ('summary-${kind}', ${ns}, 'p', 'aud', 'aud@1', '{}', 1, 'current', 'summary ${kind}', 10, 1, 0, 100)`,
  );
  await sqlRun(
    store,
    `INSERT INTO context_summary_source (summary_id, record_id, record_version) VALUES ('summary-${kind}', 'record-${kind}', 1)`,
  );
  await sqlRun(
    store,
    `INSERT INTO context_session (consumer_key, workspace_id, scope_kind, scope_id, requester_id, audience, version, generation, status, pack_hash, manifest, created_at, updated_at) VALUES ('session-${kind}', ${ns}, 'alice', 'aud', 1, 3, 'injected', 'hash', '{}', 100, 100)`,
  );
  await sqlRun(
    store,
    `INSERT INTO context_forgotten_entry (workspace_id, scope_kind, scope_id, source_kind, source_id, record_key, forgotten_by, forgotten_at) VALUES (${ns}, 'src', 's-1', 'key-1', 'alice', 100)`,
  );
}

const snapshot = async (store: Db, table: string, kind: string) =>
  sqlRows(store, `SELECT * FROM ${table} WHERE scope_kind = ? ORDER BY 1`, [kind]);

const summarySources = (store: Db) =>
  sqlRows<{ summary_id: string }>(
    store,
    "SELECT summary_id FROM context_summary_source ORDER BY summary_id",
  );

test("migrating deletes the Linear-project and Slack channel context rows and keeps the private rows", async () => {
  const dir = join(tempHome(), "pglite");
  const old = await migratedBefore(dir, "0019_delete_linear_project_context");
  for (const kind of KINDS) await seed(old.store, kind);
  const before = new Map<string, Record<string, unknown>[]>();
  for (const table of SCOPED_TABLES) {
    const rows = await snapshot(old.store, table, "user_private");
    expect(rows).toHaveLength(1);
    before.set(
      table,
      rows.map(({ dreamed_at: _, ...row }) => row),
    );
  }
  await old.close();

  const migrated = await openPawsStore({ url: null, pgliteDir: dir });
  try {
    for (const table of SCOPED_TABLES) {
      expect(await snapshot(migrated.store, table, "linear_project")).toEqual([]);
      expect(await snapshot(migrated.store, table, "slack_channel")).toEqual([]);
      expect(await snapshot(migrated.store, table, "user_private")).toEqual(before.get(table)!);
    }
    expect(await summarySources(migrated.store)).toEqual([{ summary_id: "summary-user_private" }]);
    expect(
      await sqlRows(
        migrated.store,
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'context_forgotten_entry'",
      ),
    ).toEqual([]);
    expect(
      await sqlRows(
        migrated.store,
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'context_scope' AND column_name = 'dreamed_at'",
      ),
    ).toEqual([]);
    const refused = await sqlRun(
      migrated.store,
      "INSERT INTO context_scope (workspace_id, scope_kind, scope_id, status, generation, changed_at) VALUES ('ws-2', 'linear_project', 'p-2', 'connected', 1, 100)",
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(String(refused?.cause ?? refused)).toContain("context_scope_kind");
  } finally {
    await migrated.close();
  }
});
