import { Database } from "bun:sqlite";

/** One connection. The process that calls this is the only writer. */
export function openDatabase(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA temp_store = MEMORY");
  return db;
}

export function incrementalVacuum(db: Database): void {
  const mode = db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get();
  if (mode?.auto_vacuum === 2) db.run("PRAGMA incremental_vacuum");
}

export function truncateWal(db: Database): void {
  const [checkpoint] = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").all();
  if (checkpoint?.busy) throw new Error("Runner event WAL checkpoint is busy.");
}

export async function withSecureDelete<T>(db: Database, work: () => Promise<T>): Promise<T> {
  const mode = db.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()?.secure_delete;
  const previous = mode === 2 ? "FAST" : mode ? "ON" : "OFF";
  db.run("PRAGMA secure_delete=ON");
  try {
    return await work();
  } finally {
    db.run(`PRAGMA secure_delete=${previous}`);
  }
}
