import { describe } from "bun:test";
import { sql } from "drizzle-orm";
import { postgresDb, sqliteDb, type Db, type Q } from "../src/db";
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

export function* insertWorkItemSteps(q: Q, id: string, now = 0) {
  yield* q.exec(
    q.orm.insert(q.t.workItem).values({
      id,
      delegationId: `delegation-${id}`,
      linearIssueId: `issue-${id}`,
      linearIdentifier: id,
      title: id,
      state: "queued",
      branchName: `paws/${id}`,
      position: 0,
      createdAt: now,
    }),
  );
}

export function insertWorkItem(db: Db, id: string, now = 0): Promise<void> {
  return db.run((q) => insertWorkItemSteps(q, id, now));
}

/** Seed rows without their parents: SQLite drops foreign keys, Postgres skips their triggers. */
export async function withoutForeignKeys(db: Db): Promise<void> {
  if (db.dialect === "sqlite") await db.sync((orm) => orm.run(sql`PRAGMA foreign_keys = OFF`));
  else await db.orm.execute(sql`SET session_replication_role = replica`);
}
