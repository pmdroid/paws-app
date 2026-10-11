import type { Database } from "bun:sqlite";
import { listInFlightItems } from "./items";
import { advanceOutboxSession } from "./outbox";
import { immediate } from "./tx";

export type StoredLinearSession = {
  sessionId: string;
  issueId: string | null;
  organizationId: string | null;
  appUserId: string | null;
  creatorId: string | null;
  epicId: string | null;
  activeItemId: string | null;
  generation: number;
  stoppedAt: number | null;
};
export type StoredLinearTurn = {
  eventKey: string;
  activityId: string | null;
  sessionId: string;
  actorId: string | null;
  body: string;
  payload: string;
  createdAtMs: number;
  ordinal: number;
  itemId: string | null;
  state: "pending" | "applied" | "cancelled";
};

type SessionRow = {
  session_id: string;
  issue_id: string | null;
  organization_id: string | null;
  app_user_id: string | null;
  creator_id: string | null;
  current_epic_id: string | null;
  active_item_id: string | null;
  generation: number;
  stopped_at: number | null;
};
type TurnRow = {
  event_key: string;
  activity_id: string | null;
  session_id: string;
  actor_id: string | null;
  body: string;
  payload: string;
  created_at_ms: number;
  ordinal: number;
  item_id: string | null;
  state: StoredLinearTurn["state"];
};

export function getLinearSession(db: Database, sessionId: string): StoredLinearSession | null {
  const row = db
    .query<SessionRow, [string]>("SELECT * FROM linear_session WHERE session_id = ?")
    .get(sessionId);
  return row
    ? {
        sessionId: row.session_id,
        issueId: row.issue_id,
        organizationId: row.organization_id,
        appUserId: row.app_user_id,
        creatorId: row.creator_id,
        epicId: row.current_epic_id,
        activeItemId: row.active_item_id,
        generation: row.generation,
        stoppedAt: row.stopped_at,
      }
    : null;
}

export function ensureLinearSession(
  db: Database,
  input: {
    sessionId: string;
    issueId?: string | null;
    organizationId?: string | null;
    appUserId?: string | null;
    creatorId?: string | null;
    now?: number;
  },
): StoredLinearSession {
  return immediate(db, () => {
    const existing = getLinearSession(db, input.sessionId);
    for (const field of ["issueId", "organizationId", "appUserId", "creatorId"] as const) {
      if (existing?.[field] && input[field] && existing[field] !== input[field])
        throw new Error(`Linear session ${field} ownership changed`);
    }
    db.run(
      `INSERT INTO linear_session (session_id, issue_id, organization_id, app_user_id, creator_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      issue_id = COALESCE(linear_session.issue_id, excluded.issue_id),
      organization_id = COALESCE(linear_session.organization_id, excluded.organization_id),
      app_user_id = COALESCE(linear_session.app_user_id, excluded.app_user_id),
      creator_id = COALESCE(linear_session.creator_id, excluded.creator_id)`,
      [
        input.sessionId,
        input.issueId ?? null,
        input.organizationId ?? null,
        input.appUserId ?? null,
        input.creatorId ?? null,
        input.now ?? Date.now(),
      ],
    );
    return getLinearSession(db, input.sessionId)!;
  });
}

export function bindLinearSessionTask(
  db: Database,
  sessionId: string,
  epicId: string,
  options: { actorId?: string | null } = {},
): void {
  immediate(db, () => {
    const current = getLinearSession(db, sessionId);
    if (!current) throw new Error("Linear session has not been recorded");
    if (current.epicId && current.epicId !== epicId) {
      const active =
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM work_item WHERE epic_id = ? AND state NOT IN ('merged','cancelled','completed')",
          )
          .get(current.epicId)?.n ?? 0;
      if (active) throw new Error("Linear session already owns active work");
    }
    db.run(
      "INSERT INTO linear_session_task (session_id, epic_id, owner_actor_id) VALUES (?, ?, ?) ON CONFLICT (session_id,epic_id) DO UPDATE SET owner_actor_id = COALESCE(linear_session_task.owner_actor_id, excluded.owner_actor_id)",
      [sessionId, epicId, options.actorId ?? current.creatorId],
    );
    db.run(
      "UPDATE linear_session SET current_epic_id = ?, active_item_id = CASE WHEN current_epic_id = ? THEN active_item_id ELSE NULL END WHERE session_id = ?",
      [epicId, epicId, sessionId],
    );
  });
}

