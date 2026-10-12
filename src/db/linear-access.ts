import type { Database } from "bun:sqlite";
import { ensureLinearSession } from "./linear-sessions";
import { immediate } from "./tx";

export type LinearInstallationScope = {
  organizationId: string;
  oauthClientId: string;
  appUserId: string;
};

export type LinearSessionAccess = "allowed" | "revoked" | "team_removed" | "unknown";

export function hasLinearNotification(
  db: Database,
  input: LinearInstallationScope & { notificationId: string; createdAtMs: number },
): boolean {
  return (
    db
      .query("SELECT 1 FROM linear_access_event WHERE event_key = ?")
      .get(notificationKey(input)) !== null
  );
}

export function recordLinearNotification(
  db: Database,
  input: LinearInstallationScope & { notificationId: string; createdAtMs: number },
): boolean {
  return recordEvent(db, notificationKey(input), input.createdAtMs);
}

function notificationKey(
  input: LinearInstallationScope & { notificationId: string; createdAtMs: number },
): string {
  validate(input.organizationId, input.oauthClientId, input.appUserId, input.notificationId);
  validateTime(input.createdAtMs);
  return JSON.stringify([
    "notification",
    input.organizationId,
    input.oauthClientId,
    input.appUserId,
    input.notificationId,
  ]);
}

export function dropLinearSessionDeliveries(db: Database, sessionId: string): void {
  db.run(
    "UPDATE outbox SET status = 'dropped', error = 'Linear installation access was revoked.' WHERE target = 'linear' AND ordering_key = ? AND status IN ('pending','dead')",
    [sessionId],
  );
}

export function recordLinearInstallation(
  db: Database,
  input: LinearInstallationScope & {
    sessionId: string;
    teamId: string | null;
    observedAtMs: number;
  },
): void {
  validate(input.organizationId, input.oauthClientId, input.appUserId, input.sessionId);
  validateTime(input.observedAtMs);
  if (input.teamId !== null) validate(input.teamId);
  immediate(db, () => {
    ensureLinearSession(db, input);
    const current = db
      .query<
        {
          oauth_client_id: string | null;
          team_id: string | null;
          installation_observed_at: number | null;
        },
        [string]
      >(
        "SELECT oauth_client_id, team_id, installation_observed_at FROM linear_session WHERE session_id = ?",
      )
      .get(input.sessionId)!;
    if (current.oauth_client_id !== null && current.oauth_client_id !== input.oauthClientId)
      throw new Error("Linear session OAuth client ownership changed");
    if (current.installation_observed_at !== null) {
      if (current.installation_observed_at > input.observedAtMs) return;
      if (
        current.installation_observed_at === input.observedAtMs &&
        current.team_id !== input.teamId
      )
        throw new Error("Linear session team observations conflict");
    }
    db.run(
      "UPDATE linear_session SET oauth_client_id = ?, team_id = ?, installation_observed_at = ? WHERE session_id = ?",
      [input.oauthClientId, input.teamId, input.observedAtMs, input.sessionId],
    );
  });
}

export function revokeLinearInstallation(
  db: Database,
  input: { eventKey: string; organizationId: string; oauthClientId: string; createdAtMs: number },
): string[] {
  validate(input.eventKey, input.organizationId, input.oauthClientId);
  validateTime(input.createdAtMs);
  return immediate(db, () => {
    if (!recordEvent(db, input.eventKey, input.createdAtMs)) return [];
    const changed = db.run(
      `INSERT INTO linear_app_revocation (organization_id, oauth_client_id, revoked_at)
      VALUES (?, ?, ?) ON CONFLICT (organization_id, oauth_client_id) DO UPDATE SET
      revoked_at = MAX(linear_app_revocation.revoked_at, excluded.revoked_at),
      generation = linear_app_revocation.generation + 1, restored_after = NULL,
      restored_credential_fingerprint = NULL
      WHERE linear_app_revocation.restored_after IS NULL
        OR excluded.revoked_at >= linear_app_revocation.restored_after`,
      [input.organizationId, input.oauthClientId, input.createdAtMs],
    ).changes;
    if (changed === 0) return [];
    return sessions(db, "organization_id = ? AND oauth_client_id = ?", [
      input.organizationId,
      input.oauthClientId,
    ]);
  });
}

