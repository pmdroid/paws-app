# Moving to Postgres

Paws runs on Postgres: PGlite in `~/.paws/pglite` by default, or the server named by `[database] url` ([Database](postgres.md)). The SQLite database of earlier releases is not carried over, and Paws starts fresh.

## What happens at the first start

If `~/.paws/paws.db` exists, Paws:

1. Renames it to `paws.db.pre-postgres-<UTC time>` beside it, for example `paws.db.pre-postgres-20261111T030405Z`, with its `-wal` and `-shm` files. It never deletes or writes to the old file.
2. Journals one line naming the renamed file.
3. Opens the Postgres database, applies its migrations and starts on it.

Later starts find no `paws.db` and rename nothing.

## What to set up again

Nothing in the old database is copied. Work items, questions, evidence, settings saved in the dashboard and connections all start empty. After the upgrade:

1. Sign in to the dashboard as a Linear workspace admin. Paws makes the workspace again with that person as its first admin, as on a new install ([Workspace access](workspace-access.md)). Connect Linear again in **Settings** if Paws asks. Members join again by signing in.
2. Connect GitHub again in **Settings**: the GitHub App in **Integrations**, then choose the repositories and their Linear teams ([GitHub App](github-app.md)).
3. Pair each runner again. A runner keeps its old identity and the new database does not know it, so on each VM stop the daemon and move its identity aside, then run a new command from **Add a runner** ([Enroll a remote Linux runner](runner-enrollment.md#add-the-host)):

   ```sh
   sudo systemctl stop paws-runner.service
   sudo mv /var/lib/paws-runner/identity /var/lib/paws-runner/identity.pre-postgres
   ```

   Then sign in to the runner's agents again on **Runners**.

4. Delegate again any Linear issue that was in progress. Its open pull request stays on GitHub; close it or let the new run open its own.

Secrets under `~/.paws/secrets`, `config.toml` and the environment file are not in the database and stay as they were.

## Going back

The renamed file is a complete database from the earlier release. To return to it, stop Paws, install the earlier release, and rename `paws.db.pre-postgres-<UTC time>` and its `-wal` and `-shm` files back to `paws.db`, `paws.db-wal` and `paws.db-shm`.
