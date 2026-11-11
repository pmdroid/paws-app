import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pawsPaths } from "../src/config";
import {
  openDatabase,
  openPawsStore,
  setAsideSqliteDatabase,
  setSyncCursorSteps,
  syncCursorSteps,
  type Db,
} from "../src/db";
import { setJournalSink } from "../src/journal";
import { tempHome } from "./helpers";
import { pgliteServer } from "./pglite";

const NOW = new Date("2026-11-11T03:04:05.678Z");

async function roundTrip(store: Db, name: string) {
  await store.run((q) => setSyncCursorSteps(q, name, 42));
  return store.run((q) => syncCursorSteps(q, name));
}

describe("openPawsStore", () => {
  test("without a url opens PGlite in pglite/, migrated, and keeps its rows across opens", async () => {
    const paths = pawsPaths(tempHome());
    const first = await openPawsStore({ url: null, pgliteDir: paths.pgliteDir });
    try {
      expect(first.store.dialect).toBe("postgres");
      expect(await roundTrip(first.store, "kept")).toBe(42);
    } finally {
      await first.close();
    }
    expect(paths.pgliteDir).toBe(join(paths.home, "pglite"));
    expect(existsSync(join(paths.pgliteDir, "PG_VERSION"))).toBe(true);
    expect(existsSync(paths.db)).toBe(false);
    const second = await openPawsStore({ url: null, pgliteDir: paths.pgliteDir });
    try {
      expect(await second.store.run((q) => syncCursorSteps(q, "kept"))).toBe(42);
    } finally {
      await second.close();
    }
  }, 30_000);

  test("with a url migrates the Postgres there and runs on it", async () => {
    const server = await pgliteServer();
    try {
      const { store, close } = await openPawsStore({
        url: server.url,
        pgliteDir: join(tempHome(), "unused"),
      });
      try {
        expect(await roundTrip(store, "server")).toBe(42);
      } finally {
        await close();
      }
      expect(await server.store.run((q) => syncCursorSteps(q, "server"))).toBe(42);
    } finally {
      await server.close();
    }
  });

  test("with a url it can't reach it rejects", async () => {
    await expect(
      openPawsStore({ url: "postgres://paws@127.0.0.1:1/paws", pgliteDir: tempHome() }),
    ).rejects.toThrow();
  });
});

describe("setAsideSqliteDatabase", () => {
  test("renames paws.db with its WAL and SHM, untouched, once", () => {
    const home = tempHome();
    const path = join(home, "paws.db");
    const db = openDatabase(path);
    db.run("PRAGMA wal_autocheckpoint = 0");
    db.run("CREATE TABLE kept (value TEXT)");
    db.run("INSERT INTO kept VALUES ('old')");
    const before = {
      file: readFileSync(path),
      wal: readFileSync(`${path}-wal`),
      shm: readFileSync(`${path}-shm`),
    };
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    let moved: string | null;
    try {
      moved = setAsideSqliteDatabase(path, NOW);
    } finally {
      restore();
      db.close();
    }
    const target = join(home, "paws.db.pre-postgres-20261111T030405Z");
    expect(moved).toBe(target);
    expect(lines).toEqual([
      `database moved to Postgres: the SQLite database was renamed to ${target}; Paws starts on a fresh database`,
    ]);
    expect(readFileSync(target)).toEqual(before.file);
    expect(readFileSync(`${target}-wal`)).toEqual(before.wal);
    expect(readFileSync(`${target}-shm`)).toEqual(before.shm);
    const names = readdirSync(home).sort();
    expect(names).toEqual([
      "paws.db.pre-postgres-20261111T030405Z",
      "paws.db.pre-postgres-20261111T030405Z-shm",
      "paws.db.pre-postgres-20261111T030405Z-wal",
    ]);

    expect(setAsideSqliteDatabase(path, new Date(NOW.getTime() + 60_000))).toBeNull();
    expect(readdirSync(home).sort()).toEqual(names);
  });

  test("does nothing when there is no paws.db", () => {
    const home = tempHome();
    expect(setAsideSqliteDatabase(join(home, "paws.db"), NOW)).toBeNull();
    expect(readdirSync(home)).toEqual([]);
  });
});