export function changeLinearTeamAccess(
  db: Database,
  input: LinearInstallationScope & {
    eventKey: string;
    createdAtMs: number;
    canAccessAllPublicTeams: boolean;
    addedTeamIds: readonly string[];
    removedTeamIds: readonly string[];
  },
): string[] {
  validate(input.eventKey, input.organizationId, input.oauthClientId, input.appUserId);
  validateTime(input.createdAtMs);
  validate(...input.addedTeamIds, ...input.removedTeamIds);
  if (input.addedTeamIds.some((team) => input.removedTeamIds.includes(team)))
    throw new Error("Linear team access change contradicts itself");
  return immediate(db, () => {
    if (!recordEvent(db, input.eventKey, input.createdAtMs)) return [];
    const previous = getLinearInstallationPermissions(db, input);
    const updated = db.run(
      `INSERT INTO linear_installation_permission (organization_id, oauth_client_id, app_user_id, all_public_teams, observed_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (organization_id, oauth_client_id, app_user_id)
      DO UPDATE SET all_public_teams = excluded.all_public_teams, observed_at = excluded.observed_at
      WHERE linear_installation_permission.observed_at < excluded.observed_at
        OR (linear_installation_permission.observed_at = excluded.observed_at AND excluded.all_public_teams = 0)`,
      [
        input.organizationId,
        input.oauthClientId,
        input.appUserId,
        input.canAccessAllPublicTeams ? 1 : 0,
        input.createdAtMs,
      ],
    ).changes;
    const affected = new Set<string>();
    if (updated && !input.canAccessAllPublicTeams && previous?.canAccessAllPublicTeams !== false)
      for (const session of sessions(
        db,
        "organization_id = ? AND oauth_client_id = ? AND app_user_id = ?",
        [input.organizationId, input.oauthClientId, input.appUserId],
      ))
        affected.add(session);
    for (const [teams, allowed] of [
      [input.addedTeamIds, 1],
      [input.removedTeamIds, 0],
    ] as const) {
      for (const teamId of new Set(teams)) {
        const changed = db.run(
          `INSERT INTO linear_team_access (organization_id, oauth_client_id, app_user_id, team_id, allowed, observed_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (organization_id, oauth_client_id, app_user_id, team_id)
          DO UPDATE SET allowed = excluded.allowed, observed_at = excluded.observed_at
          WHERE linear_team_access.observed_at < excluded.observed_at
            OR (linear_team_access.observed_at = excluded.observed_at AND excluded.allowed = 0)`,
          [
            input.organizationId,
            input.oauthClientId,
            input.appUserId,
            teamId,
            allowed,
            input.createdAtMs,
          ],
        ).changes;
        if (allowed === 0 && changed)
          for (const session of sessions(
            db,
            "organization_id = ? AND oauth_client_id = ? AND app_user_id = ? AND team_id = ?",
            [input.organizationId, input.oauthClientId, input.appUserId, teamId],
          ))
            affected.add(session);
      }
    }
    return [...affected].sort();
  });
}

export function listLinearInstallationSessions(
  db: Database,
  scope: Pick<LinearInstallationScope, "organizationId" | "oauthClientId"> & { appUserId?: string },
): string[] {
  return sessions(
    db,
    "organization_id = ? AND oauth_client_id = ? AND (? IS NULL OR app_user_id = ?)",
    [scope.organizationId, scope.oauthClientId, scope.appUserId ?? null, scope.appUserId ?? null],
  );
}

export function getLinearInstallationPermissions(
  db: Database,
  scope: LinearInstallationScope,
): { canAccessAllPublicTeams: boolean; observedAtMs: number } | null {
  const row = db
    .query<{ all_public_teams: number; observed_at: number }, [string, string, string]>(
      "SELECT all_public_teams, observed_at FROM linear_installation_permission WHERE organization_id = ? AND oauth_client_id = ? AND app_user_id = ?",
    )
    .get(scope.organizationId, scope.oauthClientId, scope.appUserId);
  return row
    ? { canAccessAllPublicTeams: row.all_public_teams === 1, observedAtMs: row.observed_at }
    : null;
}

export function getLinearSessionInstallation(
  db: Database,
  sessionId: string,
): (LinearInstallationScope & { teamId: string | null; observedAtMs: number }) | null {
  const row = db
    .query<
      {
        organization_id: string | null;
        oauth_client_id: string | null;
        app_user_id: string | null;
        team_id: string | null;
        installation_observed_at: number | null;
      },
      [string]
    >(
      "SELECT organization_id, oauth_client_id, app_user_id, team_id, installation_observed_at FROM linear_session WHERE session_id = ?",
    )
    .get(sessionId);
  if (
    !row?.organization_id ||
    !row.oauth_client_id ||
    !row.app_user_id ||
    row.installation_observed_at === null
  )
    return null;
  return {
    organizationId: row.organization_id,
    oauthClientId: row.oauth_client_id,
    appUserId: row.app_user_id,
    teamId: row.team_id,
    observedAtMs: row.installation_observed_at,
  };
}

export function getLinearSessionAccess(db: Database, sessionId: string): LinearSessionAccess {
  const installation = getLinearSessionInstallation(db, sessionId);
  if (installation === null) return "unknown";
  if (
    db
      .query(
        "SELECT 1 FROM linear_app_revocation WHERE organization_id = ? AND oauth_client_id = ? AND restored_after IS NULL",
      )
      .get(installation.organizationId, installation.oauthClientId)
  )
    return "revoked";
  if (installation.teamId === null) return "unknown";
  return getLinearTeamAccess(db, { ...installation, teamId: installation.teamId }) === "removed"
    ? "team_removed"
    : "allowed";
}

