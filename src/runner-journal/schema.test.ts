import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableName } from "drizzle-orm";
import { SQLiteSyncDialect, getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { openExecutionJournal } from ".";
import type { RunnerCommand } from "../runner-protocol";
import { ddl } from "./ddl";
import * as schema from "./schema";

const tables: SQLiteTable[] = Object.values(schema);
const dialect = new SQLiteSyncDialect();

// The bootstrap as the released runner ran it, frozen here: `ddl` must keep opening these files.
const RELEASED_TABLES = [
  "CREATE TABLE IF NOT EXISTS execution (id TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, phase TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, prefix_hash TEXT NOT NULL DEFAULT '', answer_cursor INTEGER NOT NULL DEFAULT 0) STRICT",
  "CREATE TABLE IF NOT EXISTS delivery (execution_id TEXT NOT NULL REFERENCES execution(id), sequence INTEGER NOT NULL, payload TEXT NOT NULL, request_id TEXT, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(execution_id,sequence)) STRICT",
  "CREATE TABLE IF NOT EXISTS result_delivery (execution_id TEXT PRIMARY KEY REFERENCES execution(id), payload TEXT NOT NULL, failure INTEGER NOT NULL, accepted INTEGER NOT NULL DEFAULT 0) STRICT",
  "CREATE TABLE IF NOT EXISTS publication (execution_id TEXT PRIMARY KEY REFERENCES execution(id), payload TEXT NOT NULL, lease TEXT, published_sha TEXT, refused TEXT) STRICT",
];
const RELEASED_UPGRADES = [
  "ALTER TABLE execution ADD COLUMN transcript_offset INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE execution ADD COLUMN session_offset INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE execution ADD COLUMN session_state TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE execution ADD COLUMN transcript_sealed INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE result_delivery ADD COLUMN refused TEXT",
  "CREATE INDEX IF NOT EXISTS delivery_waiting ON delivery(execution_id,sequence) WHERE json_extract(payload,'$.type') IN ('question','artifact','closeout_policy')",
  `CREATE TABLE IF NOT EXISTS termination (
    command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL,
    reported INTEGER NOT NULL DEFAULT 0) STRICT`,
  "CREATE INDEX IF NOT EXISTS termination_generation ON termination(run_id,generation)",
  `CREATE TABLE IF NOT EXISTS cleanup (
    execution_id TEXT PRIMARY KEY REFERENCES execution(id), started_at INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0, failure TEXT, failed_at INTEGER) STRICT`,
];

type TableInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

function declared(table: SQLiteTable) {
  const config = getTableConfig(table);
  const composite = config.primaryKeys[0]?.columns.map((column) => column.name) ?? [];
  const literal = (value: unknown) =>
    value === undefined ? null : typeof value === "string" ? `'${value}'` : String(value);
  return {
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType().toUpperCase(),
      notNull: column.notNull,
      default: literal(column.default),
      primaryKey: column.primary ? 1 : composite.indexOf(column.name) + 1,
    })),
    unique: config.columns.filter((column) => column.isUnique).map((column) => [column.name]),
    indexes: config.indexes
      .map(({ config: index }) => ({
        name: index.name,
        columns: index.columns.map((column) => (column as { name: string }).name),
        unique: index.unique,
        where: index.where ? dialect.sqlToQuery(index.where).sql : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: config.foreignKeys.map((key) => {
      const { columns, foreignColumns, foreignTable } = key.reference();
      return {
        table: getTableName(foreignTable),
        from: columns[0]!.name,
        to: foreignColumns[0]!.name,
      };
    }),
    strict: true,
  };
}

function actual(db: Database, table: string) {
  const info = db.query<TableInfo, []>(`PRAGMA table_info(${table})`).all();
  const indexes = db
    .query<{ name: string; unique: number; origin: string }, []>(`PRAGMA index_list(${table})`)
    .all();
  const columnsOf = (index: string) =>
    db
      .query<{ name: string }, []>(`PRAGMA index_info(${index})`)
      .all()
      .map((column) => column.name);
  const whereOf = (index: string) => {
    const row = db
      .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name=?")
      .get(index);
    return row?.sql.split(" WHERE ")[1] ?? null;
  };
  return {
    columns: info.map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.notnull === 1 || column.pk > 0,
      default: column.dflt_value,
      primaryKey: column.pk,
    })),
    unique: indexes.filter((index) => index.origin === "u").map((index) => columnsOf(index.name)),
    indexes: indexes
      .filter((index) => index.origin === "c")
      .map((index) => ({
        name: index.name,
        columns: columnsOf(index.name),
        unique: index.unique === 1,
        where: whereOf(index.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: db
      .query<{ table: string; from: string; to: string }, []>(`PRAGMA foreign_key_list(${table})`)
      .all()
      .map(({ table: target, from, to }) => ({ table: target, from, to })),
    strict:
      db
        .query<{ strict: number }, [string]>("SELECT strict FROM pragma_table_list WHERE name=?")
        .get(table)?.strict === 1,
  };
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-journal-schema-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function command(id: string): RunnerCommand & { type: "task" } {
  return {
    id,
    type: "task",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: `run-${id}`,
    itemId: `item-${id}`,
    generation: 1,
    sessionId: "session",
    sessionGeneration: 1,
    taskModeGeneration: 1,
    purpose: "answer",
    issuedAt: 1000,
    expiresAt: 2000,
    profile: { agent: "claude", model: null },
    prompt: "prompt",
  };
}

test("the schema names every table the bootstrap creates", () => {
  const db = new Database(":memory:");
  ddl(db);
  const created = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  expect(tables.map((table) => getTableName(table)).sort()).toEqual(created);
  db.close();
});

for (const table of tables)
  test(`the ${getTableName(table)} schema matches its bootstrap`, () => {
    const db = new Database(":memory:");
    ddl(db);
    expect(declared(table)).toEqual(actual(db, getTableName(table)));
    db.close();
  });

describe.each([
  { name: "today's runner", statements: [...RELEASED_TABLES, ...RELEASED_UPGRADES] },
  { name: "a runner from before the upgrades", statements: RELEASED_TABLES },
])("a journal created by $name", ({ statements }) => {
  function seeded(root: string) {
    const db = new Database(join(root, "executions.db"));
    for (const statement of statements) db.run(statement);
    db.run("INSERT INTO execution(id,command_id,payload,phase) VALUES (?,?,?,'running')", [
      "existing",
      "existing-command",
      JSON.stringify(command("existing-command")),
    ]);
    db.run(
      "INSERT INTO delivery(execution_id,sequence,payload,request_id) VALUES ('existing',1,?,NULL)",
      [JSON.stringify({ type: "plan", steps: [{ content: "step", status: "pending" }] })],
    );
    db.close();
  }

  test("keeps its rows, and every table matches the schema after opening", () => {
    const root = privateRoot();
    seeded(root);
    const journal = openExecutionJournal(root);
    expect(journal.executions(true).map((execution) => execution.id)).toEqual(["existing"]);
    expect(journal.pending("existing").map((entry) => entry.sequence)).toEqual([1]);
    journal.close();
    const db = new Database(join(root, "executions.db"));
    for (const table of tables) expect(declared(table)).toEqual(actual(db, getTableName(table)));
    db.close();
  });

  test("accepts new work through the new queries", () => {
    const root = privateRoot();
    seeded(root);
    const journal = openExecutionJournal(root);
    journal.sent("existing", 1);
    expect(journal.pending("existing")).toEqual([]);
    expect(journal.transcriptCursor("existing")).toEqual({ offset: 0, consumed: 0 });
    expect(journal.sessionCursor("existing")).toEqual({ offset: 0, state: "" });
    expect(journal.phase("existing", "complete")).toBe(true);
    expect(journal.executions(true)).toEqual([]);
    expect(journal.executions(false).map((execution) => execution.id)).toEqual(["existing"]);
    const admitted = journal.admit(command("new-command"), 1000)!;
    expect(journal.execution(admitted.id)?.phase).toBe("preparing");
    journal.confirmTermination({
      id: "existing-command",
      runId: "run-existing-command",
      generation: 1,
    });
    expect(journal.unconfirmedTerminations()).toEqual([]);
    journal.close();
  });
});

test("a termination for a row with no run id is skipped, as INSERT OR IGNORE always did", () => {
  const root = privateRoot();
  const journal = openExecutionJournal(root);
  expect(() =>
    journal.confirmTermination({
      id: "legacy-command",
      runId: null as unknown as string,
      generation: 1,
    }),
  ).not.toThrow();
  expect(journal.pendingTerminations()).toEqual([]);
  journal.close();
});

test("a crash between Paws's decision and the phase change is recovered on open", () => {
  const root = privateRoot();
  let journal = openExecutionJournal(root);
  const admitted = journal.admit(command("recovered"), 1000)!;
  journal.close();
  const db = new Database(join(root, "executions.db"));
  db.run("INSERT INTO result_delivery(execution_id,payload,failure,accepted) VALUES (?,'{}',0,1)", [
    admitted.id,
  ]);
  db.close();
  journal = openExecutionJournal(root);
  expect(journal.execution(admitted.id)?.phase).toBe("complete");
  journal.close();
});
