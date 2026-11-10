# Database reset for drizzle-kit migrations

Paws's database schema is now created and changed by drizzle-kit migrations, starting from one baseline, `0000_baseline`. A database built by the earlier migrations is not carried over. Paws refuses to start on one until you opt in to setting it aside and starting on an empty database.

## What happens at the first start

If `~/.paws/paws.db` has the earlier migration table (`schema_migration`) and no drizzle-kit history (`__drizzle_migrations`), startup fails with an error that names the database, says Paws would start on an empty one, and lists what would be lost. The refused start changes nothing on disk.

Before you opt in, read [What to set up again](#what-to-set-up-again). To go ahead, set `PAWS_RESET_LEGACY_DATABASE=1` in the environment Paws starts with (for the systemd service, the env file `paws install` wrote) and start it again. Any other value is refused. Remove the variable afterwards. With it set, Paws:

1. Renames it to `paws.db.pre-drizzle-<UTC time>` beside it, for example `paws.db.pre-drizzle-20261107T030405Z`, with its `-wal` and `-shm` files. It never deletes or writes to the old file.
2. Journals one line naming the renamed file.
3. Creates a new `paws.db` from `0000_baseline` and starts on it.

Later starts find the drizzle-kit history and rename nothing. `paws review-score` and `paws login slack` refuse or set aside a legacy database the same way when they are the first command to open it. A new install starts from `0000_baseline` directly.

To see what an upgrade would do to a database first, run `bun run migrate:dry-run [path]`; it works on a copy and reports that an earlier database would be set aside.

## What to set up again

Nothing in the old database is copied. Work items, questions, evidence, settings saved in the dashboard and connections all start empty. After the upgrade:

1. Sign in to the dashboard as a Linear workspace admin. Paws makes the workspace again with that person as its first admin, as on a new install ([Workspace access](workspace-access.md)). If Paws asks, authorize the Linear app again. Members join again by signing in.
2. Connect the GitHub App again in **Integrations** and choose the repositories and their Linear teams ([GitHub App](github-app.md)).
3. Pair each runner again. A runner keeps its old identity and the new database does not know it, so on each VM stop the daemon and move its identity aside, then run a new command from **Add a runner** ([Enroll a remote Linux runner](runner-enrollment.md#add-the-host)):

   ```sh
   sudo systemctl stop paws-runner.service
   sudo mv /var/lib/paws-runner/identity /var/lib/paws-runner/identity.pre-drizzle
   ```

   Then sign in to the runner's agents again on **Runners**.

4. Delegate again any Linear issue that was in progress. Its open pull request stays on GitHub; close it or let the new run open its own.

Secrets under `~/.paws/secrets`, `config.toml` and the environment file are not in the database and stay as they were.

## Going back

The renamed file is a complete database from the earlier release. To return to it, stop Paws, install the earlier release, and rename `paws.db.pre-drizzle-<UTC time>` and its `-wal` and `-shm` files back to `paws.db`, `paws.db-wal` and `paws.db-shm`. A newer release sets it aside again.
