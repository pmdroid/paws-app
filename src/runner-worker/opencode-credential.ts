import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RunnerCodingAgent } from "../runner-protocol";

export const OPENCODE_CREDENTIAL_FILE = ".paws/opencode-credential.json";
export const OPENCODE_DATABASE = ".local/share/opencode/opencode.db";
const MIGRATE_MS = 120_000;
const CURRENT = `SELECT id, value, time_created FROM credential WHERE integration_id = 'opencode'
  ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`;

type Row = { id: string; value: string; time_created: number };

function open(home: string, readonly: boolean): Database {
  const db = new Database(
    join(home, OPENCODE_DATABASE),
    readonly ? { readonly } : { readwrite: true },
  );
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
  const value = readFileSync(file, "utf8");
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("OpenCode credential is not an object");
  if (!existsSync(join(home, OPENCODE_DATABASE))) await migrate();
  if (!existsSync(join(home, OPENCODE_DATABASE)))
    throw new Error("OpenCode did not create its database");
  const db = open(home, false);
  try {
    db.transaction(() => {
      const kept = db.query<Row, []>(CURRENT).get();
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
  return value;
}

export function collectOpenCodeCredential(home: string, placed: string): boolean {
  const db = open(home, true);
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

const PURGING = ".paws-opencode-purging";

function nonEmpty(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function purgeOpenCodeCredential(home: string): void {
  if (!existsSync(join(home, OPENCODE_DATABASE)))
    return rmSync(join(home, PURGING), { force: true });
  writeFileSync(join(home, PURGING), "");
  for (const file of ["", "-wal", "-shm"].map((end) => join(home, OPENCODE_DATABASE + end)))
    if (existsSync(file) && statSync(file).uid === process.getuid?.()) chmodSync(file, 0o660);
  const db = open(home, false);
  try {
    db.run("PRAGMA secure_delete = ON");
    db.run("DELETE FROM credential WHERE integration_id = 'opencode'");
    db.run("VACUUM");
    const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint && checkpoint.busy !== 0)
      throw new Error("OpenCode database is busy; its journal still holds the token");
  } finally {
    db.close();
  }
  if (nonEmpty(join(home, `${OPENCODE_DATABASE}-wal`)))
    throw new Error("OpenCode database journal was not emptied");
  rmSync(join(home, PURGING), { force: true });
}

export function finishOpenCodePurge(home: string): void {
  if (existsSync(join(home, PURGING))) purgeOpenCodeCredential(home);
}

export function openCodeCredentialLeft(home: string): boolean {
  if (existsSync(join(home, PURGING))) return true;
  const database = join(home, OPENCODE_DATABASE);
  if (nonEmpty(`${database}-wal`) || nonEmpty(`${database}-journal`)) return true;
  if (!existsSync(database)) return false;
  const db = open(home, true);
  try {
    return db.query<Row, []>(CURRENT).get() !== null;
  } finally {
    db.close();
  }
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
