import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteSyncDialect, getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { ddl } from "./ddl";
import { openExecutionJournal, type WorkCommand } from "./index";
import {
  cleanupTable,
  deliveryTable,
  executionTable,
  publicationTable,
  resultDeliveryTable,
  terminationTable,
} from "./schema";

const TABLES: SQLiteTable[] = [
  executionTable,
  deliveryTable,
  resultDeliveryTable,
  publicationTable,
  terminationTable,
  cleanupTable,
];

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};
type ForeignKey = { table: string; from: string; to: string; on_delete: string; on_update: string };
type IndexInfo = { name: string; unique: number; origin: string; partial: number };

function sqlDefault(value: unknown): string | null {
  if (value === undefined) return null;
  return typeof value === "string" ? `'${value}'` : String(value);
}

function indexColumns(db: Database, name: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA index_info(${name})`)
    .all()
    .map((column) => column.name);
}

function schemaShape(table: SQLiteTable) {
  const config = getTableConfig(table);
  const composite = config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name));
  return {
    name: config.name,
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType().toUpperCase(),
      notNull: column.notNull,
      default: sqlDefault(column.default),
      pk: column.primary ? 1 : composite.indexOf(column.name) + 1,
    })),
    foreignKeys: config.foreignKeys.flatMap((key) => {
      const reference = key.reference();
      return reference.columns.map((column, position) => ({
        table: getTableConfig(reference.foreignTable).name,
        from: column.name,
        to: reference.foreignColumns[position]!.name,
        onDelete: (key.onDelete ?? "no action").toUpperCase(),
        onUpdate: (key.onUpdate ?? "no action").toUpperCase(),
      }));
    }),
    unique: config.columns
      .filter((column) => column.isUnique)
      .map((column) => [column.name])
      .concat(config.uniqueConstraints.map((constraint) => constraint.columns.map((c) => c.name))),
    indexes: config.indexes
      .map(({ config: index }) => ({
        name: index.name,
        unique: index.unique,
        columns: index.columns.map((column) => (column as { name: string }).name),
        where:
          index.where === undefined ? null : new SQLiteSyncDialect().sqlToQuery(index.where).sql,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function databaseShape(db: Database, name: string) {
  const indexes = db.query<IndexInfo, []>(`PRAGMA index_list(${name})`).all();
  return {
    name,
    columns: db
      .query<ColumnInfo, []>(`PRAGMA table_info(${name})`)
      .all()
      .map((column) => ({
        name: column.name,
        type: column.type,
        notNull: column.notnull === 1 || column.pk > 0,
        default: column.dflt_value,
        pk: column.pk,
      })),
    foreignKeys: db
      .query<ForeignKey, []>(`PRAGMA foreign_key_list(${name})`)
      .all()
      .map((key) => ({
        table: key.table,
        from: key.from,
        to: key.to,
        onDelete: key.on_delete,
        onUpdate: key.on_update,
      })),
    unique: indexes
      .filter((index) => index.origin === "u")
      .map((index) => indexColumns(db, index.name)),
    indexes: indexes
      .filter((index) => index.origin === "c")
      .map((index) => ({
        name: index.name,
        unique: index.unique === 1,
        columns: indexColumns(db, index.name),
        where:
          index.partial === 1
            ? db
                .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name=?")
                .get(index.name)!
                .sql.split(" WHERE ")[1]!
            : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bootstrapped(): Database {
  const db = new Database(":memory:");
  ddl(db);
  return db;
}

test("the Drizzle schema matches every table the bootstrap creates", () => {
  const db = bootstrapped();
  try {
    const created = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_list WHERE schema='main'")
      .all()
      .map((table) => table.name)
      .filter((name) => !name.startsWith("sqlite_"))
      .sort();
    expect(created).toEqual(TABLES.map((table) => getTableConfig(table).name).sort());
    for (const table of TABLES)
      expect(schemaShape(table)).toEqual(databaseShape(db, getTableConfig(table).name));
  } finally {
    db.close();
  }
});

test("every bootstrapped table is STRICT and bootstrapping again changes nothing", () => {
  const db = bootstrapped();
  try {
    const strict = db
      .query<{ name: string; strict: number }, []>(
        "SELECT name, strict FROM pragma_table_list WHERE schema='main' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    expect(strict.length).toBe(TABLES.length);
    for (const table of strict) expect(table).toEqual({ name: table.name, strict: 1 });
    const before = db.query("SELECT sql FROM sqlite_master ORDER BY name").all();
    ddl(db);
    expect(db.query("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  } finally {
    db.close();
  }
});

const ORIGINAL_TABLES = [
  "CREATE TABLE IF NOT EXISTS execution (id TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, phase TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, prefix_hash TEXT NOT NULL DEFAULT '', answer_cursor INTEGER NOT NULL DEFAULT 0) STRICT",
  "CREATE TABLE IF NOT EXISTS delivery (execution_id TEXT NOT NULL REFERENCES execution(id), sequence INTEGER NOT NULL, payload TEXT NOT NULL, request_id TEXT, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(execution_id,sequence)) STRICT",
  "CREATE TABLE IF NOT EXISTS result_delivery (execution_id TEXT PRIMARY KEY REFERENCES execution(id), payload TEXT NOT NULL, failure INTEGER NOT NULL, accepted INTEGER NOT NULL DEFAULT 0) STRICT",
  "CREATE TABLE IF NOT EXISTS publication (execution_id TEXT PRIMARY KEY REFERENCES execution(id), payload TEXT NOT NULL, lease TEXT, published_sha TEXT, refused TEXT) STRICT",
];
const LATER_CHANGES = [
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

function workCommand(id: string): WorkCommand {
  return {
    id,
    type: "run",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1000,
    expiresAt: 61000,
    runId: `run-${id}`,
    itemId: `item-${id}`,
    generation: 1,
    repository: {
      owner: "owner",
      repo: "repo",
      remoteUrl: "https://github.com/owner/repo.git",
      baseSha: "a".repeat(40),
    },
    profile: { agent: "codex", model: null },
    prompt: "Implement delegated work",
  };
}

function outcome(name: string) {
  return {
    executionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commandId: `command-${name}`,
    role: "implementer" as const,
    stopReason: "end_turn" as const,
    timedOut: false,
    cancelled: false,
    authRequired: false,
    agentExited: true,
    candidateSha: "b".repeat(40),
    tokens: 7,
  };
}

const QUESTION = { type: "question", text: "Which API?", options: ["Existing"] };
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function journalFile(statements: string[]) {
  const root = mkdtempSync(join(tmpdir(), "paws-journal-upgrade-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const path = join(root, "executions.db");
  const db = new Database(path);
  for (const statement of statements) db.run(statement);
  const insert = db.prepare("INSERT INTO execution(id,command_id,payload,phase) VALUES (?,?,?,?)");
  for (const [id, phase] of [
    ["active", "running"],
    ["accepted", "publishing"],
    ["rejected", "running"],
    ["pending", "running"],
  ] as const)
    insert.run(id, `command-${id}`, JSON.stringify(workCommand(`command-${id}`)), phase);
  db.run("INSERT INTO delivery(execution_id,sequence,payload,request_id) VALUES (?,?,?,?)", [
    "active",
    1,
    JSON.stringify(QUESTION),
    REQUEST_ID,
  ]);
  const result = db.prepare(
    "INSERT INTO result_delivery(execution_id,payload,failure,accepted) VALUES (?,?,?,?)",
  );
  result.run("accepted", JSON.stringify(outcome("accepted")), 0, 1);
  result.run("rejected", JSON.stringify(outcome("rejected")), 0, 2);
  result.run("pending", JSON.stringify(outcome("pending")), 1, 0);
  db.run("INSERT INTO publication(execution_id,payload,lease) VALUES (?,?,?)", [
    "active",
    JSON.stringify(outcome("active")),
    "c".repeat(40),
  ]);
  db.close();
  chmodSync(path, 0o600);
  return { root, path };
}

function expectJournalWorks(root: string) {
  const journal = openExecutionJournal(root);
  try {
    expect(journal.execution("accepted")?.phase).toBe("complete");
    expect(journal.execution("rejected")?.phase).toBe("interrupted");
    expect(journal.executions(true).map((row) => row.id)).toEqual(["active", "pending"]);
    expect(journal.executions(false).map((row) => row.id)).toEqual(["accepted", "rejected"]);
    expect(journal.pending("active")).toEqual([{ sequence: 1, event: QUESTION as never }]);
    expect(journal.requestId("active", 1)).toBe(REQUEST_ID);
    expect(journal.pendingResults()).toEqual([
      { id: "pending", runId: "run-command-pending", generation: 1 },
    ]);
    expect(journal.pendingResult("pending")).toEqual({
      result: outcome("pending"),
      failure: true,
    });
    expect(journal.pendingResult("active")).toBeNull();
    expect(journal.publication("active")).toEqual({
      result: outcome("active"),
      lease: "c".repeat(40),
    });
    expect(journal.publication("pending")).toBeNull();

    journal.ingest(
      "active",
      Buffer.from(
        `${JSON.stringify({ type: "question", requestId: "22222222-2222-4222-8222-222222222222", question: "Next?", options: [] })}\n`,
      ),
    );
    expect(journal.pending("active").map((row) => row.sequence)).toEqual([1, 2]);
    journal.sent("active", 1);
    expect(journal.waiting("active")).toBe(true);
    journal.answered("active", 1);
    expect(journal.answerCursor("active")).toBe(1);
    expect(journal.transcriptCursor("active").offset).toBe(0);
    expect(journal.sessionCursor("active")).toEqual({ offset: 0, state: "" });
    journal.cleanupStarted("active", 5000);
    expect(journal.cleanupFailed("active", "busy", 6000)).toBe(1);
    expect(journal.cleanupFailed("active", "still busy", 7000)).toBe(2);
    expect(journal.cleanups()).toEqual([
      {
        executionId: "active",
        phase: "running",
        since: 5000,
        failures: 2,
        failure: "still busy",
        failedAt: 7000,
        runId: "run-command-active",
        generation: 1,
        commandId: "command-active",
      },
    ]);
    expect(journal.cleanupDone("active")).toBe(2);
    journal.confirmTermination({
      id: "command-active",
      runId: "run-command-active",
      generation: 1,
    });
    expect(journal.terminationPending("run-command-active", 1)).toBe(false);
  } finally {
    journal.close();
  }
}

test("an executions.db left by today's runner opens and keeps its tables and rows", () => {
  const { root, path } = journalFile([...ORIGINAL_TABLES, ...LATER_CHANGES]);
  const before = new Database(path);
  const schema = before.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  before.close();

  expectJournalWorks(root);

  const after = new Database(path);
  try {
    expect(after.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()).toEqual(
      schema,
    );
  } finally {
    after.close();
  }
});

test("an executions.db from an older runner upgrades in place and matches the schema", () => {
  const { root, path } = journalFile(ORIGINAL_TABLES);

  expectJournalWorks(root);

  const db = new Database(path);
  try {
    for (const table of TABLES)
      expect(schemaShape(table)).toEqual(databaseShape(db, getTableConfig(table).name));
  } finally {
    db.close();
  }
});
