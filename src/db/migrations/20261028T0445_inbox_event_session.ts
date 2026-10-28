import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261028T0445_inbox_event_session",
  sql: `CREATE INDEX inbox_event_session ON inbox_event(session_id, received_at);`,
};
