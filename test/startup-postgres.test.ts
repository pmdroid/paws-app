import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getWorkItem, insertQueuedItem, migrate, openDatabase, setJournalSink } from "../src/db";
import { startPaws } from "../src/index";
import { tempHome } from "./helpers";
import { pgliteServer } from "./pglite";

const start = (home: string, extra: Record<string, string> = {}) =>
  startPaws({ PAWS_HOME: home, PAWS_PORT: "0", PAWS_HOST: "127.0.0.1", ...extra });

test("without [database] url Paws starts on PGlite in pglite/ and keeps its rows across restarts", async () => {
  const home = tempHome();
  const first = await start(home);
  try {
    expect(first.store.dialect).toBe("postgres");
    await insertQueuedItem(first.store, { id: "kept", now: 1 });
  } finally {
    await first.stop();
  }
  expect(existsSync(join(home, "pglite", "PG_VERSION"))).toBe(true);
  expect(existsSync(join(home, "paws.db"))).toBe(false);
  const second = await start(home);
  try {
    expect((await getWorkItem(second.store, "kept"))?.state).toBe("queued");
  } finally {
    await second.stop();
  }
});

test("an existing paws.db is renamed with its WAL and SHM, untouched, and only once", async () => {
  const home = tempHome();
  const path = join(home, "paws.db");
  const old = openDatabase(path);
  migrate(old);
  old.run("PRAGMA wal_autocheckpoint = 0");
  await insertQueuedItem(old, { id: "old", now: 1 });
  const before = {
    file: readFileSync(path),
    wal: readFileSync(`${path}-wal`),
    shm: readFileSync(`${path}-shm`),
  };
  old.close();
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    const paws = await start(home);
    try {
      expect(await getWorkItem(paws.store, "old")).toBeNull();
    } finally {
      await paws.stop();
    }
  } finally {
    restore();
  }
  const moved = readdirSync(home)
    .filter((name) => name.startsWith("paws.db.pre-postgres-"))
    .sort();
  expect(moved).toHaveLength(3);
  const [target, shm, wal] = moved.map((name) => join(home, name)) as [string, string, string];
  expect(shm).toBe(`${target}-shm`);
  expect(wal).toBe(`${target}-wal`);
  expect(existsSync(path)).toBe(false);
  expect(readFileSync(target)).toEqual(before.file);
  expect(readFileSync(wal)).toEqual(before.wal);
  expect(readFileSync(shm)).toEqual(before.shm);
  expect(lines.filter((line) => line.startsWith("database moved to Postgres"))).toEqual([
    `database moved to Postgres: the SQLite database was renamed to ${target}; Paws starts on a fresh database`,
  ]);

  const again = await start(home);
  await again.stop();
  expect(
    readdirSync(home)
      .filter((name) => name.startsWith("paws.db"))
      .sort(),
  ).toEqual(moved);
});

test("with [database] url Paws migrates that Postgres and runs on it", async () => {
  const server = await pgliteServer();
  const home = tempHome();
  try {
    const paws = await start(home, { PAWS_DATABASE_URL: server.url });
    try {
      await insertQueuedItem(paws.store, { id: "remote", now: 1 });
      const health = await (await fetch(new URL("/health", paws.server.url))).json();
      expect(health).toMatchObject({ checks: { database: { status: "ok" } } });
    } finally {
      await paws.stop();
    }
    expect((await getWorkItem(server.store, "remote"))?.state).toBe("queued");
    expect(existsSync(join(home, "pglite"))).toBe(false);
  } finally {
    await server.close();
  }
});
