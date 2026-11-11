import { measureHostOperation } from "../host-operation";
import type { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { orm, type Orm } from "./orm";
import * as sqliteSchema from "./schema";
import * as pgSchema from "./schema-pg";

export type PgOrm = PgDatabase<PgQueryResultHKT, typeof pgSchema>;

type Step =
  | { readonly kind: "all" | "one" | "exec"; readonly query: unknown }
  | { readonly kind: "transaction"; readonly body: Body<unknown> };

export type Steps<T> = Generator<Step, T, unknown>;

type Body<T> = (q: Q) => Steps<T>;

export type Q = {
  readonly dialect: "sqlite" | "postgres";
  readonly orm: PgOrm;
  readonly t: typeof pgSchema;
  all<R>(query: PromiseLike<R[]>): Steps<R[]>;
  one<R>(query: PromiseLike<R[]>): Steps<R | undefined>;
  exec(query: PromiseLike<unknown>): Steps<void>;
  transaction<T>(body: Body<T>): Steps<T>;
};

type Runs = {
  run<T>(body: Body<T>): Promise<T>;
  transaction<T>(body: Body<T>): Promise<T>;
};

export type SqliteDb = Runs & {
  readonly dialect: "sqlite";
  readonly orm: Orm;
  sync<T>(fn: (orm: Orm) => T): Promise<T>;
};

export type PgDb = Runs & {
  readonly dialect: "postgres";
  readonly orm: PgOrm;
};

export type Db = SqliteDb | PgDb;

function queries(dialect: Q["dialect"], handle: unknown, t: unknown): Q {
  return {
    dialect,
    orm: handle as PgOrm,
    t: t as typeof pgSchema,
    *all<R>(query: PromiseLike<R[]>) {
      return (yield { kind: "all", query }) as R[];
    },
    *one<R>(query: PromiseLike<R[]>) {
      return (yield { kind: "one", query }) as R | undefined;
    },
    *exec(query: PromiseLike<unknown>) {
      yield { kind: "exec", query };
    },
    *transaction<T>(body: Body<T>) {
      return (yield { kind: "transaction", body: body as Body<unknown> }) as T;
    },
  };
}

function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

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

type SqliteQuery = { all(): unknown[]; run(): unknown };

function openSqliteDb(database: Database): SqliteDb {
  const handle = orm(database);
  const q = queries("sqlite", handle, sqliteSchema);
  const exec = (...statements: string[]) =>
    statements.forEach((statement) => handle.run(sql.raw(statement)));
  const within = <T>(begin: string, commit: string, rollback: string[], body: Body<T>): T => {
    exec(begin);
    try {
      const value = drive(body(q));
      exec(commit);
      return value;
    } catch (error) {
      exec(...rollback);
      throw error;
    }
  };
  const savepoint = <T>(body: Body<T>): T => {
    const name = `db_tx_${(savepoints += 1)}`;
    return within(
      `SAVEPOINT ${name}`,
      `RELEASE ${name}`,
      [`ROLLBACK TO ${name}`, `RELEASE ${name}`],
      body,
    );
  };
  const perform = (step: Step): unknown => {
    if (step.kind === "transaction") return savepoint(step.body);
    const query = step.query as SqliteQuery;
    if (step.kind === "exec") return void query.run();
    const rows = query.all();
    return step.kind === "all" ? rows : rows[0];
  };
  function drive<T>(steps: Steps<T>): T {
    let next = steps.next();
    while (!next.done) {
      let value: unknown;
      try {
        value = perform(next.value);
      } catch (error) {
        next = steps.throw(error);
        continue;
      }
      next = steps.next(value);
    }
    return next.value;
  }
  return {
    dialect: "sqlite",
    orm: handle,
    sync: (fn) => settle(() => measureHostOperation(() => fn(handle))),
    run: (body) => settle(() => measureHostOperation(() => drive(body(q)))),
    transaction: (body) =>
      settle(() =>
        measureHostOperation(() =>
          database.inTransaction
            ? savepoint(body)
            : within("BEGIN IMMEDIATE", "COMMIT", ["ROLLBACK"], body),
        ),
      ),
  };
}

async function drivePg<T>(pg: PgOrm, body: Body<T>): Promise<T> {
  const steps = body(queries("postgres", pg, pgSchema));
  const perform = async (step: Step): Promise<unknown> => {
    if (step.kind === "transaction") return pg.transaction((tx) => drivePg(tx, step.body));
    const rows = await (step.query as PromiseLike<unknown>);
    if (step.kind === "exec") return undefined;
    return step.kind === "all" ? rows : (rows as unknown[])[0];
  };
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try {
      value = await perform(next.value);
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(value);
  }
  return next.value;
}

export function postgresDb(pg: PgOrm): PgDb {
  return {
    dialect: "postgres",
    orm: pg,
    run: (body) => drivePg(pg, body),
    transaction: (body) => pg.transaction((tx) => drivePg(tx, body)),
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

export function* syncSteps<T>(work: () => T): Steps<T> {
  yield* [];
  return work();
}
