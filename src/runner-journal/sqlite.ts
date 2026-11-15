import { measureHostOperation } from "../host-operation";
import type { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { pgSchema, type Q, type Steps } from "../db";
import { orm, type Orm } from "./orm";

export type { Q } from "../db";
type Body<T> = (q: Q) => Steps<T>;
type Step = Steps<unknown> extends Generator<infer S, unknown, unknown> ? S : never;

type Runs = {
  run<T>(body: Body<T>): Promise<T>;
  transaction<T>(body: Body<T>): Promise<T>;
};

export type SqliteDb = Runs & {
  readonly orm: Orm;
  sync<T>(fn: (orm: Orm) => T): Promise<T>;
};

function queries(handle: unknown): Q {
  return {
    orm: handle as Q["orm"],
    t: pgSchema,
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
  const q = queries(handle);
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
