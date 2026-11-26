import { Database } from "bun:sqlite";
import { existsSync, lstatSync, statfsSync } from "node:fs";
import { join } from "node:path";

const TMPFS_MAGIC = 0x01021994;
const FILE = "credentials.db";

function privateTmpfs(directory: string): boolean {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.mode & 0o077) return false;
  return Number(statfsSync(directory).type) === TMPFS_MAGIC;
}

export function attachCredentialStore(db: Database, directory: string): void {
  if (!privateTmpfs(directory))
    throw new Error("Runner credential store must be a private tmpfs folder.");
  db.run("PRAGMA main.secure_delete = ON");
  db.run("DROP TABLE IF EXISTS main.agent_credential");
  db.run("VACUUM main");
  const checkpoint = db.query<{ busy: number }, []>("PRAGMA main.wal_checkpoint(TRUNCATE)").get();
  if (checkpoint && checkpoint.busy !== 0)
    throw new Error("Runner command store still holds sign-ins in its journal.");
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