export function activateLinearItem(db: Database, sessionId: string, itemId: string): void {
  immediate(db, () => {
    const session = getLinearSession(db, sessionId);
    const item = db
      .query<{ epic_id: string; session_key: string | null }, [string]>(
        "SELECT epic_id, session_key FROM work_item WHERE id = ?",
      )
      .get(itemId);
    if (!session || !item || session.epicId !== item.epic_id)
      throw new Error("Linear task route changed");
    if (session.activeItemId && session.activeItemId !== itemId) {
      if (listInFlightItems(db).some((entry) => entry.id === session.activeItemId))
        throw new Error("Previous Linear task is still active");
    }
    if (item.session_key && item.session_key !== sessionId)
      throw new Error("Active task cannot be rerouted to another Linear session");
    db.run("UPDATE linear_session SET active_item_id = ? WHERE session_id = ?", [
      itemId,
      sessionId,
    ]);
    db.run("UPDATE work_item SET session_key = ? WHERE id = ?", [sessionId, itemId]);
  });
}

export function linearSessionForEpic(db: Database, epicId: string): string | null {
  return (
    db
      .query<{ session_id: string }, [string]>(
        "SELECT session_id FROM linear_session WHERE current_epic_id = ? ORDER BY created_at, session_id LIMIT 1",
      )
      .get(epicId)?.session_id ?? null
  );
}

export function recordLinearTurn(
  db: Database,
  input: {
    eventKey: string;
    activityId: string | null;
    sessionId: string;
    actorId: string | null;
    body: string;
    payload: string;
    createdAtMs: number;
    now?: number;
  },
): StoredLinearTurn {
  return immediate(db, () => {
    ensureLinearSession(db, { sessionId: input.sessionId, now: input.now });
    db.run(
      `INSERT INTO linear_turn (event_key,activity_id,session_id,actor_id,body,payload,created_at_ms,received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [
        input.eventKey,
        input.activityId,
        input.sessionId,
        input.actorId,
        input.body,
        input.payload,
        input.createdAtMs,
        input.now ?? Date.now(),
      ],
    );
    const row = db
      .query<TurnRow, [string, string | null]>(
        "SELECT * FROM linear_turn WHERE event_key = ? OR activity_id = ?",
      )
      .get(input.eventKey, input.activityId)!;
    if (row.session_id !== input.sessionId)
      throw new Error("Linear activity belongs to another session");
    if (!row.actor_id && input.actorId) {
      db.run("UPDATE linear_turn SET actor_id = ? WHERE event_key = ?", [
        input.actorId,
        row.event_key,
      ]);
      row.actor_id = input.actorId;
    }
    return mapTurn(row);
  });
}

export function listPendingLinearTurns(db: Database, sessionId: string): StoredLinearTurn[] {
  return db
    .query<TurnRow, [string]>(
      "SELECT * FROM linear_turn WHERE session_id = ? AND state = 'pending' ORDER BY created_at_ms, ordinal",
    )
    .all(sessionId)
    .map(mapTurn);
}

export function applyLinearTurns(
  db: Database,
  sessionId: string,
  eventKeys: readonly string[],
  itemId: string,
): void {
  immediate(db, () => {
    const session = getLinearSession(db, sessionId);
    if (session?.activeItemId !== itemId) throw new Error("Linear turn route is no longer active");
    for (const key of eventKeys)
      db.run(
        "UPDATE linear_turn SET state = 'applied', item_id = ? WHERE event_key = ? AND session_id = ? AND state = 'pending'",
        [itemId, key, sessionId],
      );
  });
}

export function getLinearSessionGeneration(db: Database, sessionId: string): number {
  return getLinearSession(db, sessionId)?.generation ?? 0;
}

export function advanceLinearSessionGeneration(
  db: Database,
  sessionId: string,
  options: { stop?: boolean; now?: number } = {},
): number {
  return immediate(db, () => {
    ensureLinearSession(db, { sessionId, now: options.now });
    const generation = advanceOutboxSession(db, "linear", sessionId, options);
    db.run("UPDATE linear_session SET generation = ?, stopped_at = ? WHERE session_id = ?", [
      generation,
      options.stop ? (options.now ?? Date.now()) : null,
      sessionId,
    ]);
    if (options.stop)
      db.run(
        "UPDATE linear_turn SET state = 'cancelled' WHERE session_id = ? AND state = 'pending' AND created_at_ms <= ?",
        [sessionId, options.now ?? Date.now()],
      );
    return generation;
  });
}

function mapTurn(row: TurnRow): StoredLinearTurn {
  return {
    eventKey: row.event_key,
    activityId: row.activity_id,
    sessionId: row.session_id,
    actorId: row.actor_id,
    body: row.body,
    payload: row.payload,
    createdAtMs: row.created_at_ms,
    ordinal: row.ordinal,
    itemId: row.item_id,
    state: row.state,
  };
}

export function getTaskLinearActor(db: Database, itemId: string): string | null {
  return (
    db
      .query<{ owner_actor_id: string | null }, [string]>(
        "SELECT t.owner_actor_id FROM linear_session_task t JOIN work_item w ON w.epic_id = t.epic_id WHERE w.id = ?",
      )
      .get(itemId)?.owner_actor_id ?? null
  );
}
