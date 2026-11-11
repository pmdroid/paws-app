# Database

Paws keeps its state in Postgres. On a single host it runs embedded Postgres (PGlite) in `~/.paws/pglite`, with nothing to install. For several Paws processes sharing one database, point it at a Postgres server.

## The setting

Name the server in `config.toml`:

```toml
[database]
url = "postgres://paws:password@db.example.com:5432/paws"
```

or in `PAWS_DATABASE_URL`, which wins over `config.toml`. The URL must start with `postgres://` or `postgresql://` and name a host. A `max` query parameter (`?max=4`) sets the connection pool size; the default is 10. Without either setting, Paws uses PGlite in `~/.paws/pglite`.

The URL holds the password, so it is a secret: keep `config.toml` at mode `0600`. Paws never prints it; messages name only the host and database, for example `db.example.com:5432/paws`.

## Starting Paws

At start Paws opens the database, applies the Postgres migrations it has not applied yet (`src/db/drizzle-pg/`) and runs on it. Only the running Paws opens `~/.paws/pglite`, so `paws review-score` and `paws login slack` need `[database] url`.

A `~/.paws/paws.db` from an earlier release is set aside at the first start: see [Moving to Postgres](database-reset.md).

## `paws db check`

```sh
bun run paws db check
```

With a URL set, it connects, applies the pending Postgres migrations, reads back the migration history, checks it against the migrations this Paws ships, asks the server for its version and prints:

```text
ok · Postgres db.example.com:5432/paws · server 17.5 · 1 of 1 migrations applied
```

Without a URL, it checks `~/.paws/paws.db` the SQLite way: every migration recorded in it must match the one this Paws ships.

It exits non-zero on any failure, such as an unreachable server, a refused login or a migration that differs, with a message that names the host and database but not the password.
