import { Database, constants as sqlite } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { journalCaught } from "../journal";
import {
  ExecutionIdSchema,
  publishRunnerAccountHome,
  RUNNER_ACCOUNT_HOMES,
  RunnerAccountHomeError,
  type RunnerAccountOwners,
} from "../runner-execution";
import type { RunnerAgentCredentialFiles, RunnerCodingAgent } from "../runner-protocol";

export const OPENCODE_CREDENTIAL_FILE = ".paws/opencode-credential.json";
export const OPENCODE_DATABASE = ".local/share/opencode/opencode.db";
export const OPENCODE_PURGE = ".paws-opencode-purge";
const DATABASE = "opencode.db";
const DATABASE_FOLDER = [".local", "share", "opencode"] as const;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
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
  writeFileSync(
    join(folder, ExecutionIdSchema.parse(executionId)),
    digest(Buffer.from(file.data, "base64")),
    { mode: 0o660 },
  );
}

function pin(base: string, parts: readonly string[]): number | null {
  let fd = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY);
  for (const part of parts) {
    let next: number | null = null;
    try {
      next = openSync(
        `/proc/self/fd/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        closeSync(fd);
        if (code === "ELOOP" || code === "ENOTDIR")
          throw new Error(`${part} is not a folder in the account home`, { cause: error });
        throw error;
      }
    }
    closeSync(fd);
    if (next === null) return null;
    fd = next;
  }
  return fd;
}

function pinned<T>(
  base: string,
  parts: readonly string[],
  use: (at: string | null, fd: number) => T,
): T {
  const fd = pin(base, parts);
  if (fd === null) return use(null, -1);
  try {
    return use(`/proc/self/fd/${fd}`, fd);
  } finally {
    closeSync(fd);
  }
}

function marked(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    journalCaught(error, "opencode-credential.marked", null, "a marker may be partly written");
    return null;
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, "utf8").trim() : null;
  } finally {
    closeSync(fd);
  }
}

function size(path: string): number {
  return lstatSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

function rewriteDatabase(path: string, folder: string, fd: number, returned: Set<string | null>) {
  const info = lstatSync(join(folder, DATABASE), { throwIfNoEntry: false });
  if (info && !info.isFile()) throw new Error("opencode.db is not a file");
  if (info) {
    const db = new Database(path, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW);
    try {
      const opened = lstatSync(dirname(path));
      const held = fstatSync(fd);
      if (opened.ino !== held.ino || opened.dev !== held.dev)
        throw new Error("OpenCode's database folder moved");
      db.run("PRAGMA busy_timeout = 5000");
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
  }
  for (const suffix of info ? ["-journal"] : SIDECARS)
    rmSync(join(folder, `${DATABASE}${suffix}`), { force: true });
  if (size(join(folder, `${DATABASE}-wal`)) > 0)
    throw new Error("OpenCode's database journal still holds a sign-in");
}

function scrubOpenCodeDatabase(home: string, at: string): void {
  pinned(at, [OPENCODE_PURGE], (purge) => {
    const markers = purge ? names(purge) : [];
    const returned = new Set(markers.map((name) => marked(join(purge!, name))));
    pinned(at, DATABASE_FOLDER, (folder, fd) => {
      if (folder) rewriteDatabase(join(home, OPENCODE_DATABASE), folder, fd, returned);
    });
    for (const name of markers) rmSync(join(purge!, name), { recursive: true, force: true });
  });
}

function purgeAt(home: string, at: string, owners?: RunnerAccountOwners, except = ""): boolean {
  if (!existsSync(join(at, OPENCODE_PURGE)) && !existsSync(join(at, ...DATABASE_FOLDER)))
    return true;
  try {
    publishRunnerAccountHome(at, except, () => scrubOpenCodeDatabase(home, at), owners);
    return true;
  } catch (error) {
    if (error instanceof RunnerAccountHomeError) return false;
    throw error;
  }
}

export function purgeOpenCodeCredential(
  home: string,
  owners?: RunnerAccountOwners,
  except = "",
): boolean {
  return pinned(dirname(home), [basename(home)], (at) =>
    at === null ? true : purgeAt(home, at, owners, except),
  );
}

function openCodeRows(path: string): number {
  const db = new Database(path, sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_NOFOLLOW);
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

function bindingLeft(home: string, at: string, owners?: RunnerAccountOwners): string[] {
  const left: string[] = [];
  try {
    if (!purgeAt(home, at, owners))
      left.push(`${OPENCODE_DATABASE} cleanup waits for work on the account`);
  } catch (error) {
    left.push(`${OPENCODE_DATABASE}: ${(error as Error).message}`);
  }
  try {
    for (const name of pinned(at, [OPENCODE_PURGE], (purge) => (purge ? names(purge) : [])))
      left.push(`${OPENCODE_PURGE}/${name}`);
    const database = pinned(at, DATABASE_FOLDER, (folder) => {
      if (!folder) return false;
      for (const suffix of SIDECARS.filter((sidecar) => sidecar !== "-shm"))
        if (size(join(folder, `${DATABASE}${suffix}`)) > 0)
          left.push(`${OPENCODE_DATABASE}${suffix}`);
      return lstatSync(join(folder, DATABASE), { throwIfNoEntry: false }) !== undefined;
    });
    if (database) {
      const rows = openCodeRows(join(home, OPENCODE_DATABASE));
      if (rows > 0) left.push(`${OPENCODE_DATABASE} holds ${rows} OpenCode sign-ins`);
    }
  } catch (error) {
    left.push(`${OPENCODE_DATABASE}: ${(error as Error).message}`);
  }
  return left;
}

export function openCodeSignInsLeft(agentHome: string, owners?: RunnerAccountOwners): string[] {
  const left: string[] = [];
  for (const binding of names(join(agentHome, RUNNER_ACCOUNT_HOMES))) {
    const home = join(agentHome, RUNNER_ACCOUNT_HOMES, binding);
    if (!lstatSync(home).isDirectory()) continue;
    try {
      for (const entry of pinned(agentHome, [RUNNER_ACCOUNT_HOMES, binding], (at) =>
        at === null ? [] : bindingLeft(home, at, owners),
      ))
        left.push(`${binding}/${entry}`);
    } catch (error) {
      left.push(`${binding}: ${(error as Error).message}`);
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
