import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import type { Database } from "bun:sqlite";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "paws-"));
}

// `synchronous=FULL` fsyncs every commit. The first file database on a cold CI
// disk spent longer than bun's 5s test budget inside the ask test (about two
// dozen fsyncs). Pay that once while this module loads; tests use memory.
const template = join(tempHome(), "paws.db");
const warm = openDatabase(template);
try {
  migrate(warm);
} finally {
  warm.close();
}

export function tempDb(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

// Migrating a new file database commits once per migration, about 0.6 s of
// fsyncs alone and many times that on a loaded disk. A test that needs a file
// starts from a copy of the database migrated above instead.
export function migratedDatabase(path: string): Database {
  copyFileSync(template, path);
  const db = openDatabase(path);
  migrate(db);
  return db;
}

/** Drive the queued fix turns that formerly ran inside a single Closeout gate call. */
export async function tickWithRestarts(
  jobs: import("../src/db").JobLoop,
  orchestrator: import("../src/loop").Orchestrator,
  db: Database,
): Promise<import("../src/db").Job | null> {
  const first = await jobs.tick();
  for (let turn = 0; turn < 4; turn++) {
    const next = db
      .query<{ id: number }, []>(
        `SELECT j.id FROM job j JOIN work_item i ON i.id=json_extract(j.payload,'$.itemId')
       WHERE j.queue='run.resume' AND j.status='pending' AND i.state='queued'
       AND json_extract(j.payload,'$.reason') IN ('findings','ci','review','conflict') ORDER BY j.id LIMIT 1`,
      )
      .get();
    if (!next) break;
    orchestrator.reconcileExecution();
    await jobs.tick(["run.resume"]);
    if (first?.queue === "github.merge") await jobs.tick(["github.merge"]);
  }
  return first;
}
