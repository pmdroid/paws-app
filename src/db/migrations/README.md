# Migrations

Each new migration is one file here. `src/db/migrations.ts` is frozen at `155_pull_comment`; do not add to it.

Name the file after the current UTC time to the minute and what it does, and export `migration` with the same id:

```ts
// src/db/migrations/20261026T0512_pull_comment_author.ts
import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261026T0512_pull_comment_author",
  sql: `ALTER TABLE pull_comment ADD COLUMN author_login TEXT;`,
};
```

Paws applies the frozen list, then these files sorted by id. A branch that merges after a later id was applied still runs, because `migrate()` applies every id it has not recorded. So a migration must not rely on another file-based migration that is not already on `main`.

Shipped files are never edited or renamed.
