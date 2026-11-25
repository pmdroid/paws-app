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

const committedHooks = new WeakMap<Q, (() => void)[]>();

export function afterCommit(q: Q, hook: () => void): void {
  const hooks = committedHooks.get(q);
  if (hooks === undefined) queueMicrotask(hook);
  else hooks.push(hook);
}

function queries(handle: unknown, hooks: (() => void)[]): Q {
  const q: Q = {
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
  committedHooks.set(q, hooks);
  return q;
}

async function drivePg<T>(pg: PgOrm, body: Body<T>, hooks: (() => void)[]): Promise<T> {
  const steps = body(queries(pg, hooks));
  const perform = async (step: Step): Promise<unknown> => {
    if (step.kind === "transaction") {
      const inner: (() => void)[] = [];
      const value = await pg.transaction((tx) => drivePg(tx, step.body, inner));
      hooks.push(...inner);
      return value;
    }
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

async function committed<T>(work: (hooks: (() => void)[]) => Promise<T>): Promise<T> {
  const hooks: (() => void)[] = [];
  const value = await work(hooks);
  for (const hook of hooks) hook();
  return value;
}

export function postgresDb(pg: PgOrm): PgDb {
  return {
    orm: pg,
    run: (body) => committed((hooks) => drivePg(pg, body, hooks)),
    transaction: (body) => committed((hooks) => pg.transaction((tx) => drivePg(tx, body, hooks))),
  };
}

export function* syncSteps<T>(work: () => T): Steps<T> {
  yield* [];
  return work();
}
