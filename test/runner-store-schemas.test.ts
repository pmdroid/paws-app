import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { openDatabase } from "../src/db";
import { openRunnerDaemon } from "../src/runner-daemon";
import { createCommandStore } from "../src/runner-daemon/commands-ddl";
import * as commandSchema from "../src/runner-daemon/commands-schema";
import { openRunnerHealthRuntime } from "../src/runner-health-runtime";
import { createHealthStore } from "../src/runner-health-runtime/health-ddl";
import { healthExecution } from "../src/runner-health-runtime/health-schema";
import { openRunnerRetroRuntime } from "../src/runner-retro-runtime";
import { createRetroStore } from "../src/runner-retro-runtime/retro-ddl";
import { retroExecution } from "../src/runner-retro-runtime/retro-schema";

/** The statements today's runners ran, kept here as written so a changed bootstrap fails. */
const OLD_COMMANDS_BOOTSTRAP = [
  "CREATE TABLE IF NOT EXISTS command_receipt (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT",
  "CREATE TABLE IF NOT EXISTS pending_command (id TEXT PRIMARY KEY REFERENCES command_receipt(id), payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1,2))) STRICT",
  "CREATE TABLE IF NOT EXISTS pending_retro_command (id TEXT PRIMARY KEY REFERENCES command_receipt(id), payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1))) STRICT",
  "CREATE TABLE IF NOT EXISTS retro_attempt (retro_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL) STRICT",
];
const OLD_HEALTH_BOOTSTRAP =
  "CREATE TABLE IF NOT EXISTS health_execution(id TEXT PRIMARY KEY,command_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,phase TEXT NOT NULL) STRICT";
const OLD_RETRO_BOOTSTRAP = `CREATE TABLE IF NOT EXISTS retro_execution(id TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL,
     payload TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN
     ('preparing','running','reporting','releasing','complete')), result TEXT, started_at INTEGER) STRICT`;

const DAY = 24 * 60 * 60_000;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paws-runner-store-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function declared(table: SQLiteTable) {
  const config = getTableConfig(table);
  return {
    name: config.name,
    strict: true,
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType().toUpperCase(),
      notNull: column.notNull,
      primaryKey: column.primary,
      defaultValue: column.default === undefined ? null : String(column.default),
    })),
    unique: config.columns.filter((column) => column.isUnique).map((column) => column.name),
    foreignKeys: config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        from: reference.columns.map((column) => column.name),
        table: getTableName(reference.foreignTable),
        to: reference.foreignColumns.map((column) => column.name),
        onUpdate: (foreignKey.onUpdate ?? "no action").toUpperCase(),
        onDelete: (foreignKey.onDelete ?? "no action").toUpperCase(),
      };
    }),
  };
}

function bootstrapped(db: Database, name: string) {
  const strict = db
    .query<{ strict: number }, [string]>("SELECT strict FROM pragma_table_list WHERE name=?")
    .get(name);
  const columns = db
    .query<
      { name: string; type: string; notnull: number; dflt_value: string | null; pk: number },
      [string]
    >('SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info(?) ORDER BY cid')
    .all(name);
  const unique = db
    .query<{ column: string }, [string, string]>(
      "SELECT i.name AS column FROM pragma_index_list(?) l, pragma_index_info(l.name) i WHERE l.origin=?",
    )
    .all(name, "u");
  const foreignKeys = db
    .query<
      { table: string; from: string; to: string; on_update: string; on_delete: string },
      [string]
    >('SELECT "table","from","to",on_update,on_delete FROM pragma_foreign_key_list(?)')
    .all(name);
  return {
    name,
    strict: strict?.strict === 1,
    columns: columns.map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.notnull === 1,
      primaryKey: column.pk > 0,
      defaultValue: column.dflt_value,
    })),
    unique: unique.map((row) => row.column),
    foreignKeys: foreignKeys.map((row) => ({
      from: [row.from],
      table: row.table,
      to: [row.to],
      onUpdate: row.on_update,
      onDelete: row.on_delete,
    })),
  };
}

