import type { Database } from "bun:sqlite";

export type TaskLinearReadKind = "project_overview" | "repository_hints" | "repository_suggestions";

export function keepTaskLinearRead(
  db: Database,
  itemId: string,
  kind: TaskLinearReadKind,
  value: unknown,
  now: number,
): void {
  db.run(
    `INSERT INTO work_item_linear_read(item_id,kind,value_json,read_at) VALUES(?,?,?,?)
     ON CONFLICT(item_id,kind) DO UPDATE SET value_json=excluded.value_json,read_at=excluded.read_at`,
    [itemId, kind, JSON.stringify(value), now],
  );
}

export function getTaskLinearRead(db: Database, itemId: string, kind: TaskLinearReadKind): unknown {
  const row = db
    .query<{ value_json: string }, [string, string]>(
      "SELECT value_json FROM work_item_linear_read WHERE item_id=? AND kind=?",
    )
    .get(itemId, kind);
  return row === null ? undefined : JSON.parse(row.value_json);
}

export function linearActivitiesListedAt(db: Database, sessionId: string): number | null {
  return (
    db
      .query<{ generation: number }, [string]>(
        "SELECT generation FROM linear_activity_listing WHERE session_id=?",
      )
      .get(sessionId)?.generation ?? null
  );
}

export function markLinearActivitiesListed(
  db: Database,
  sessionId: string,
  generation: number,
): void {
  db.run(
    `INSERT INTO linear_activity_listing(session_id,generation) VALUES(?,?)
     ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation`,
    [sessionId, generation],
  );
}