export function getLinearTeamAccess(
  db: Database,
  input: LinearInstallationScope & { teamId: string },
): "allowed" | "removed" | "unknown" {
  const team = db
    .query<{ allowed: number }, [string, string, string, string]>(
      "SELECT allowed FROM linear_team_access WHERE organization_id = ? AND oauth_client_id = ? AND app_user_id = ? AND team_id = ?",
    )
    .get(input.organizationId, input.oauthClientId, input.appUserId, input.teamId);
  return team === null ? "unknown" : team.allowed === 0 ? "removed" : "allowed";
}

export function isLinearAppRevoked(
  db: Database,
  input: { oauthClientId: string | null; appUserId: string | null },
): boolean {
  const scopes =
    input.appUserId === null
      ? []
      : db
          .query<
            { organization_id: string; oauth_client_id: string },
            [string, string | null, string | null]
          >(`SELECT DISTINCT organization_id, oauth_client_id FROM linear_session
    WHERE app_user_id = ? AND organization_id IS NOT NULL AND oauth_client_id IS NOT NULL
    AND (? IS NULL OR oauth_client_id = ?)`)
          .all(input.appUserId, input.oauthClientId, input.oauthClientId);
  if (scopes.length > 0)
    return scopes.some(
      (scope) =>
        db
          .query(
            "SELECT 1 FROM linear_app_revocation WHERE organization_id = ? AND oauth_client_id = ? AND restored_after IS NULL",
          )
          .get(scope.organization_id, scope.oauth_client_id) !== null,
    );
  return (
    db
      .query(
        "SELECT 1 FROM linear_app_revocation WHERE (? IS NULL OR oauth_client_id = ?) AND restored_after IS NULL LIMIT 1",
      )
      .get(input.oauthClientId, input.oauthClientId) !== null
  );
}

export type LinearInstallationRevocation = {
  organizationId: string;
  oauthClientId: string;
  generation: number;
  revokedAtMs: number;
  appUserIds: string[];
};

export function listLinearInstallationRevocations(db: Database): LinearInstallationRevocation[] {
  return db
    .query<
      { organization_id: string; oauth_client_id: string; generation: number; revoked_at: number },
      []
    >(
      "SELECT * FROM linear_app_revocation WHERE restored_after IS NULL ORDER BY organization_id, oauth_client_id",
    )
    .all()
    .map((row) => ({
      organizationId: row.organization_id,
      oauthClientId: row.oauth_client_id,
      generation: row.generation,
      revokedAtMs: row.revoked_at,
      appUserIds: db
        .query<{ app_user_id: string }, [string, string]>(
          "SELECT DISTINCT app_user_id FROM linear_session WHERE organization_id = ? AND oauth_client_id = ? AND app_user_id IS NOT NULL ORDER BY app_user_id",
        )
        .all(row.organization_id, row.oauth_client_id)
        .map((user) => user.app_user_id),
    }));
}

export function restoreLinearInstallation(
  db: Database,
  input: LinearInstallationScope & {
    generation: number;
    grantStartedAtMs: number;
    credentialFingerprint: string;
  },
): boolean {
  validate(input.organizationId, input.oauthClientId, input.appUserId, input.credentialFingerprint);
  validateTime(input.grantStartedAtMs);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1)
    throw new Error("Linear revocation generation is invalid");
  return immediate(db, () => {
    const restored =
      db.run(
        `UPDATE linear_app_revocation SET restored_after = ?, restored_credential_fingerprint = ?
      WHERE organization_id = ? AND oauth_client_id = ? AND generation = ?
        AND restored_after IS NULL AND revoked_at < ?`,
        [
          input.grantStartedAtMs,
          input.credentialFingerprint,
          input.organizationId,
          input.oauthClientId,
          input.generation,
          input.grantStartedAtMs,
        ],
      ).changes === 1;
    if (restored)
      for (const sessionId of sessions(db, "organization_id = ? AND oauth_client_id = ?", [
        input.organizationId,
        input.oauthClientId,
      ]))
        dropLinearSessionDeliveries(db, sessionId);
    return restored;
  });
}

function recordEvent(db: Database, eventKey: string, createdAtMs: number): boolean {
  return (
    db.run(
      "INSERT INTO linear_access_event (event_key, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
      [eventKey, createdAtMs],
    ).changes === 1
  );
}

function sessions(db: Database, predicate: string, values: (string | null)[]): string[] {
  return db
    .query<{ session_id: string }, (string | null)[]>(
      `SELECT session_id FROM linear_session WHERE ${predicate} ORDER BY session_id`,
    )
    .all(...values)
    .map((row) => row.session_id);
}

function validate(...values: string[]): void {
  if (values.some((value) => value.trim() === ""))
    throw new Error("Linear access identity is missing");
}

function validateTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Linear access timestamp is invalid");
}