function expectSchemaMatches(db: Database, tables: readonly SQLiteTable[]) {
  const names = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(names).toEqual(tables.map((table) => getTableName(table)).sort());
  for (const table of tables)
    expect(bootstrapped(db, getTableName(table))).toEqual(declared(table));
}

const definitions = (db: Database) =>
  db
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.sql);

function openFixture(file: string, statements: readonly string[]) {
  const db = openDatabase(join(root, file));
  for (const statement of statements) db.run(statement);
  return db;
}

test("commands.db: the Drizzle schema matches the bootstrap", () => {
  const db = openDatabase(join(root, "commands.db"));
  createCommandStore(db);
  createCommandStore(db);
  expectSchemaMatches(db, Object.values(commandSchema));
  db.close();
});

test("health.db: the Drizzle schema matches the bootstrap, new and upgraded", () => {
  const created = openDatabase(join(root, "health.db"));
  createHealthStore(created);
  createHealthStore(created);
  expectSchemaMatches(created, [healthExecution]);
  created.close();

  const upgraded = openFixture("legacy-health.db", [OLD_HEALTH_BOOTSTRAP]);
  createHealthStore(upgraded);
  expectSchemaMatches(upgraded, [healthExecution]);
  upgraded.close();
});

test("retro.db: the Drizzle schema matches the bootstrap and its phases", () => {
  const db = openDatabase(join(root, "retro.db"));
  createRetroStore(db);
  createRetroStore(db);
  expectSchemaMatches(db, [retroExecution]);
  const allowed = /CHECK\(phase IN\s*\(([^)]*)\)\)/.exec(definitions(db)[0]!)![1]!;
  expect(allowed.split(",").map((phase) => phase.replaceAll("'", ""))).toEqual([
    ...retroExecution.phase.enumValues,
  ]);
  db.close();
});

test("a commands.db made by the old bootstrap opens, keeps its rows and prunes", () => {
  const now = 10 * DAY;
  const old = now - 2 * DAY;
  const fixture = openFixture("commands.db", OLD_COMMANDS_BOOTSTRAP);
  for (const [id, expiresAt] of [
    ["retired", old],
    ["delivered", old],
    ["waiting", old],
    ["bare", old],
    ["live", now + DAY],
  ] as const)
    fixture.run("INSERT INTO command_receipt VALUES (?,?)", [id, expiresAt]);
  fixture.run("INSERT INTO pending_command (id,payload,acknowledged) VALUES ('retired','{}',2)");
  fixture.run("INSERT INTO pending_command (id,payload) VALUES ('waiting','{}')");
  fixture.run("INSERT INTO pending_command (id,payload) VALUES ('live','{\"kept\":true}')");
  fixture.run(
    "INSERT INTO pending_retro_command (id,payload,delivered) VALUES ('delivered','{}',1)",
  );
  fixture.run("INSERT INTO retro_attempt VALUES ('retro',3)");
  const before = definitions(fixture);
  fixture.close();

  const daemon = openRunnerDaemon({
    root,
    controlPlaneUrl: "https://paws.invalid/",
    runnerApiUrl: "https://runner.paws.invalid/",
    now: () => now,
  });
  const db = openDatabase(join(root, "commands.db"));
  try {
    expect(definitions(db)).toEqual(before);
    expect(daemon.pruneRetired()).toBe(5);
    const q = drizzle(db);
    expect(q.select().from(commandSchema.commandReceipt).all()).toEqual([
      { id: "waiting", expiresAt: old },
      { id: "live", expiresAt: now + DAY },
    ]);
    expect(q.select().from(commandSchema.pendingCommand).all()).toEqual([
      { id: "waiting", payload: "{}", acknowledged: 0 },
      { id: "live", payload: '{"kept":true}', acknowledged: 0 },
    ]);
    expect(q.select().from(commandSchema.pendingRetroCommand).all()).toEqual([]);
    expect(q.select().from(commandSchema.retroAttempt).all()).toEqual([
      { retroId: "retro", attempt: 3 },
    ]);
  } finally {
    db.close();
    daemon.close();
  }
});

