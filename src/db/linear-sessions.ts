import type { Database } from "bun:sqlite";
import { listInFlightItems } from "./items";
import { advanceOutboxSession, enqueueOutboxOnce } from "./outbox";
import { immediate } from "./tx";

export type StoredLinearSession = {
  sessionId: string;
  issueId: string | null;
  organizationId: string | null;
  appUserId: string | null;
  creatorId: string | null;
  delegationId: string | null;
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
    .query<SessionRow, [string]>(
      `SELECT session_id, issue_id, organization_id, app_user_id, creator_id, active_item_id, generation, stopped_at
       FROM linear_session WHERE session_id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  const linked = workItemForSession(db, sessionId);
  return {
    sessionId: row.session_id,
    issueId: row.issue_id,
    organizationId: row.organization_id,
    appUserId: row.app_user_id,
    creatorId: row.creator_id,
    delegationId: linked?.delegationId ?? null,
    activeItemId: row.active_item_id,
    generation: row.generation,
    stoppedAt: row.stopped_at,
  };
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
  delegationId: string,
  options: { actorId?: string | null } = {},
): void {
  immediate(db, () => {
    const current = getLinearSession(db, sessionId);
    if (!current) throw new Error("Linear session has not been recorded");
    if (current.delegationId && current.delegationId !== delegationId) {
      const active =
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM work_item WHERE delegation_id = ? AND state NOT IN ('merged','cancelled','completed')",
          )
          .get(current.delegationId)?.n ?? 0;
      if (active) throw new Error("Linear session already owns active work");
      db.run("UPDATE linear_session SET active_item_id = NULL WHERE session_id = ?", [sessionId]);
    }
    db.run(
      "UPDATE work_item SET session_key = ? WHERE delegation_id = ? AND (session_key IS NULL OR session_key = ?)",
      [sessionId, delegationId, sessionId],
    );
    const actorId = options.actorId ?? current.creatorId;
    const owner = actorId
      ? db
          .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id = ?")
          .get(actorId)
      : null;
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(work_item)")
      .all()
      .map((column) => column.name);
    const ownerColumn = columns.includes("owner_user_id");
    if (columns.includes("delegated_by"))
      db.run(
        "UPDATE work_item SET delegated_by = COALESCE(delegated_by, ?) WHERE delegation_id = ? AND session_key = ?",
        [actorId, delegationId, sessionId],
      );
    if (owner && ownerColumn)
      db.run(
        "UPDATE work_item SET owner_user_id = ? WHERE delegation_id = ? AND session_key = ? AND owner_user_id IS NULL",
        [owner.id, delegationId, sessionId],
      );
  });
}

export function activateLinearItem(db: Database, sessionId: string, itemId: string): void {
  immediate(db, () => {
    const session = getLinearSession(db, sessionId);
    const item = db
      .query<{ delegation_id: string; session_key: string | null }, [string]>(
        "SELECT delegation_id, session_key FROM work_item WHERE id = ?",
      )
      .get(itemId);
    if (
      !session ||
      !item ||
      (session.delegationId !== null && session.delegationId !== item.delegation_id)
    )
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

export function workItemForSession(
  db: Database,
  sessionId: string,
): { id: string; delegationId: string; state: string } | null {
  const row = db
    .query<{ id: string; delegation_id: string; state: string }, [string]>(
      `SELECT id, delegation_id, state FROM work_item
       WHERE session_key = ?
       ORDER BY CASE
         WHEN state IN ('running','verifying','recovering','awaiting_input','paused','merge_queue') THEN 0
         WHEN state IN ('queued','planning') THEN 1
         WHEN state IN ('failed','manual') THEN 2
         ELSE 3 END,
                created_at DESC, position DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId);
  return row ? { id: row.id, delegationId: row.delegation_id, state: row.state } : null;
}

/** The delegator rule shared by item reads and bulk access revocation. Aliases are internal SQL. */
export function delegatedLinearUserIdSql(item: string, session: string): string {
  return `COALESCE((SELECT u.linear_user_id FROM workspace_user u WHERE u.id=${item}.owner_user_id), ${item}.delegated_by, ${session}.creator_id)`;
}

