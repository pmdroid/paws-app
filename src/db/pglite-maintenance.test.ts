import { afterEach, expect, test } from "bun:test";
import {
  listJobs,
  maintainPglite,
  openPostgres,
  PGLITE_VACUUM_EVERY_MS,
  PGLITE_VACUUM_JOB,
  postgresDb,
} from "./index";
import { pgliteDb, sqlRows } from "../../test/pglite";

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function recorder() {
  const handlers = new Map<string, () => Promise<void>>();
  return {
    handlers,
    register: (queue: string, run: () => Promise<void>) => handlers.set(queue, run),
  };
}

const outboxStats = (db: Parameters<typeof sqlRows>[0]) =>
  sqlRows<{ last_analyze: unknown; last_vacuum: unknown }>(
    db,
    "SELECT last_analyze, last_vacuum FROM pg_stat_user_tables WHERE relname = 'outbox'",
  );

test("a PGlite store is analyzed at startup and vacuumed by a recurring job", async () => {
  const pg = await pgliteDb();
  closers.push(() => pg.$client.close());
  const db = postgresDb(pg);
  const jobs = recorder();
  const lines: string[] = [];

  await maintainPglite(db, jobs, (line) => lines.push(line));

  expect((await outboxStats(db))[0]?.last_analyze).not.toBeNull();
  const [job] = (await listJobs(db)).filter((row) => row.queue === PGLITE_VACUUM_JOB);
  expect(job?.recurringEveryMs).toBe(PGLITE_VACUUM_EVERY_MS);
  await jobs.handlers.get(PGLITE_VACUUM_JOB)!();
  expect((await outboxStats(db))[0]?.last_vacuum).not.toBeNull();
  expect(lines).toEqual([]);
});

test("a failed ANALYZE logs one line and does not throw", async () => {
  const pg = await pgliteDb();
  closers.push(() => pg.$client.close());
  const db = postgresDb(pg);
  const lines: string[] = [];
  const orm = Object.create(db.orm, {
    execute: { value: () => Promise.reject(new Error("boom")) },
  }) as typeof db.orm;

  await maintainPglite({ ...db, orm }, recorder(), (line) => lines.push(line));

  expect(lines).toEqual(["PGlite ANALYZE failed: boom"]);
});

test("a Postgres server store gets no maintenance job", async () => {
  const server = openPostgres("postgres://paws@127.0.0.1:1/paws");
  closers.push(() => server.$client.close());
  const jobs = recorder();

  await maintainPglite(postgresDb(server), jobs, () => undefined);

  expect(jobs.handlers.size).toBe(0);
});
