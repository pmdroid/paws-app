import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOpenCodeCredential, writeOpenCodeCredential } from "../acp";
import type { RunnerCodingAgent } from "../runner-protocol";

export const OPENCODE_CREDENTIAL_FILE = ".paws/opencode-credential.json";
export const OPENCODE_DATABASE = ".local/share/opencode/opencode.db";
const MIGRATE_MS = 120_000;
const CURRENT = `SELECT id, value, time_created FROM credential WHERE integration_id = 'opencode'
  ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`;

type Row = { value: string };

function open(home: string): Database {
  const db = new Database(join(home, OPENCODE_DATABASE), { readonly: true });
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

export async function placeOpenCodeCredential(
  home: string,
  agent: RunnerCodingAgent,
  migrate: () => Promise<void>,
): Promise<string | null> {
  if (agent !== "opencode") return null;
  const file = join(home, OPENCODE_CREDENTIAL_FILE);
  if (!existsSync(file)) return null;
  const value = readOpenCodeCredential(file);
  if (!existsSync(join(home, OPENCODE_DATABASE))) await migrate();
  if (!existsSync(join(home, OPENCODE_DATABASE)))
    throw new Error("OpenCode did not create its database");
  writeOpenCodeCredential(join(home, OPENCODE_DATABASE), value);
  return value;
}

export function collectOpenCodeCredential(home: string, placed: string): boolean {
  const db = open(home);
  let current: string | undefined;
  try {
    current = db.query<Row, []>(CURRENT).get()?.value;
  } finally {
    db.close();
  }
  if (current === undefined || current === placed) return false;
  const target = join(home, OPENCODE_CREDENTIAL_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, current, { mode: 0o660, flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

export async function migrateOpenCodeDatabase(
  command: string,
  home: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const child = Bun.spawn([command, "auth", "list", "--standalone"], {
    cwd: home,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: MIGRATE_MS,
  });
  await child.exited;
}
