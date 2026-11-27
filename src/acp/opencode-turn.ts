import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const MIGRATE_MS = 120_000;
const CURRENT = `SELECT id, value, time_created FROM credential WHERE integration_id = 'opencode'
  ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`;

export function readOpenCodeCredential(file: string): string {
  const value = readFileSync(file, "utf8");
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("OpenCode credential is not an object");
  return value;
}

export function writeOpenCodeCredential(database: string, value: string): void {
  const db = new Database(database, { readwrite: true });
  db.run("PRAGMA busy_timeout = 5000");
  try {
    db.transaction(() => {
      const kept = db.query<{ id: string; time_created: number }, []>(CURRENT).get();
      const now = Date.now();
      db.run("DELETE FROM credential WHERE integration_id = 'opencode'");
      db.run(
        `INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
         VALUES (?, 'opencode', 'OAuth', ?, 1, ?, ?)`,
        [
          kept?.id ?? `cred_${randomUUID().replaceAll("-", "")}`,
          value,
          kept?.time_created ?? now,
          now,
        ],
      );
    })();
  } finally {
    db.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [credential, database, cwd, command, ...args] = argv;
  if (!credential || !database || !cwd || !command) return 2;
  if (existsSync(credential)) {
    const value = readOpenCodeCredential(credential);
    await Bun.spawn([command, "auth", "list", "--standalone"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: MIGRATE_MS,
    }).exited;
    if (!existsSync(database)) throw new Error("OpenCode did not create its turn database");
    writeOpenCodeCredential(database, value);
  }
  const child = Bun.spawn([command, ...args], { cwd, stdio: ["inherit", "inherit", "inherit"] });
  await child.exited;
  return child.exitCode ?? 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
