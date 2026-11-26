import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { activeExecutions, ExecutionIdSchema, RUNNER_ACCOUNT_HOMES } from "../runner-execution";
import type { RunnerAgentCredentialFiles, RunnerCodingAgent } from "../runner-protocol";

export const OPENCODE_CREDENTIAL_FILE = ".paws/opencode-credential.json";
export const OPENCODE_DATABASE = ".local/share/opencode/opencode.db";
export const OPENCODE_PURGE = ".paws-opencode-purge";
const JOURNALS = ["-wal", "-journal"] as const;
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
  shareDatabase(home);
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
  shareDatabase(home);
  return value;
}

function shareDatabase(home: string): void {
  const self = process.getuid?.();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const path = `${join(home, OPENCODE_DATABASE)}${suffix}`;
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info?.isFile() && info.uid === self && (info.mode & 0o777) !== 0o660)
      chmodSync(path, 0o660);
  }
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function names(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function markOpenCodePurge(
  home: string,
  executionId: string,
  returned: RunnerAgentCredentialFiles,
): void {
  const file = returned.find((entry) => entry.path === OPENCODE_CREDENTIAL_FILE);
  if (!file) return;
  const folder = join(home, OPENCODE_PURGE);
  mkdirSync(folder, { recursive: true, mode: 0o770 });
  const target = join(folder, ExecutionIdSchema.parse(executionId));
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, digest(Buffer.from(file.data, "base64")), {
      mode: 0o660,
      flag: "wx",
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function purgeOpenCodeCredential(home: string, except?: string): boolean {
  const folder = join(home, OPENCODE_PURGE);
  const markers = names(folder).filter((name) => ExecutionIdSchema.safeParse(name).success);
  if (markers.length === 0) return true;
  if (activeExecutions(home, except).length > 0) return false;
  const returned = new Set(markers.map((name) => readFileSync(join(folder, name), "utf8").trim()));
  const path = join(home, OPENCODE_DATABASE);
  if (existsSync(path)) {
    const db = open(home, false);
    try {
      db.run("PRAGMA secure_delete = ON");
      db.transaction(() => {
        for (const row of db
          .query<Pick<Row, "id" | "value">, []>(
            "SELECT id, value FROM credential WHERE integration_id = 'opencode'",
          )
          .all())
          if (returned.has(digest(row.value)))
            db.run("DELETE FROM credential WHERE id = ?", [row.id]);
      })();
      db.run("VACUUM");
      const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint && checkpoint.busy !== 0)
        throw new Error("OpenCode's database is still in use");
    } finally {
      db.close();
    }
    rmSync(`${path}-journal`, { force: true });
    if ((lstatSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0)
      throw new Error("OpenCode's database journal still holds a sign-in");
  }
  for (const name of markers) rmSync(join(folder, name), { force: true });
  return true;
}

function openCodeRows(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
      .get();
    if (!table) return 0;
    return db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM credential WHERE integration_id = 'opencode'",
      )
      .get()!.n;
  } finally {
    db.close();
  }
}

export function openCodeSignInsLeft(agentHome: string): string[] {
  const left: string[] = [];
  for (const binding of names(join(agentHome, RUNNER_ACCOUNT_HOMES))) {
    const home = join(agentHome, RUNNER_ACCOUNT_HOMES, binding);
    if (!lstatSync(home).isDirectory()) continue;
    try {
      purgeOpenCodeCredential(home);
    } catch (error) {
      left.push(`${binding}/${OPENCODE_DATABASE}: ${(error as Error).message}`);
    }
    for (const name of names(join(home, OPENCODE_PURGE)))
      left.push(`${binding}/${OPENCODE_PURGE}/${name}`);
    const path = join(home, OPENCODE_DATABASE);
    for (const suffix of JOURNALS)
      if ((lstatSync(`${path}${suffix}`, { throwIfNoEntry: false })?.size ?? 0) > 0)
        left.push(`${binding}/${OPENCODE_DATABASE}${suffix}`);
    if (!existsSync(path)) continue;
    try {
      const rows = openCodeRows(path);
      if (rows > 0) left.push(`${binding}/${OPENCODE_DATABASE} holds ${rows} OpenCode sign-ins`);
    } catch (error) {
      left.push(`${binding}/${OPENCODE_DATABASE}: ${(error as Error).message}`);
    }
  }
  return left;
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
