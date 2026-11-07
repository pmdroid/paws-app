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

export type PgDb = {
  readonly dialect: "postgres";
  readonly orm: PgOrm;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
};

export type Db = SqliteDb | PgDb;

const sqliteDbs = new WeakMap<Database, SqliteDb>();
let savepoints = 0;

export function sqliteDb(database: Database): SqliteDb {
  let db = sqliteDbs.get(database);
  if (db === undefined) {
    db = openSqliteDb(database);
    sqliteDbs.set(database, db);
  }
  return db;
}

function openSqliteDb(database: Database): SqliteDb {
  const handle = orm(database);
  const exec = (...statements: string[]) =>
    statements.forEach((statement) => handle.run(sql.raw(statement)));
  const sync = <T>(fn: (orm: Orm) => T): Promise<T> => {
    try {
      return Promise.resolve(fn(handle));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const savepoint = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
    const name = `db_tx_${(savepoints += 1)}`;
    exec(`SAVEPOINT ${name}`);
    try {
      const value = await fn(tx);
      exec(`RELEASE ${name}`);
      return value;
    } catch (error) {
      exec(`ROLLBACK TO ${name}`, `RELEASE ${name}`);
      throw error;
    }
  };
  const tx: SqliteDb = { dialect: "sqlite", orm: handle, sync, transaction: savepoint };
  let tail: Promise<void> = Promise.resolve();
  let active = false;
  return {
    dialect: "sqlite",
    orm: handle,
    sync,
    transaction: async (fn) => {
      if (database.inTransaction && !active)
        throw new Error(
          "db.transaction() can't run inside a synchronous immediate(); that transaction commits before the body awaits",
        );
      const previous = tail;
      let release = () => {};
      tail = new Promise((resolve) => (release = resolve));
      await previous;
      active = true;
      try {
        exec("BEGIN IMMEDIATE");
        try {
          const value = await fn(tx);
          exec("COMMIT");
          return value;
        } catch (error) {
          exec("ROLLBACK");
          throw error;
        }
      } finally {
        active = false;
        release();
      }
    },
  };
}

export function postgresDb(pg: PgOrm): PgDb {
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
