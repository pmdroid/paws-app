import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as pgSchema from "./schema-pg";

export type PgOrm = PgDatabase<PgQueryResultHKT, typeof pgSchema>;

type Step =
  | { readonly kind: "all" | "one" | "exec"; readonly query: unknown }
  | { readonly kind: "transaction"; readonly body: Body<unknown> };

export type Steps<T> = Generator<Step, T, unknown>;

type Body<T> = (q: Q) => Steps<T>;

export type Q = {
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

export type Db = Runs & {
  readonly orm: PgOrm;
};

export type PgDb = Db;

function queries(handle: unknown): Q {
  return {
    orm: handle as PgOrm,
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

async function drivePg<T>(pg: PgOrm, body: Body<T>): Promise<T> {
  const steps = body(queries(pg));
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
    orm: pg,
    run: (body) => drivePg(pg, body),
    transaction: (body) => pg.transaction((tx) => drivePg(tx, body)),
  };
}

export function* syncSteps<T>(work: () => T): Steps<T> {
  yield* [];
  return work();
}
