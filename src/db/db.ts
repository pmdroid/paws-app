import type { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { orm, type Orm } from "./orm";
import type * as pgSchema from "./schema-pg";

export type PgOrm = PgDatabase<PgQueryResultHKT, typeof pgSchema>;

export type SqliteDb = {
  readonly dialect: "sqlite";
  readonly orm: Orm;
  sync<T>(fn: (orm: Orm) => T): Promise<T>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
};

export type PostgresDb = {
  readonly dialect: "postgres";
  readonly orm: PgOrm;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
};

export type Db = SqliteDb | PostgresDb;

const sqliteDbs = new WeakMap<Database, SqliteDb>();
let savepoints = 0;

export function sqliteDb(database: Database): SqliteDb {
  let db = sqliteDbs.get(database);
  if (db === undefined) {
    const handle = orm(database);
    const sync = <T>(fn: (orm: Orm) => T): Promise<T> => {
      try {
        return Promise.resolve(fn(handle));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const self: SqliteDb = {
      dialect: "sqlite",
      orm: handle,
      sync,
      transaction: async (fn) => {
        const savepoint = database.inTransaction ? `db_tx_${(savepoints += 1)}` : null;
        const exec = (...statements: string[]) =>
          statements.forEach((statement) => handle.run(sql.raw(statement)));
        exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
        try {
          const value = await fn(self);
          exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
          return value;
        } catch (error) {
          if (savepoint) exec(`ROLLBACK TO ${savepoint}`, `RELEASE ${savepoint}`);
          else exec("ROLLBACK");
          throw error;
        }
      },
    };
    db = self;
    sqliteDbs.set(database, db);
  }
  return db;
}

export function postgresDb(pg: PgOrm): PostgresDb {
  return {
    dialect: "postgres",
    orm: pg,
    transaction: (fn) => pg.transaction((tx) => fn(postgresDb(tx))),
  };
}

export function settled<T>(promise: Promise<T>): T {
  const status = Bun.peek.status(promise);
  if (status === "pending")
    throw new Error("settled() got a pending promise; await it from an async caller instead");
  const value = Bun.peek(promise);
  if (status === "rejected") {
    void promise.then(undefined, (error: unknown) => error);
    throw value;
  }
  return value as T;
}
