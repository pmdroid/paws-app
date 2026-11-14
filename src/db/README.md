# Database

Paws keeps its state in Postgres: PGlite in `~/.paws/pglite`, or the server at `[database] url` ([Database](../../docs/postgres.md)). The schema is the Drizzle pg-core schema in `src/db/schema-pg/`, one file per area, and drizzle-kit migrations in [drizzle-pg/](drizzle-pg/) create and change it.

The runner keeps its own SQLite files (the runner journal and the daemon's store). `openDatabase()` in `src/db/open.ts` opens one, `orm(db)` returns its Drizzle handle (`drizzle-orm/bun-sqlite`), and `sqliteDb(database)` drives `run()` and `transaction()` bodies on it. Those stores define their own tables next to their module.

## Migrations

Migrations are drizzle-kit migrations, append-only and generated from the schema (`drizzle.config.ts`). To change the schema, edit `src/db/schema-pg/`, then generate a migration named for what it does:

```sh
bun x drizzle-kit generate --name pull_comment_author
```

drizzle-kit writes `src/db/drizzle-pg/<NNNN>_<name>.sql`, its snapshot in `meta/` and an entry in `meta/_journal.json`. Commit all three. Anything drizzle-kit can't express (a trigger, a data backfill) is a custom migration with hand-written SQL, from `bun x drizzle-kit generate --custom --name <name>`, with statements separated by `--> statement-breakpoint`.

A shipped migration, its snapshot and its journal entry are never edited, renamed or deleted; the `migrations-append-only` Closeout rule refuses that. drizzle-kit applies a migration only when its journal `when` is later than the last one a database recorded, so a branch whose migration was generated before another one merged regenerates it on top of `main`.

`test/db-pg-migrations.test.ts` applies the migrations to PGlite and fails when the schema has a change no migration carries.

## Postgres

`openPostgres(url)` (`postgres.ts`) opens a Drizzle database on Bun's Postgres client, with the pool size from the URL's `max` parameter (default 10). `paws db check` uses it, or `connectPglite(dir)` without a URL, to apply the migrations and report. Postgres cuts identifiers at 63 bytes, so a long generated constraint name is stored shortened. `pgliteDb()` in `test/pglite.ts` returns a Drizzle database on in-memory PGlite with the migrations applied.

## The async `Db` interface

Paws runs on Postgres: embedded PGlite on a single host, a Postgres server through `[database] url` for a multi-process install. Each query is written once, against the Postgres schema, and a module takes a `Db` from `src/db/db.ts` instead of a `bun:sqlite` `Database`:

- `postgresDb(pg)` wraps a Drizzle Postgres database: `postgresDb(openPostgres(url))`, `postgresDb(await openPglite(dir))`, or in-memory PGlite in tests. `openPglite(dir)` opens a persistent PGlite directory and applies the Postgres migrations it has not applied yet.
- `openPawsStore({ url, pgliteDir })` (`postgres.ts`) opens the store startup will run on: the Postgres at `url`, migrated, or PGlite in `pgliteDir` (`~/.paws/pglite`, `pgliteDir` in `pawsPaths()`) when `url` is null. PGlite takes `<pgliteDir>.lock` with the process id first and throws `PgliteInUseError` while a live process other than this one holds it; `connectPglite()` takes the same lock. `setAsideSqliteDatabase(path)` (`migrate.ts`) renames an existing SQLite `paws.db` and its `-wal` and `-shm` to `paws.db.pre-postgres-<UTC timestamp>`, writes one journal line naming it, and does nothing when there is no `paws.db`. Startup calls it, then `openPawsStore()`.

A converted function is a generator that `db.run()` drives:

```ts
export function clearQueueWait(db: Db, itemId: string): Promise<void> {
  return db.run(function* (q) {
    const { itemWait } = q.t;
    yield* q.exec(
      q.orm.delete(itemWait).where(and(eq(itemWait.itemId, itemId), eq(itemWait.kind, "queue"))),
    );
  });
}
```

- `q.orm` is the Postgres Drizzle database and `q.t` is `pgSchema`.
- `yield* q.all(query)` returns the rows, `yield* q.one(query)` the first row or `undefined`, and `yield* q.exec(query)` runs it and returns nothing.
- To count changed rows, add `.returning()` and take the length; don't read `changes` or `rowCount`.
- `db.transaction(function* (q) { … })` is a Postgres transaction. When the body throws, all of its writes roll back. `yield* q.transaction(function* (q) { … })` inside a body is a savepoint: it commits with the outer transaction.
- A function whose generator another generator calls inside a transaction exports it as `<name>Steps(q, …)`, and the caller runs `yield* fooSteps(q, …)`. Add one only when such a caller exists.

`src/db/queue-wait.ts` is the worked example.

### The store

Startup (`startPaws()` in `src/index.ts`) sets aside an old `paws.db`, opens the store with `openPawsStore()` and passes it to every holder of the database: `PawsProcess.store`, `startLoops()` (`JobLoop.store`, `OutboxDispatcher.store`), `attachOrchestrator()` (`Orchestrator.store`), `startServer()` (`store` in the route context, from `serverStore()`) and `createRemoteAgentRunner()` (its `store`). Code reaches the database through its holder's `store` (`await this.store.run((q) => fooSteps(q, …))`, `this.store.transaction(…)`).

### Converting a module

1. Change `database: Database` to `db: Db`, return `Promise<T>`, and move the body into `db.run(function* (q) { … })`, or `db.transaction()` when it writes more than one statement. Build each query on `q.orm` and `q.t` and `yield*` it through `q.all`, `q.one` or `q.exec`.
2. Every caller awaits the function, or yields its Steps form inside a transaction. A synchronous caller becomes async, or takes a Steps callback; there is no way to unwrap a database promise synchronously.
3. Run the module's tests.

A feature module is re-exported whole from `index.ts` with `export * from "./<module>";`, so a new `…Steps` export needs no `index.ts` change. Only infrastructure (`db.ts`, `orm.ts`, `open.ts`, the migrations, `postgres.ts`, `db-check.ts`, `ddl.ts`, `schema-pg`) keeps an explicit list. Two modules can't export the same name: `export *` makes that a type error, so rename one. A conversion then edits only its module and its tests, and conversions of different modules merge without conflicts.

### Tests

`forEachDialect()` in `test/dialects.ts` runs a suite on PGlite. Each test opens its own database and closes it:

```ts
forEachDialect((open) => {
  test("an item's wait starts once per version", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "waiting");
      expect(await queueWaitSince(db, "waiting", 1, 100)).toBe(100);
    } finally {
      await close();
    }
  });
});
```

With `PAWS_TEST_DATABASE_URL` set to a Postgres server, `tempStore()`, `serverPostgres()`, `pgliteServer()` and `forEachDialect()` (in `test/pglite.ts` and `test/dialects.ts`) run on that server instead of PGlite: each opens a fresh database copied from a migrated template and drops it on close. Without it they use in-memory PGlite, as locally. CI's `test (postgres N/3)` jobs run the `src/db` tests and every `test/` file that uses one of those helpers, or a fixture built on them, against a fresh `postgres:17` service container per job, apart from the files in `test/postgres-known-failures.txt`, which still fail on a server and say why. Remove a file from that list once it passes with `PAWS_TEST_DATABASE_URL` set. Those jobs retry a failing test twice, because some tests count ticks where they mean "the query finished", which holds for in-process PGlite but not reliably over TCP. The `check` job fails unless they pass, as it does for the other test shards.

Seed rows through `db.run()` (`insertWorkItem()` does the work item, and `insertWorkItemSteps()` inside a transaction).
