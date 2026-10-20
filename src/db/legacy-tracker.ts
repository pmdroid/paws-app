import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export function assertLinearQueue(path: string): void {
  if (!existsSync(path)) return;
  const db = new Database(path, { readonly: true });
  try {
    for (const table of ["epic", "work_item"]) {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
        continue;
      if (db.query(`SELECT 1 FROM ${table} WHERE linear_issue_id LIKE 'github:%' LIMIT 1`).get()) {
        throw new Error(
          "This database contains GitHub issue work. Keep it as an archive and start Paws with a fresh PAWS_HOME and connect Linear in the website to start a separate queue. Existing data has not been changed.",
        );
      }
    }
  } finally {
    db.close();
  }
}
