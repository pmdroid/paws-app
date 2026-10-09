import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { NotImplementedError } from "../src/core";
import {
  claimNextJob,
  dispatchOutbox,
  enqueueJob,
  enqueueOutbox,
  getJob,
  getOutbox,
  migrate,
  openDatabase,
} from "../src/db";
import { tempHome } from "./helpers";

function openTemp() {
  const db = openDatabase(join(tempHome(), "paws.db"));
  migrate(db);
  return db;
}

describe("sqlite", () => {
  test("sets durability pragmas on a file database", () => {
    const db = openTemp();
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()).toEqual({
      synchronous: 2,
    });
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()).toEqual({
      timeout: 5000,
    });
    expect(db.query<{ temp_store: number }, []>("PRAGMA temp_store").get()).toEqual({
      temp_store: 2,
    });
    db.close();
  });

  test("migrate is idempotent and creates job and outbox", () => {
    const db = openTemp();
    migrate(db);
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(names).toContain("job");
    expect(names).toContain("outbox");
    expect(names).toContain("schema_migration");
    db.close();
  });

  test("enqueueJob round-trips and claim is still a stub", () => {
    const db = openTemp();
    const id = enqueueJob(db, {
      queue: "run",
      jobKey: "item-1",
      payload: { itemId: "i1" },
      priority: 1,
    });
    expect(getJob(db, id)).toMatchObject({
      id,
      queue: "run",
      jobKey: "item-1",
      payload: { itemId: "i1" },
      status: "pending",
      priority: 1,
    });
    expect(() => claimNextJob(db)).toThrow(NotImplementedError);
    expect(() =>
      db.run("INSERT INTO job (queue, payload, run_at, created_at) VALUES ('q', '{', 0, 0)"),
    ).toThrow();
    db.close();
  });

  test("enqueueOutbox round-trips and dispatch is still a stub", () => {
    const db = openTemp();
    const id = enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      idempotencyKey: "act-1",
      orderingKey: "session-1",
      payload: { body: "Starting" },
    });
    expect(getOutbox(db, id)).toMatchObject({
      id,
      target: "linear",
      op: "activity",
      idempotencyKey: "act-1",
      orderingKey: "session-1",
      payload: { body: "Starting" },
      status: "pending",
    });
    expect(() =>
      enqueueOutbox(db, { target: "linear", op: "activity", idempotencyKey: "act-1" }),
    ).toThrow();
    expect(() => dispatchOutbox(db)).toThrow(NotImplementedError);
    db.close();
  });
});
