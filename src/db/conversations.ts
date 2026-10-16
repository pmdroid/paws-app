import type { Database } from "bun:sqlite";

export type LinearConversationSession = {
  id: string;
  issueId: string | null;
  activeItemId: string | null;
  generation: number;
  stoppedAt: number | null;
};

export type LinearConversationTurn = {
  id: string;
  activityId: string | null;
  actorId: string | null;
  body: string;
  createdAt: number;
  itemId: string | null;
  state: "pending" | "applied" | "cancelled";
};

export type LinearConversationTask = {
  id: string;
  identifier: string;
  title: string;
  state: string;
  mode: "code" | "answer" | "artifact" | null;
  response: string | null;
};

export type LinearConversationQuestion = {
  id: string;
  itemId: string;
  body: string;
  options: readonly (string | { label?: string; value: string })[];
  state: string;
  answer: string | null;
  createdAt: number;
};

export type LinearConversationArtifact = {
  id: string;
  itemId: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  state: "pending" | "uploaded" | "failed";
};

export function listLinearSessions(db: Database): LinearConversationSession[] {
  if (!hasTable(db, "linear_session")) return [];
  return db
    .query<LinearConversationSession, []>(`SELECT session_id AS id, issue_id AS issueId,
    active_item_id AS activeItemId, generation, stopped_at AS stoppedAt
    FROM linear_session ORDER BY created_at DESC, session_id`)
    .all();
}

export function listLinearSessionTurns(db: Database, sessionId: string): LinearConversationTurn[] {
  if (!hasTable(db, "linear_turn")) return [];
  return db
    .query<LinearConversationTurn, [string]>(`SELECT event_key AS id,
    activity_id AS activityId, actor_id AS actorId, body, created_at_ms AS createdAt,
    item_id AS itemId, state FROM linear_turn WHERE session_id = ?
    ORDER BY created_at_ms, ordinal`)
    .all(sessionId);
}

export function listLinearSessionTasks(db: Database, sessionId: string): LinearConversationTask[] {
  const modes = hasTable(db, "work_item_task");
  return db
    .query<LinearConversationTask, [string]>(`SELECT w.id,
    w.linear_identifier AS identifier, w.title, w.state,
    ${modes ? "t.mode, t.response" : "NULL AS mode, NULL AS response"}
    FROM work_item w ${modes ? "LEFT JOIN work_item_task t ON t.item_id = w.id" : ""}
    WHERE w.session_key = ?
    ORDER BY w.created_at, w.position, w.id`)
    .all(sessionId);
}

export function listLinearSessionQuestions(
  db: Database,
  sessionId: string,
): LinearConversationQuestion[] {
  const cancelled = db
    .query<{ name: string }, []>("PRAGMA table_info(question)")
    .all()
    .some((column) => column.name === "cancelled_at");
  return db
    .query<Omit<LinearConversationQuestion, "options"> & { options: string | null }, [string]>(
      `SELECT id, item_id AS itemId, body, options, ${cancelled ? "CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' ELSE status END" : "status"} AS state, answer,
      created_at AS createdAt FROM question WHERE session_id = ? ORDER BY created_at, id`,
    )
    .all(sessionId)
    .map((row) => ({ ...row, options: choices(row.options) }));
}

export function listLinearSessionArtifacts(
  db: Database,
  sessionId: string,
): LinearConversationArtifact[] {
  if (!hasTable(db, "linear_artifact")) return [];
  const tasks = listLinearSessionTasks(db, sessionId).map((item) => item.id);
  if (!tasks.length) return [];
  return db
    .query<LinearConversationArtifact, string[]>(`SELECT id, item_id AS itemId,
    display_name AS displayName, mime_type AS mimeType, size_bytes AS sizeBytes, state
    FROM linear_artifact WHERE item_id IN (${tasks.map(() => "?").join(",")})
    ORDER BY created_at, id`)
    .all(...tasks);
}

export function listLinearConversationSnapshots(db: Database, sessionId: string): unknown[] {
  if (!hasTable(db, "linear_activity_snapshot")) return [];
  return db
    .query<{ snapshot: string }, [string]>(`SELECT snapshot FROM linear_activity_snapshot
    WHERE session_id = ? ORDER BY created_at, id`)
    .all(sessionId)
    .flatMap((row) => {
      try {
        const snapshot: unknown = JSON.parse(row.snapshot);
        if (!snapshot || typeof snapshot !== "object") return [];
        const value = snapshot as Record<string, unknown>;
        return [
          {
            id: value["id"],
            createdAt: value["createdAt"],
            content: value["content"],
            userId: value["userId"],
            ephemeral: value["ephemeral"],
          },
        ];
      } catch {
        return [];
      }
    });
}

export function getLinearConversationSource(db: Database, sessionId: string): string | null {
  for (const [table, filter, order] of [
    ["inbox_event", "AND action = 'created'", "received_at"],
    ["linear_turn", "", "ordinal"],
  ] as const) {
    if (!hasTable(db, table)) continue;
    const row = db
      .query<{ url: string }, [string]>(`SELECT CASE WHEN json_valid(payload) THEN
      COALESCE(json_extract(payload, '$.agentSession.url'), json_extract(payload, '$.agentSession.issue.url'))
      ELSE NULL END AS url FROM ${table} WHERE session_id = ? ${filter}
      AND typeof(url) = 'text' AND length(url) > 0 ORDER BY ${order} LIMIT 1`)
      .get(sessionId);
    if (row) return row.url;
  }
  return null;
}

function hasTable(db: Database, name: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null
  );
}

function choices(value: string | null): LinearConversationQuestion["options"] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry) =>
          typeof entry === "string" ||
          (entry && typeof entry === "object" && typeof entry.value === "string"),
      )
      .map((entry: string | { label?: unknown; value: string }) =>
        typeof entry === "string"
          ? entry
          : {
              value: entry.value,
              ...(typeof entry.label === "string" ? { label: entry.label } : {}),
            },
      );
  } catch {
    return [];
  }
}
