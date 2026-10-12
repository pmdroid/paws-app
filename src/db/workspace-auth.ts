import type { Database } from "bun:sqlite";
import type { WorkspaceRole } from "./workspace";

export type WorkspaceOAuthRequest = {
  stateHash: string;
  browserHash: string;
  bootstrapHash: string | null;
  expiresAt: number;
};

export function saveWorkspaceOAuthRequest(db: Database, input: WorkspaceOAuthRequest): void {
  db.run("DELETE FROM workspace_oauth_request WHERE expires_at<=?", [input.expiresAt - 600_000]);
  db.run(
    "INSERT INTO workspace_oauth_request(state_hash,browser_hash,verifier,bootstrap_hash,expires_at) VALUES(?,?,'',?,?)",
    [input.stateHash, input.browserHash, input.bootstrapHash, input.expiresAt],
  );
}

export function consumeWorkspaceOAuthRequest(
  db: Database,
  stateHash: string,
  browserHash: string,
  now: number,
): WorkspaceOAuthRequest | null {
  return db
    .query<WorkspaceOAuthRequest, [string, string, number]>(
      `DELETE FROM workspace_oauth_request WHERE state_hash=? AND browser_hash=? AND expires_at>?
      RETURNING state_hash AS stateHash,browser_hash AS browserHash,bootstrap_hash AS bootstrapHash,expires_at AS expiresAt`,
    )
    .get(stateHash, browserHash, now);
}

export function listUserWorkspaces(db: Database, userId: string) {
  return db
    .query<{ id: string; name: string; role: WorkspaceRole }, [string]>(
      `SELECT w.id,w.name,m.role FROM workspace w JOIN workspace_member m ON m.workspace_id=w.id
      WHERE m.user_id=? AND m.active=1 ORDER BY w.name,w.id`,
    )
    .all(userId);
}
