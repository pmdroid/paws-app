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
  const held = db
    .query("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'agent_credential'")
    .get();
  if (held) {
    db.run("PRAGMA main.secure_delete = ON");
    db.run("DELETE FROM main.agent_credential");
    db.run("DROP TABLE main.agent_credential");
    db.run("VACUUM main");
    const checkpoint = db.query<{ busy: number }, []>("PRAGMA main.wal_checkpoint(TRUNCATE)").get();
    if (checkpoint && checkpoint.busy !== 0)
      throw new Error("Runner command store still holds sign-ins in its journal.");
  }
  db.run("ATTACH DATABASE ? AS credentials", [join(directory, FILE)]);
  db.run("PRAGMA credentials.secure_delete = ON");
  db.run("PRAGMA credentials.journal_mode = TRUNCATE");
}

export function heldCredentialsLeft(directory: string): number {
  const path = join(directory, FILE);
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_credential'")
      .get();
    if (!table) return 0;
    return (db.query("SELECT count(*) AS n FROM agent_credential").get() as { n: number }).n;
  } finally {
    db.close();
  }
}
