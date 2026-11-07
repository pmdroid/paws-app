import { describe } from "bun:test";
import { pgSchema, postgresDb, schema, sqliteDb, type Db } from "../src/db";
import { tempDb } from "./helpers";
import { pgliteDb } from "./pglite";

export type DialectDb = { db: Db; close(): Promise<void> };

type Dialect = { name: Db["dialect"]; open(): Promise<DialectDb> };

const DIALECTS: readonly Dialect[] = [
  {
    name: "sqlite",
    open: async () => {
      const database = tempDb();
      return { db: sqliteDb(database), close: async () => database.close() };
    },
  },
  {
    name: "postgres",
    open: async () => {
      const pg = await pgliteDb();
      return { db: postgresDb(pg), close: () => pg.$client.close() };
    },
  },
];

export function forEachDialect(suite: (open: () => Promise<DialectDb>) => void): void {
  for (const dialect of DIALECTS) describe(dialect.name, () => suite(dialect.open));
}

export async function insertWorkItem(db: Db, id: string, now = 0): Promise<void> {
  const row = {
    id,
    delegationId: `delegation-${id}`,
    linearIssueId: `issue-${id}`,
    linearIdentifier: id,
    title: id,
    state: "queued",
    branchName: `paws/${id}`,
    position: 0,
    createdAt: now,
  };
  if (db.dialect === "sqlite")
    await db.sync((orm) => orm.insert(schema.workItem).values(row).run());
  else await db.orm.insert(pgSchema.workItem).values(row);
}
