import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closingParen,
  createTableParts,
  migrate,
  openDatabase,
  splitTopLevel,
  unquoteName,
} from "../src/db";

const ROOT = new URL("..", import.meta.url).pathname;
const SCHEMA_DIR = join(ROOT, "src/db/schema");

const AREAS: [area: string, match: RegExp][] = [
  [
    "jobs",
    /^(job|job_activation|scheduler_admission|sync_cursor|paws_alive|wake|schema_migration)$/,
  ],
  ["outbox", /^(outbox|outbox_session_fence|inbox_event)$/],
  ["linear", /^linear_/],
  ["retros", /^retro/],
  ["improvements", /^improvement/],
  ["accounts", /^(agent_account|runner_account_capability|runner_command_account)/],
  ["workspace", /^(workspace|verified_github_attribution|github_attribution_request)/],
  ["agents", /^(agent_|npm_package|browser_installation_request)/],
  ["runners", /^(runner|member_vm|run_agent_setup|policy_runner_warning)/],
  [
    "closeout",
    /^(closeout_|evidence|visual_review|review_|risk_|finding_|open_findings|suggest|ci_|candidate_|run_review_rounds)/,
  ],
  [
    "github",
    /^(github_|pull_|merge_|rebase_return|remote_merge_fact|repository_catalog|push_outage|checkpoint_ref_cleanup)/,
  ],
  ["asks", /^(question|decision_|link_ask|plan_proposal)/],
  ["items", /./],
];

const BUILDERS = [
  "AnySQLiteColumn",
  "blob",
  "check",
  "foreignKey",
  "index",
  "integer",
  "numeric",
  "primaryKey",
  "real",
  "sqliteTable",
  "text",
  "unique",
  "uniqueIndex",
];

const area = (table: string) => AREAS.find(([, match]) => match.test(table))![0];

const template = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.includes("`") || flat.includes("${")) throw new Error(`Cannot quote ${flat}`);
  return `sql\`${flat}\``;
};

type Block = { name: string; variable: string; text: string; columns: Map<string, string> };

