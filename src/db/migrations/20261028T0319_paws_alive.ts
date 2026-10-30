import type { Migration } from "../migration";

/** When Paws last recorded that it was alive, so startup can tell how long it was down. */
export const migration: Migration = {
  id: "20261028T0319_paws_alive",
  sql: `CREATE TABLE paws_alive (
  id INTEGER PRIMARY KEY CHECK(id=1),
  at INTEGER NOT NULL
) STRICT;`,
};
