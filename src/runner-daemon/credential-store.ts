import type { Database } from "bun:sqlite";
import { lstatSync, statfsSync } from "node:fs";
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
