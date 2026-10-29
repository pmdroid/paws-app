import { Database, type Statement } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLiveStatusProvider } from "../src/web";

type Timing = { sql: string; calls: number; ms: number };

const dbPath = process.argv[2];
const rounds = Number(process.argv[3] ?? 20);
const out = process.argv[4];
if (!dbPath) {
  console.error("usage: bun scripts/bench.ts <copy-of-paws.db> [rounds] [out.json]");
  process.exit(2);
}

const timings = new Map<string, Timing>();
let tracing = false;
function record(sql: string, ms: number) {
  const key = sql.replace(/\s+/g, " ").trim();
  const row = timings.get(key) ?? { sql: key, calls: 0, ms: 0 };
  row.calls += 1;
  row.ms += ms;
  timings.set(key, row);
}

const wrapped = new WeakSet<Statement>();

function traced(statement: Statement, sql: string): Statement {
  if (wrapped.has(statement)) return statement;
  wrapped.add(statement);
  for (const method of ["all", "get", "values", "run", "iterate"] as const) {
    const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
    (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      if (!tracing) return original(...args);
      const started = performance.now();
      try {
        return original(...args);
      } finally {
        record(sql, performance.now() - started);
      }
    };
  }
  return statement;
}

for (const factory of ["query", "prepare"] as const) {
  const original = Database.prototype[factory] as (sql: string) => Statement;
  Database.prototype[factory] = function (this: Database, sql: string) {
    return traced(original.call(this, sql), sql);
  } as never;
}

const db = new Database(dbPath, { readonly: true });
const provider = createLiveStatusProvider(db, {
  pawsHome: process.env.PAWS_HOME ?? join(homedir(), ".paws"),
});

function measure<T>(label: string, run: () => T, n = rounds) {
  run();
  const samples: number[] = [];
  let bytes = 0;
  let gzip = 0;
  for (let i = 0; i < n; i += 1) {
    const started = performance.now();
    const value = run();
    samples.push(performance.now() - started);
    const body = JSON.stringify(value);
    bytes = Buffer.byteLength(body);
    gzip = Bun.gzipSync(body).byteLength;
  }
  samples.sort((a, b) => a - b);
  const pick = (q: number) =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
  return { label, n, p50: pick(0.5), p95: pick(0.95), max: samples.at(-1)!, bytes, gzip };
}

const recentItems = provider
  .snapshot()
  .items.slice(0, 5)
  .map((item) => item.id);

const results = [measure("GET /api/status snapshot()", () => provider.snapshot())];
for (const id of recentItems)
  results.push(measure(`GET /api/status/items/${id} item()`, () => provider.item(id)));

tracing = true;
provider.snapshot();
for (const id of recentItems) provider.item(id);
tracing = false;

function dirBytes(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, entry) =>
      sum +
      (entry.isDirectory()
        ? dirBytes(join(dir, entry.name))
        : statSync(join(dir, entry.name)).size),
    0,
  );
}

const assets = join(import.meta.dir, "../src/web/dist/assets");
const bundle = readdirSync(assets).map((name) => ({
  name,
  bytes: statSync(join(assets, name)).size,
  gzip: Bun.gzipSync(readFileSync(join(assets, name))).byteLength,
}));

const tables = db
  .query<{ name: string; bytes: number; rows: number }, []>(
    "SELECT name, SUM(pgsize) AS bytes, 0 AS rows FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 15",
  )
  .all();

const report = JSON.stringify(
  {
    at: new Date().toISOString(),
    db: { path: dbPath, bytes: statSync(dbPath).size, largest: tables },
    endpoints: results.map((r) => ({
      ...r,
      p50: +r.p50.toFixed(2),
      p95: +r.p95.toFixed(2),
      max: +r.max.toFixed(2),
    })),
    slowestQueries: [...timings.values()]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 25)
      .map((t) => ({ ms: +t.ms.toFixed(2), calls: t.calls, sql: t.sql.slice(0, 400) })),
    queriesPerSnapshotAndFiveItems: [...timings.values()].reduce((s, t) => s + t.calls, 0),
    sqlMsPerSnapshotAndFiveItems: +[...timings.values()].reduce((s, t) => s + t.ms, 0).toFixed(2),
    bundle,
    bundleBytes: dirBytes(assets),
  },
  null,
  2,
);
if (out) await Bun.write(out, report);
else console.log(report);
