# Database

Paws keeps its state in Postgres. On a single host it runs embedded Postgres (PGlite) in `~/.paws/pglite`, with nothing to install. For several Paws processes sharing one database, point it at a Postgres server.

## The setting

Name the server in `PAWS_DATABASE_URL`, the only place Paws reads the URL from:

```sh
PAWS_DATABASE_URL=postgres://paws:password@db.example.com:5432/paws
```

The URL must start with `postgres://` or `postgresql://` and name a host. A `max` query parameter (`?max=4`) sets the connection pool size; the default is 10. Without it, Paws uses PGlite in `~/.paws/pglite`.

The URL holds the password, so it is a secret: keep the environment file that sets it, such as `PAWS_HOME/https.env`, at mode `0600`. Paws never prints it; messages name only the host and database, for example `db.example.com:5432/paws`.

## Starting Paws

Paws applies database updates automatically at startup. PGlite allows one process per directory, so Paws holds `~/.paws/pglite` while it runs, recorded in `~/.paws/pglite.lock` with its process id, and refuses to start when another live process holds it. `paws login slack` needs `PAWS_DATABASE_URL`.

The Prerequisites checks on Workspace › Integrations read the workspace, its GitHub App and the values saved on the Settings page from the same database.

## Secrets

With an external Postgres server, Paws keeps encrypted secrets in the database. With PGlite, secrets stay under `~/.paws/secrets`. Keep the master key separate from database backups.

For a persistent master key across hosts, set `PAWS_SECRET_KEY` to the existing key's base64 value:

```sh
base64 < ~/.paws/secrets/.envelope-key
```

Keep that value secret and available to every Paws instance using the database. Paws copies existing encrypted secret files into the external database when it first opens them; the files remain in place. Check secret storage and decryption under Prerequisites on Workspace › Integrations before moving the service.

A `~/.paws/paws.db` from an earlier release is set aside at the first start: see [Moving to Postgres](database-reset.md).

## A database from an older Paws

Paws ships one migration, `0000_baseline`. Before it applies migrations, Paws reads the migration history the database recorded. When that history names a migration Paws does not ship, Paws refuses to start, prints one line and exits with status 1:

```text
This database was created by an older Paws. Reset it to start this version.
```

When the unknown migration is newer than the baseline, the line is `This database was created by a newer Paws. Start that version or reset it.` A refused start changes nothing in the database. The Prerequisites checks report the same message in the `database` check.

There is no upgrade path. To reset, stop Paws and start it on an empty database: move `~/.paws/pglite` aside, or drop and create the database at `PAWS_DATABASE_URL`. Then set up again as after [Moving to Postgres](database-reset.md#what-to-set-up-again).
