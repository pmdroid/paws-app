# Postgres (preview)

Paws runs on SQLite (`~/.paws/paws.db`). Postgres is coming as an option next to it. For now Paws can connect to a Postgres server and build its schema there, so a setup can be tested before Paws runs on it. Paws itself does not run on Postgres yet.

## The setting

Name the server in `config.toml`:

```toml
[database]
url = "postgres://paws:password@db.example.com:5432/paws"
```

or in `PAWS_DATABASE_URL`, which wins over `config.toml`. The URL must start with `postgres://` or `postgresql://` and name a host. Without either setting, Paws uses SQLite.

The URL holds the password, so it is a secret: keep `config.toml` at mode `0600`. Paws never prints it; messages name only the host and database, for example `db.example.com:5432/paws`.

## `paws db check`

```sh
bun run paws db check
```

With a URL set, it connects, applies the pending Postgres migrations (`src/db/drizzle-pg/`), reads back the migration history, checks it against the migrations this Paws ships, asks the server for its version and prints:

```text
ok · Postgres db.example.com:5432/paws · server 17.5 · 1 of 1 migrations applied
```

Without a URL, it says SQLite is in use and checks `paws.db` the same way: every migration recorded in it must match the one this Paws ships. It does not change the database; Paws applies pending SQLite migrations at start.

It exits non-zero on any failure, such as an unreachable server, a refused login or a migration that differs, with a message that names the host and database but not the password.

## Starting Paws

While a URL is set, `bun run paws` refuses to start:

```text
Postgres is configured but Paws can't run on it yet; use `paws db check` to test the connection
```

Remove `[database] url` and unset `PAWS_DATABASE_URL` to start on SQLite.
