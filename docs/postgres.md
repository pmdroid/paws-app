# Database

Paws keeps its state in Postgres. On a single host it runs embedded Postgres (PGlite) in `~/.paws/pglite`, with nothing to install. For several Paws processes sharing one database, point it at a Postgres server.

## The setting

Name the server in `PAWS_DATABASE_URL`, the only place Paws reads the URL from:

```sh
PAWS_DATABASE_URL=postgres://paws:password@db.example.com:5432/paws
```

The URL must start with `postgres://` or `postgresql://` and name a host. A `max` query parameter (`?max=4`) sets the connection pool size; the default is 10. Without it, Paws uses PGlite in `~/.paws/pglite`.

Paws reads no configuration file. When `~/.paws/config.toml` exists and `PAWS_DATABASE_URL` is not set, Paws refuses to start with `Set PAWS_DATABASE_URL in the service environment; config.toml is no longer read`, so an install that named its server in that file never starts on an empty PGlite. Move the URL into the service environment; with the variable set, Paws ignores the file and never deletes it.

The URL holds the password, so it is a secret: keep the environment file that sets it, such as `PAWS_HOME/https.env`, at mode `0600`. Paws never prints it; messages name only the host and database, for example `db.example.com:5432/paws`.

## Starting Paws

Paws applies database updates automatically at startup. PGlite allows one process per directory, so Paws holds `~/.paws/pglite` while it runs, recorded in `~/.paws/pglite.lock` with its process id, and refuses to start when another live process holds it. While Paws runs on PGlite, `paws login slack` and `paws runner-storage` refuse to start: use Settings, or stop Paws first. `paws setup-link` works while Paws runs.

The Prerequisites checks on Workspace › Integrations read the workspace, its GitHub App and the values saved on the Settings page from the same database.

## Secrets

Paws keeps encrypted secrets in the database, with PGlite or an external Postgres server. On first start, Paws copies existing secret files from `~/.paws/secrets` into the database and reads them from there afterwards. At each start, Paws moves every secret file whose value matches its database row into `~/.paws/secrets/.retired-<UTC time>/`, and keeps a file that differs or whose row was deleted. The startup log names each file it kept. Retired copies are still usable secrets: once you've checked that a restore from the database works, delete the folder that Prerequisites names. With PGlite, the browser setup token stays in `~/.paws/secrets/setup-token` until setup completes. The master key stays in `PAWS_SECRET_KEY` or `~/.paws/secrets/.envelope-key`. Keep it separate from database backups.

For a persistent master key across hosts, set `PAWS_SECRET_KEY` to the existing key's base64 value:

```sh
base64 < ~/.paws/secrets/.envelope-key
```

Keep that value secret and available to every Paws instance using the database. Paws copies existing encrypted secret files into the external database when it first opens them, then moves the matching files aside as described above. Check secret storage and decryption under Prerequisites on Workspace › Integrations before moving the service.

Paws ignores a `~/.paws/paws.db` from an earlier release and leaves it in place: see [Moving to Postgres](database-reset.md).

## A database from an older Paws

Paws ships one migration, `0000_baseline`. Before it applies migrations, Paws reads the migration history the database recorded. When that history names a migration Paws does not ship, Paws refuses to start, prints one line and exits with status 1:

```text
This database was created by an older Paws. Reset it to start this version.
```

When the unknown migration is newer than the baseline, the line is `This database was created by a newer Paws. Start that version or reset it.` A refused start changes nothing in the database. The Prerequisites checks report the same message in the `database` check.

There is no upgrade path. To reset, stop Paws and start it on an empty database: move `~/.paws/pglite` aside, or drop and create the database at `PAWS_DATABASE_URL`. Then set up again as after [Moving to Postgres](database-reset.md#what-to-set-up-again).
