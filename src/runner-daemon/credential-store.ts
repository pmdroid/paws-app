import { Database } from "bun:sqlite";
import { existsSync, lstatSync, statfsSync } from "node:fs";
import { join } from "node:path";

const TMPFS_MAGIC = 0x01021994;
const FILE = "credentials.db";

export function attachCredentialStore(db: Database, directory: string): void {
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    Number(statfsSync(directory).type) !== TMPFS_MAGIC
  )
    throw new Error("Runner credential store must be a private tmpfs folder.");
  db.run("DROP TABLE IF EXISTS main.agent_credential");
  db.run("ATTACH DATABASE ? AS credentials", [join(directory, FILE)]);
  db.run("PRAGMA credentials.secure_delete = ON");
  db.run("PRAGMA credentials.journal_mode = TRUNCATE");
}

export function heldCredentialCount(directory: string): number {
  const path = join(directory, FILE);
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'agent_credential'").get()) return 0;
    return (db.query("SELECT count(*) AS held FROM agent_credential").get() as { held: number })
      .held;
  } finally {
    db.close();
  }
}
