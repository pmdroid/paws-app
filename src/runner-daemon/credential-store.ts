import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, rmSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";

const TMPFS_MAGIC = 0x01021994;
const FILE = "credentials.db";

function privateTmpfs(directory: string): boolean {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.mode & 0o077) return false;
  return Number(statfsSync(directory).type) === TMPFS_MAGIC;
}

function synced(path: string, flags: string): void {
  const descriptor = openSync(path, flags, 0o600);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function attachCredentialStore(db: Database, directory: string, marker: string): void {
  if (!privateTmpfs(directory))
    throw new Error("Runner credential store must be a private tmpfs folder.");
  const legacy = db.query("SELECT 1 FROM main.sqlite_master WHERE name = 'agent_credential'").get();
  if (legacy || existsSync(marker)) {
    synced(marker, "w");
    synced(dirname(marker), "r");
    db.run("PRAGMA main.secure_delete = ON");
    db.run("DROP TABLE IF EXISTS main.agent_credential");
    db.run("VACUUM main");
    const checkpoint = db.query<{ busy: number }, []>("PRAGMA main.wal_checkpoint(TRUNCATE)").get();
    if (checkpoint && checkpoint.busy !== 0)
      throw new Error("Runner command store still holds sign-ins in its journal.");
    rmSync(marker, { force: true });
  }
  db.run("ATTACH DATABASE ? AS credentials", [join(directory, FILE)]);
  db.run("PRAGMA credentials.secure_delete = ON");
  db.run("PRAGMA credentials.journal_mode = TRUNCATE");
}

export function heldCredentialsLeft(directory: string): number | null {
  const path = join(directory, FILE);
  if (!existsSync(path) || !privateTmpfs(directory)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_credential'")
      .get();
    if (!table) return null;
    return (db.query("SELECT count(*) AS n FROM agent_credential").get() as { n: number }).n;
  } finally {
    db.close();
  }
}
