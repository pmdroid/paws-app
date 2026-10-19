import type { Database } from "bun:sqlite";

export function saveBrowserInstallation(
  db: Database,
  input: { stateHash: string; browserHash: string; identity: string; expiresAt: number },
): void {
  db.run("DELETE FROM browser_installation_request WHERE expires_at<=?", [
    input.expiresAt - 600_000,
  ]);
  db.run("INSERT INTO browser_installation_request VALUES(?,?,?,?)", [
    input.stateHash,
    input.browserHash,
    input.identity,
    input.expiresAt,
  ]);
}

export function consumeBrowserInstallation(
  db: Database,
  stateHash: string,
  browserHash: string,
  now: number,
): string | null {
  return (
    db
      .query<{ identity: string }, [string, string, number]>(
        "DELETE FROM browser_installation_request WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING identity",
      )
      .get(stateHash, browserHash, now)?.identity ?? null
  );
}