for (const [label, statements] of [
  ["before the result column", [OLD_HEALTH_BOOTSTRAP]],
  [
    "with the result column",
    [OLD_HEALTH_BOOTSTRAP, "ALTER TABLE health_execution ADD COLUMN result TEXT"],
  ],
] as const)
  test(`a health.db made by the old bootstrap ${label} opens and recovers`, async () => {
    const now = Date.now();
    const helper = {
      id: "helper-command",
      type: "helper",
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 60_000,
      sessionId: "session",
      sessionGeneration: 1,
      purpose: "classify",
      profile: { agent: "claude", model: null },
      prompt: "Classify this.",
    };
    const fixture = openFixture("health.db", statements);
    fixture.run(
      "INSERT INTO health_execution(id,command_id,payload,phase) VALUES('unfinished','helper-command',?,'running')",
      [JSON.stringify(helper)],
    );
    fixture.run(
      "INSERT INTO health_execution(id,command_id,payload,phase) VALUES('finished','done-command','{}','complete')",
    );
    fixture.close();

    const stopped: string[] = [];
    const runtime = await openRunnerHealthRuntime({
      root,
      daemon: { status: () => ({ phase: "paired" }) } as never,
      spool: {} as never,
      results: {} as never,
      broker: { stop: async (id: string) => void stopped.push(id) } as never,
      now: () => now,
    });
    await runtime.stop();

    const db = openDatabase(join(root, "health.db"));
    expectSchemaMatches(db, [healthExecution]);
    expect(stopped).toEqual(["unfinished"]);
    expect(
      drizzle(db)
        .select({ id: healthExecution.id, phase: healthExecution.phase })
        .from(healthExecution)
        .all(),
    ).toEqual([
      { id: "unfinished", phase: "interrupted" },
      { id: "finished", phase: "complete" },
    ]);
    db.close();
  });

test("a retro.db made by the old bootstrap opens and delivers what it held", async () => {
  const now = Date.now();
  const hash = "a".repeat(64);
  const input = { workspaceId: "workspace", retroId: "retro", sha256: hash, sizeBytes: 1 };
  const command = {
    id: "retro-command",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: now,
    expiresAt: now + 300_000,
    type: "retro",
    capability: 1,
    retroId: "retro",
    attempt: 2,
    settingsRevision: 7,
    profile: { agent: "codex", model: "gpt-6-astra", effort: "high" },
    executionLimit: { activeMinutes: 15 },
    output: { maxItems: 5, workedWell: 3, maxChars: 4_000 },
    digest: { kind: "digest", ...input },
    prompt: { kind: "prompt", ...input },
  };
  const fixture = openFixture("retro.db", [OLD_RETRO_BOOTSTRAP]);
  fixture.run(
    "INSERT INTO retro_execution(id,command_id,payload,phase) VALUES('held','retro-command',?,'releasing')",
    [JSON.stringify(command)],
  );
  const before = definitions(fixture);
  fixture.close();

  const released: string[] = [];
  const runtime = await openRunnerRetroRuntime({
    root,
    daemon: {
      status: () => ({ phase: "paired" }),
      releaseRetroCommand: async (id: string) => void released.push(id),
      pollRetroCommands: async () => ({ commands: [], rejected: [] }),
    } as never,
    spool: {} as never,
    results: {} as never,
    broker: { stop: async () => undefined } as never,
    now: () => now,
    onError: (error) => {
      throw error;
    },
  });
  expect(runtime.status().active).toEqual([
    { executionId: "held", commandId: "retro-command", phase: "releasing" },
  ]);
  await runtime.tick();
  expect(released).toEqual(["retro-command"]);
  expect(runtime.status().active).toEqual([]);
  await runtime.stop();

  const db = openDatabase(join(root, "retro.db"));
  expect(definitions(db)).toEqual(before);
  db.close();
});