function pull(path: string): string {
  const out = mkdtempSync(join(tmpdir(), "paws-schema-pull-"));
  const run = Bun.spawnSync(
    [
      "bun",
      "x",
      "--bun",
      "drizzle-kit",
      "pull",
      "--dialect=sqlite",
      `--url=file:${path}`,
      `--out=${out}`,
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (run.exitCode !== 0) throw new Error("drizzle-kit pull failed");
  const schema = readFileSync(join(out, "schema.ts"), "utf8");
  rmSync(out, { recursive: true, force: true });
  return schema.replace(/\n\tcheck\("[^"]*", sql`[^`]*`\),?/g, "");
}

function blocks(source: string): Block[] {
  const found: Block[] = [];
  const start = /^export const (\w+) = sqliteTable\("([^"]+)", \{$/gm;
  for (let match = start.exec(source); match; match = start.exec(source)) {
    const end = source.indexOf("\n]);", match.index) + 4;
    const text = source.slice(match.index, end);
    const columns = new Map<string, string>();
    for (const line of text.slice(0, text.indexOf("\n},")).split("\n").slice(1)) {
      const column = /^\t(\w+): \w+\((?:"([^"]+)")?/.exec(line);
      if (column) columns.set(column[2] ?? column[1]!, column[1]!);
    }
    found.push({ name: match[2]!, variable: match[1]!, text, columns });
  }
  return found;
}

function extras(db: Database, block: Block): string[] {
  const column = (name: string) => {
    const property = block.columns.get(unquoteName(name));
    return property === undefined ? template(name) : `table.${property}`;
  };
  const entries: string[] = [];
  const indexes = db
    .query<{ name: string; unique: number; origin: string }, [string]>(
      'SELECT name, "unique", origin FROM pragma_index_list(?) ORDER BY name',
    )
    .all(block.name);
  for (const index of indexes.filter((entry) => entry.origin === "u")) {
    const names = db
      .query<{ name: string }, [string]>("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
      .all(index.name);
    entries.push(`unique().on(${names.map((n) => column(n.name)).join(", ")})`);
  }
  for (const index of indexes.filter((entry) => entry.origin === "c")) {
    const sql = db
      .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(index.name)!.sql;
    const open = sql.indexOf("(");
    const close = closingParen(sql, open);
    const where = /^\s*WHERE\s+([\s\S]*)$/i.exec(sql.slice(close + 1))?.[1];
    const on = splitTopLevel(sql.slice(open + 1, close)).map(column);
    entries.push(
      `${index.unique ? "uniqueIndex" : "index"}("${index.name}").on(${on.join(", ")})${
        where === undefined ? "" : `.where(${template(where)})`
      }`,
    );
  }
  const table = db
    .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(block.name)!.sql;
  createTableParts(table).checks.forEach((check, n) =>
    entries.push(`check("${block.name}_check_${n + 1}", ${template(check)})`),
  );
  return entries;
}

function defaultValue(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  if (/^'.*'$/s.test(value)) return JSON.stringify(value.slice(1, -1).replaceAll("''", "'"));
  return template(value);
}

function fixed(db: Database, block: Block): string {
  const columns = db
    .query<{ name: string; dflt_value: string | null; pk: number }, [string]>(
      "SELECT name, dflt_value, pk FROM pragma_table_info(?)",
    )
    .all(block.name);
  const defaults = new Map(columns.map((column) => [column.name, column.dflt_value]));
  const head = block.text
    .slice(0, block.text.indexOf("\n(table) => [") + 14)
    .replace(/^(\t(\w+): \w+\((?:"([^"]+)")?\))(.*)$/gm, (line, call, property, name, rest) => {
      const value = defaults.get(name ?? property);
      if (value === null || value === undefined || rest.includes(".default(")) return line;
      return `${call}.default(${defaultValue(value)})${rest}`;
    });
  const primary = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
  const kept = block.text
    .slice(block.text.indexOf("\n(table) => [") + 14, -4)
    .split(/\n(?=\t\S)/)
    .map((entry) => entry.trim().replace(/,$/, ""))
    .filter((entry) => entry !== "" && !/^((unique)?[iI]ndex|primaryKey)\(/.test(entry));
  if (primary.length > 1)
    kept.push(
      `primaryKey({ columns: [${primary
        .map((column) => `table.${block.columns.get(column.name)}`)
        .join(
          ", ",
        )}], name: "${block.name}_${primary.map((column) => column.name).join("_")}_pk" })`,
    );
  const entries = [...kept, ...extras(db, block)];
  if (entries.length === 0) return `${head.slice(0, head.lastIndexOf("},") + 2)}\n);`;
  const body = entries.map((e) => `\t${e},\n`).join("");
  const callback = body.includes("table.") ? head : head.replace(/\(table\) => \[\n$/, "() => [\n");
  return `${callback}${body}]);`;
}

function rawSchema(db: Database, tables: Set<string>): string {
  const list = db
    .query<{ name: string; type: string; strict: number; wr: number }, []>(
      "SELECT name, type, strict, wr FROM pragma_table_list WHERE schema = 'main' ORDER BY name",
    )
    .all();
  const collations: Record<string, Record<string, string>> = {};
  for (const name of tables) {
    const sql = db
      .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(name)!.sql;
    const found = createTableParts(sql).collations;
    if (Object.keys(found).length > 0) collations[name] = found;
  }
  const master = (type: string, names?: string[]) =>
    Object.fromEntries(
      db
        .query<{ name: string; sql: string }, [string]>(
          "SELECT name, sql FROM sqlite_master WHERE type = ? ORDER BY name",
        )
        .all(type)
        .filter((row) => names === undefined || names.includes(row.name))
        .map((row) => [row.name, row.sql]),
    );
  const raw = {
    strictTables: list.filter((t) => tables.has(t.name) && t.strict).map((t) => t.name),
    withoutRowidTables: list.filter((t) => tables.has(t.name) && t.wr).map((t) => t.name),
    collations,
    virtualTables: master(
      "table",
      list.filter((t) => t.type === "virtual").map((t) => t.name),
    ),
    triggers: master("trigger"),
  };
  return `export const rawSchema = ${JSON.stringify(raw, null, 2)} as const;\n`;
}

const home = mkdtempSync(join(tmpdir(), "paws-schema-"));
const path = join(home, "paws.db");
const db = openDatabase(path);
migrate(db);
db.run("PRAGMA wal_checkpoint(TRUNCATE)");

const skipped = new Set(
  db
    .query<{ name: string }, []>(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND (type != 'table' OR name LIKE 'sqlite_%')",
    )
    .all()
    .map((row) => row.name),
);
const pulled = blocks(pull(path)).filter((block) => !skipped.has(block.name));
const owner = new Map(pulled.map((block) => [block.variable, area(block.name)]));

rmSync(SCHEMA_DIR, { recursive: true, force: true });
mkdirSync(SCHEMA_DIR, { recursive: true });
const areas = [...new Set(pulled.map((block) => area(block.name)))].sort();
for (const name of areas) {
  const body = pulled
    .filter((block) => area(block.name) === name)
    .map((block) => fixed(db, block))
    .join("\n\n");
  const builders = BUILDERS.filter((builder) => new RegExp(`(?<![.\\w])${builder}\\b`).test(body));
  const references = new Map<string, string[]>();
  for (const [, variable] of body.matchAll(/(?:=> |foreignColumns: \[)(\w+)\./g)) {
    const from = owner.get(variable!);
    if (from === undefined || from === name) continue;
    references.set(from, [...new Set([...(references.get(from) ?? []), variable!])].sort());
  }
  const imports = [
    `import { ${builders.join(", ")} } from "drizzle-orm/sqlite-core";`,
    ...(body.includes("sql`") ? [`import { sql } from "drizzle-orm";`] : []),
    ...[...references]
      .sort()
      .map(([from, names]) => `import { ${names.join(", ")} } from "./${from}";`),
  ];
  writeFileSync(join(SCHEMA_DIR, `${name}.ts`), `${imports.join("\n")}\n\n${body}\n`);
}
writeFileSync(
  join(SCHEMA_DIR, "index.ts"),
  areas.map((name) => `export * from "./${name}";`).join("\n") + "\n",
);
writeFileSync(join(SCHEMA_DIR, "raw.ts"), rawSchema(db, new Set(pulled.map((b) => b.name))));
db.close();
rmSync(home, { recursive: true, force: true });
Bun.spawnSync(["bun", "x", "oxfmt", SCHEMA_DIR], { cwd: ROOT, stdout: "inherit" });
console.log(`Wrote ${pulled.length} tables in ${areas.length} files to src/db/schema`);
