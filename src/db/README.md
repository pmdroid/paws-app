# Database

Paws keeps its state in one SQLite file opened by `openDatabase()` in `src/db/open.ts`. The schema is the Drizzle schema in `src/db/schema/`, and drizzle-kit migrations in [drizzle/](drizzle/) create and change it. `migrate(db)` applies the ones a database has not recorded in `__drizzle_migrations`, starting with `0000_baseline` on a new database.

## Drizzle

`orm(db)` returns a Drizzle handle (`drizzle-orm/bun-sqlite`) for a `bun:sqlite` database, one per database. It shares the connection, so a Drizzle query inside `immediate()` or `db.transaction()` sees that transaction's uncommitted rows.

The typed schema lives in `src/db/schema/`, one file per area, exported through `src/db/schema/index.ts`. What Drizzle cannot express is in `src/db/schema/raw.ts`: `STRICT` and `WITHOUT ROWID` tables, `COLLATE` columns, and the exact SQL of virtual tables and triggers.

## Migrations

Migrations are drizzle-kit migrations, append-only and generated from the schema (`drizzle.config.ts`). To change the schema, edit `src/db/schema/`, then generate a migration named for what it does:

```sh
bun x drizzle-kit generate --name pull_comment_author
```

drizzle-kit writes `src/db/drizzle/<NNNN>_<name>.sql`, its snapshot in `meta/` and an entry in `meta/_journal.json`. Commit all three.

Anything drizzle-kit can't express is a custom migration with hand-written SQL: a `STRICT` table, a trigger, a virtual table, a data backfill. Generate an empty one and write the SQL into it, separating statements with `--> statement-breakpoint`:

```sh
bun x drizzle-kit generate --custom --name pull_comment_backfill
```

Update `raw.ts` with what the custom SQL adds that the schema cannot say (`STRICT`, a trigger), so the drift test passes.

A shipped migration, its snapshot and its journal entry are never edited, renamed or deleted; the `migrations-append-only` Closeout rule refuses that. drizzle-kit applies a migration only when its journal `when` is later than the last one a database recorded, so a branch whose migration was generated before another one merged regenerates it on top of `main`.

`0000_baseline` is the exact `sqlite_master` SQL of the schema the legacy migrations built, so `STRICT`, `CHECK`s, indexes and triggers are what they were. Its snapshot is the Drizzle schema.

### The legacy migrations

The hand-written migrations (`src/db/migrations.ts` and the files in `src/db/migrations/`, run by `legacyMigrate()`) no longer build Paws's database; only older tests use them, and they take no new files. A database they built is set aside at startup by `setAsideLegacyDatabase()`, and Paws starts on a fresh one ([database reset](../../docs/database-reset.md)).

## Drift test

```sh
bun test test/db-schema-drift.test.ts
```

It builds a database from the drizzle-kit migrations and compares it with the Drizzle schema plus `raw.ts`: tables, columns, types, nullability, defaults, collations, primary and foreign keys, unique constraints, indexes, `CHECK`s, `STRICT`, `WITHOUT ROWID`, `AUTOINCREMENT`, virtual tables and triggers. Each difference names the table and column or constraint. A custom migration whose SQL the schema does not describe fails it. `test/db-drizzle-migrations.test.ts` fails when the schema has a change that no generated migration carries.
