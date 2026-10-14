import type { Database } from "bun:sqlite";
import type { createApprovedProjects } from "./runtime";

type Runtime = ReturnType<typeof createApprovedProjects>;
type Access = Pick<
  Runtime,
  | "canDispatch"
  | "authorizeIntake"
  | "scope"
  | "actor"
  | "accepted"
  | "authorizeEvent"
  | "scopeSnapshot"
>;

export function createProjectExecutionGuard(db: Database, current: () => Runtime | null): Access {
  function reserved(sessionId: string) {
    return (
      db
        .query(`SELECT 1 FROM project_approval_issue c WHERE c.session_id=? OR
      (c.released_at IS NULL AND EXISTS(SELECT 1 FROM linear_session s
      JOIN workspace w ON w.linear_organization_id=s.organization_id
      WHERE s.session_id=? AND s.issue_id=c.issue_id AND w.id=c.workspace_id)) LIMIT 1`)
        .get(sessionId, sessionId) !== null
    );
  }
  function ordinary(sessionId: string) {
    if (reserved(sessionId))
      throw new Error("Restore project execution access before continuing this approved scope.");
  }
  return {
    canDispatch(epicId) {
      const active = current();
      return active
        ? active.canDispatch(epicId)
        : db.query("SELECT 1 FROM project_approval_issue WHERE epic_id=?").get(epicId) === null;
    },
    authorizeIntake(sessionId, snapshot) {
      return current()?.authorizeIntake(sessionId, snapshot) ?? !reserved(sessionId);
    },
    scope(sessionId, snapshot) {
      const active = current();
      if (active) return active.scope(sessionId, snapshot);
      ordinary(sessionId);
      return snapshot;
    },
    actor(sessionId) {
      const active = current();
      if (active) return active.actor(sessionId);
      ordinary(sessionId);
      return undefined;
    },
    accepted(sessionId, result) {
      const active = current();
      if (active) active.accepted(sessionId, result);
      else ordinary(sessionId);
    },
    async authorizeEvent(event) {
      const active = current();
      if (active) return active.authorizeEvent(event);
      return event.sessionId && reserved(event.sessionId) ? false : undefined;
    },
    async scopeSnapshot(sessionId, snapshot, signal) {
      const active = current();
      if (active) return active.scopeSnapshot(sessionId, snapshot, signal);
      ordinary(sessionId);
      return snapshot;
    },
  };
}
