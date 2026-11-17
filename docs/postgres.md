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

Paws applies database updates automatically at startup. PGlite allows one process per directory, so Paws holds `~/.paws/pglite` while it runs, recorded in `~/.paws/pglite.lock` with its process id, and refuses to start when another live process holds it. `paws review-score` and `paws login slack` need `[database] url`.

`paws doctor` and `paws probes collect` read the workspace, its GitHub App and the values saved on the Settings page from the same database: the Postgres at the URL, else `~/.paws/pglite`. While Paws is running and holds PGlite, they use `config.toml` and print one line saying the saved Settings-page values were not read.

## Secrets

With an external Postgres server, Paws keeps encrypted secrets in the database. With PGlite, secrets stay under `~/.paws/secrets`. Keep the master key separate from database backups.

For a persistent master key across hosts, set `PAWS_SECRET_KEY` to the existing key's base64 value:

```sh
base64 < ~/.paws/secrets/.envelope-key
```

Keep that value secret and available to every Paws instance using the database. Paws copies existing encrypted secret files into the external database when it first opens them; the files remain in place. Run `bun run paws doctor` to check secret storage and decryption before moving the service.

A `~/.paws/paws.db` from an earlier release is set aside at the first start: see [Moving to Postgres](database-reset.md).

## A database from an older Paws

Paws ships one migration, `0000_baseline`. Before it applies migrations, Paws reads the migration history the database recorded. When that history names a migration Paws does not ship, Paws refuses to start, prints one line and exits with status 1:

```text
This database was created by an older Paws. Reset it to start this version.
```

When the unknown migration is newer than the baseline, the line is `This database was created by a newer Paws. Start that version or reset it.` A refused start changes nothing in the database. `paws db check` prints the same message, and `paws doctor` fails its `database` check with it.

There is no upgrade path. To reset, stop Paws and start it on an empty database: move `~/.paws/pglite` aside, or drop and create the database at `[database] url`. Then set up again as after [Moving to Postgres](database-reset.md#what-to-set-up-again).

## `paws db check`

```sh
bun run paws db check
```

With a URL set, it connects, applies the pending Postgres migrations, reads back the migration history, checks it against the migrations this Paws ships, asks the server for its version and prints:

```text
ok · Postgres db.example.com:5432/paws · server 17.5 · 1 of 1 migrations applied
```

Without a URL, it checks `~/.paws/pglite` the same way and prints `ok · PGlite ~/.paws/pglite · …`, or that there is no database yet before the first start. While Paws is running it holds that directory, so the check prints `Paws is running; stop it or set [database] url to check` and exits non-zero.

It exits non-zero on any failure, such as an unreachable server, a refused login or a migration that differs, with a message that names the host and database but not the password.
