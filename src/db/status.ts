import type { Database } from "bun:sqlite";

export type EngineSnapshotItem = {
  id: string;
  identifier: string;
  title: string;
  state: string;
  epicId: string;
  turnCount: number;
  recoveryAttempts: number;
};

export type EngineSnapshotRun = {
  id: string;
  itemId: string;
  kind: string;
  agent: string;
  status: string;
  updatedAt: number;
};

export type EngineSnapshot = {
  now: number;
  counts: {
    epics: number;
    items: number;
    runs: number;
    jobsPending: number;
    jobsRunning: number;
    outboxPending: number;
  };
  items: EngineSnapshotItem[];
  runs: EngineSnapshotRun[];
};

/** Public engine rows for `/api/status`. Omits checkpoints, tokens, and payloads. */
export function readEngineSnapshot(db: Database, now = Date.now()): EngineSnapshot {
  const jobs = db
    .query<{ pending: number; running: number }, []>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running
       FROM job`,
    )
    .get();
  const outbox = db
    .query<{ pending: number }, []>(
      `SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending FROM outbox`,
    )
    .get();
  return {
    now,
    counts: {
      epics: scalar(db, "SELECT COUNT(*) AS n FROM epic"),
      items: scalar(db, "SELECT COUNT(*) AS n FROM work_item"),
      runs: scalar(db, "SELECT COUNT(*) AS n FROM run"),
      jobsPending: jobs?.pending ?? 0,
      jobsRunning: jobs?.running ?? 0,
      outboxPending: outbox?.pending ?? 0,
    },
    items: db
      .query<
        {
          id: string;
          linear_identifier: string;
          title: string;
          state: string;
          epic_id: string;
          turn_count: number;
          recovery_attempts: number;
        },
        []
      >(
        `SELECT id, linear_identifier, title, state, epic_id, turn_count, recovery_attempts
         FROM work_item
         ORDER BY created_at DESC, id
         LIMIT 50`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        identifier: row.linear_identifier,
        title: row.title,
        state: row.state,
        epicId: row.epic_id,
        turnCount: row.turn_count,
        recoveryAttempts: row.recovery_attempts,
      })),
    runs: db
      .query<
        {
          id: string;
          item_id: string;
          kind: string;
          agent: string;
          status: string;
          updated_at: number;
        },
        []
      >(
        `SELECT id, item_id, kind, agent, status, updated_at
         FROM run
         ORDER BY updated_at DESC, id
         LIMIT 20`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        itemId: row.item_id,
        kind: row.kind,
        agent: row.agent,
        status: row.status,
        updatedAt: row.updated_at,
      })),
  };
}

function scalar(db: Database, sql: string): number {
  const row = db.query<{ n: number }, []>(sql).get();
  return row?.n ?? 0;
}