export function delegatedLinearUserId(db: Database, itemId: string): string | null {
  return (
    db
      .query<{ actorId: string | null }, [string]>(
        `SELECT ${delegatedLinearUserIdSql("w", "s")} AS actorId
         FROM work_item w
         LEFT JOIN linear_session s ON s.session_id = w.session_key
         WHERE w.id = ?`,
      )
      .get(itemId)?.actorId ?? null
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
    const linked = db
      .query<{ session_key: string | null }, [string]>(
        "SELECT session_key FROM work_item WHERE id = ?",
      )
      .get(itemId);
    if (linked?.session_key !== sessionId) throw new Error("Linear turn route is no longer active");
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

export function listLinearTurnsForItem(db: Database, itemId: string): StoredLinearTurn[] {
  return db
    .query<TurnRow, [string]>(
      "SELECT * FROM linear_turn WHERE item_id = ? AND state = 'applied' ORDER BY created_at_ms,ordinal",
    )
    .all(itemId)
    .map(mapTurn);
}

export function getLinearTurnGeneration(
  db: Database,
  sessionId: string,
  eventKey: string,
  activityId: string | null,
): number | null {
  return (
    db
      .query<{ announced_generation: number | null }, [string, string, string | null]>(
        "SELECT announced_generation FROM linear_turn WHERE session_id = ? AND (event_key = ? OR activity_id = ?)",
      )
      .get(sessionId, eventKey, activityId)?.announced_generation ?? null
  );
}

export function announceLinearTurn(
  db: Database,
  sessionId: string,
  eventKey: string,
  now = Date.now(),
): boolean {
  return immediate(db, () => {
    const turn = db
      .query<
        { announced_generation: number | null; state: string; created_at_ms: number },
        [string, string]
      >(
        "SELECT announced_generation,state,created_at_ms FROM linear_turn WHERE event_key = ? AND session_id = ?",
      )
      .get(eventKey, sessionId);
    if (!turn || turn.state !== "pending" || turn.announced_generation !== null) return false;
    const session = getLinearSession(db, sessionId);
    if (
      session?.stoppedAt !== null &&
      session?.stoppedAt !== undefined &&
      turn.created_at_ms <= session.stoppedAt
    ) {
      db.run("UPDATE linear_turn SET state = 'cancelled' WHERE event_key = ?", [eventKey]);
      return false;
    }
    const generation = advanceLinearSessionGeneration(db, sessionId, { now });
    db.run("UPDATE linear_turn SET announced_generation = ? WHERE event_key = ?", [
      generation,
      eventKey,
    ]);
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: sessionId,
      generation,
      delivery: "critical",
      idempotencyKey: `turn:ack:${eventKey}`,
      payload: {
        sessionId,
        kind: "thought",
        body: "Received your update.",
        id: crypto.randomUUID(),
      },
      now,
    });
    return true;
  });
}

export function discardLinearTurns(
  db: Database,
  sessionId: string,
  eventKeys: readonly string[],
): void {
  immediate(db, () => {
    for (const eventKey of eventKeys)
      db.run(
        "UPDATE linear_turn SET state = 'cancelled' WHERE session_id = ? AND event_key = ? AND state = 'pending'",
        [sessionId, eventKey],
      );
  });
}

export function acceptLinearStop(
  db: Database,
  sessionId: string,
  eventKey: string,
  now: number,
): number | null {
  return immediate(db, () => {
    if (
      db
        .query("SELECT 1 FROM linear_stop_receipt WHERE session_id = ? AND event_key = ?")
        .get(sessionId, eventKey)
    )
      return null;
    const session = ensureLinearSession(db, { sessionId, now });
    const generation =
      session.stoppedAt === null
        ? advanceLinearSessionGeneration(db, sessionId, { stop: true, now })
        : session.generation;
    db.run(
      "INSERT INTO linear_stop_receipt (session_id,event_key,generation,created_at) VALUES (?, ?, ?, ?)",
      [sessionId, eventKey, generation, now],
    );
    return generation;
  });
}
