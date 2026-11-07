# Database

Paws keeps its state in one SQLite file opened by `openDatabase()` in `src/db/open.ts`. The schema is defined by the migrations: the frozen list in `src/db/migrations.ts`, then one file per migration in [migrations/](migrations/README.md).

## Drizzle

`orm(db)` returns a Drizzle handle (`drizzle-orm/bun-sqlite`) for a `bun:sqlite` database, one per database. It shares the connection, so a Drizzle query inside `immediate()` or `db.transaction()` sees that transaction's uncommitted rows.

The typed schema lives in `src/db/schema/`, one file per area, exported through `src/db/schema/index.ts`. What Drizzle cannot express is in `src/db/schema/raw.ts`: `STRICT` and `WITHOUT ROWID` tables, `COLLATE` columns, and the exact SQL of virtual tables and triggers.

### Regenerate the schema

After adding a migration, regenerate the schema from a database built by every migration:

```sh
bun scripts/db-schema.ts
```

The script migrates a temporary database, runs `drizzle-kit pull` on it, and rewrites `src/db/schema/` from the result. `pull` reads `CHECK` constraints, partial and expression indexes, composite primary key order and some defaults wrongly, so the script replaces those with what `sqlite_master` and the table pragmas say. Do not edit the generated files by hand; change the script.

### Drift test

```sh
bun test test/db-schema-drift.test.ts
```

It builds a database with today's migrations and compares it with the Drizzle schema plus `raw.ts`: tables, columns, types, nullability, defaults, collations, primary and foreign keys, unique constraints, indexes, `CHECK`s, `STRICT`, `WITHOUT ROWID`, `AUTOINCREMENT`, virtual tables and triggers. Each difference names the table and column or constraint. A migration without a regenerated schema fails it.
