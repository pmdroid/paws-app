import { expect, test } from "bun:test";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { openPawsStore, PG_MIGRATIONS_FOLDER, pgSchema, postgresDb } from "../src/db";
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

test("a member VM row from before the provider columns lives on exe.dev under its VM name, and one still in create has no VM id yet", async () => {
  const dir = join(tempHome(), "pglite");
  const old = await migratedBefore(dir, "0029_member_vm_provider");
  await sqlRun(
    old.store,
    "INSERT INTO workspace (id, linear_organization_id, name, created_at) VALUES ('ws-1', 'org-1', 'Org', 100)",
  );
  await sqlRun(
    old.store,
    "INSERT INTO workspace_user (id, linear_user_id, name, email) VALUES ('user-1', 'lin-1', 'Ada', 'ada@example.invalid')",
  );
  await sqlRun(
    old.store,
    "INSERT INTO workspace_member (workspace_id, user_id, role, source, active, checked_at) VALUES ('ws-1', 'user-1', 'member', 'linear', 1, 100)",
  );
  for (const [id, name, step] of [
    ["vm-1", "ada-paws", "ready"],
    ["vm-2", "ada-paws-2", "create"],
  ])
    await sqlRun(
      old.store,
      `INSERT INTO member_vm (id, workspace_id, user_id, vm_name, step, step_started_at, created_at, updated_at) VALUES ('${id}', 'ws-1', 'user-1', '${name}', '${step}', 100, 100, 100)`,
    );
  await old.close();

  const migrated = await openPawsStore({ url: null, pgliteDir: dir });
  try {
    expect(
      await sqlRows(
        migrated.store,
        "SELECT id, provider, provider_vm_id FROM member_vm ORDER BY id",
      ),
    ).toEqual([
      { id: "vm-1", provider: "exe-dev", provider_vm_id: "ada-paws" },
      { id: "vm-2", provider: "exe-dev", provider_vm_id: null },
    ]);
    const refused = await sqlRun(
      migrated.store,
      "UPDATE member_vm SET provider = 'elsewhere' WHERE id = 'vm-1'",
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(String(refused?.cause ?? refused)).toContain("member_vm_check_7");
  } finally {
    await migrated.close();
  }
});
