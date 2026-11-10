import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { ensureLinearSessionSteps } from "./linear-sessions";

export type LinearInstallationScope = {
  organizationId: string;
  oauthClientId: string;
  appUserId: string;
};

export type LinearSessionAccess = "allowed" | "revoked" | "team_removed" | "unknown";

type LinearNotification = LinearInstallationScope & { notificationId: string; createdAtMs: number };

export function* hasLinearNotificationSteps(q: Q, input: LinearNotification): Steps<boolean> {
  const { linearAccessEvent } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(linearAccessEvent)
      .where(eq(linearAccessEvent.eventKey, notificationKey(input))),
  );
  return row !== undefined;
}

export async function hasLinearNotification(
  store: Db,
  input: LinearNotification,
): Promise<boolean> {
  return store.run((q) => hasLinearNotificationSteps(q, input));
}

export function* recordLinearNotificationSteps(q: Q, input: LinearNotification): Steps<boolean> {
  return yield* recordEventSteps(q, notificationKey(input), input.createdAtMs);
}

export async function recordLinearNotification(
  store: Db,
  input: LinearNotification,
): Promise<boolean> {
  return store.run((q) => recordLinearNotificationSteps(q, input));
}

function notificationKey(input: LinearNotification): string {
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

export function* dropLinearSessionDeliveriesSteps(q: Q, sessionId: string): Steps<void> {
  const { outbox } = q.t;
  yield* q.exec(
    q.orm
      .update(outbox)
      .set({ status: "dropped", error: "Linear installation access was revoked." })
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, sessionId),
          inArray(outbox.status, ["pending", "dead"]),
        ),
      ),
  );
}

export async function dropLinearSessionDeliveries(store: Db, sessionId: string): Promise<void> {
  await store.run((q) => dropLinearSessionDeliveriesSteps(q, sessionId));
}

type LinearInstallationObservation = LinearInstallationScope & {
  sessionId: string;
  teamId: string | null;
  observedAtMs: number;
};

export function* recordLinearInstallationSteps(
  q: Q,
  input: LinearInstallationObservation,
): Steps<void> {
  validate(input.organizationId, input.oauthClientId, input.appUserId, input.sessionId);
  validateTime(input.observedAtMs);
  if (input.teamId !== null) validate(input.teamId);
  const { linearSession } = q.t;
  yield* ensureLinearSessionSteps(q, input);
  const current = (yield* q.one(
    q.orm
      .select({
        oauthClientId: linearSession.oauthClientId,
        teamId: linearSession.teamId,
        installationObservedAt: linearSession.installationObservedAt,
      })
      .from(linearSession)
      .where(eq(linearSession.sessionId, input.sessionId)),
  ))!;
  if (current.oauthClientId !== null && current.oauthClientId !== input.oauthClientId)
    throw new Error("Linear session OAuth client ownership changed");
  if (current.installationObservedAt !== null) {
    if (current.installationObservedAt > input.observedAtMs) return;
    if (current.installationObservedAt === input.observedAtMs) {
      if (input.teamId === null) return;
      if (current.teamId !== null && current.teamId !== input.teamId)
        throw new Error("Linear session team observations conflict");
    }
  }
  yield* q.exec(
    q.orm
      .update(linearSession)
      .set({
        oauthClientId: input.oauthClientId,
        teamId: input.teamId,
        installationObservedAt: input.observedAtMs,
      })
      .where(eq(linearSession.sessionId, input.sessionId)),
  );
}

export function recordLinearInstallation(db: Database, input: LinearInstallationObservation): void {
  settled(sqliteDb(db).transaction((q) => recordLinearInstallationSteps(q, input)));
}

type LinearRevocationEvent = {
  eventKey: string;
  organizationId: string;
  oauthClientId: string;
  createdAtMs: number;
};

export function* revokeLinearInstallationSteps(
  q: Q,
  input: LinearRevocationEvent,
): Steps<string[]> {
  validate(input.eventKey, input.organizationId, input.oauthClientId);
  validateTime(input.createdAtMs);
  const { linearAppRevocation, linearSession } = q.t;
  if (!(yield* recordEventSteps(q, input.eventKey, input.createdAtMs))) return [];
  const later = q.dialect === "sqlite" ? sql`MAX` : sql`GREATEST`;
  const changed = yield* q.all(
    q.orm
      .insert(linearAppRevocation)
      .values({
        organizationId: input.organizationId,
        oauthClientId: input.oauthClientId,
        revokedAt: input.createdAtMs,
      })
      .onConflictDoUpdate({
        target: [linearAppRevocation.organizationId, linearAppRevocation.oauthClientId],
        set: {
          revokedAt: sql`${later}(${linearAppRevocation.revokedAt}, excluded.revoked_at)`,
          generation: sql`${linearAppRevocation.generation} + 1`,
          restoredAfter: null,
          restoredCredentialFingerprint: null,
        },
        setWhere: sql`${linearAppRevocation.restoredAfter} IS NULL
          OR excluded.revoked_at >= ${linearAppRevocation.restoredAfter}`,
      })
      .returning({ organizationId: linearAppRevocation.organizationId }),
  );
  if (changed.length === 0) return [];
  return yield* sessionsSteps(
    q,
    and(
      eq(linearSession.organizationId, input.organizationId),
      eq(linearSession.oauthClientId, input.oauthClientId),
    ),
  );
}

export function revokeLinearInstallation(db: Database, input: LinearRevocationEvent): string[] {
  return settled(sqliteDb(db).transaction((q) => revokeLinearInstallationSteps(q, input)));
}

type LinearTeamAccessChange = LinearInstallationScope & {
  eventKey: string;
  createdAtMs: number;
  canAccessAllPublicTeams: boolean;
  addedTeamIds: readonly string[];
  removedTeamIds: readonly string[];
};

export function* changeLinearTeamAccessSteps(q: Q, input: LinearTeamAccessChange): Steps<string[]> {
  validate(input.eventKey, input.organizationId, input.oauthClientId, input.appUserId);
  validateTime(input.createdAtMs);
  validate(...input.addedTeamIds, ...input.removedTeamIds);
  if (input.addedTeamIds.some((team) => input.removedTeamIds.includes(team)))
    throw new Error("Linear team access change contradicts itself");
  const { linearInstallationPermission: permission, linearSession, linearTeamAccess } = q.t;
  if (!(yield* recordEventSteps(q, input.eventKey, input.createdAtMs))) return [];
  const previous = yield* getLinearInstallationPermissionsSteps(q, input);
  const updated = yield* q.all(
    q.orm
      .insert(permission)
      .values({
        organizationId: input.organizationId,
        oauthClientId: input.oauthClientId,
        appUserId: input.appUserId,
        allPublicTeams: input.canAccessAllPublicTeams ? 1 : 0,
        observedAt: input.createdAtMs,
      })
      .onConflictDoUpdate({
        target: [permission.organizationId, permission.oauthClientId, permission.appUserId],
        set: {
          allPublicTeams: sql`excluded.all_public_teams`,
          observedAt: sql`excluded.observed_at`,
        },
        setWhere: sql`${permission.observedAt} < excluded.observed_at
          OR (${permission.observedAt} = excluded.observed_at AND excluded.all_public_teams = 0)`,
      })
      .returning({ appUserId: permission.appUserId }),
  );
  const installation = and(
    eq(linearSession.organizationId, input.organizationId),
    eq(linearSession.oauthClientId, input.oauthClientId),
    eq(linearSession.appUserId, input.appUserId),
  );
  const affected = new Set<string>();
  if (
    updated.length > 0 &&
    !input.canAccessAllPublicTeams &&
    previous?.canAccessAllPublicTeams !== false
  )
    for (const session of yield* sessionsSteps(q, installation)) affected.add(session);
  for (const [teams, allowed] of [
    [input.addedTeamIds, 1],
    [input.removedTeamIds, 0],
  ] as const) {
    for (const teamId of new Set(teams)) {
      const changed = yield* q.all(
        q.orm
          .insert(linearTeamAccess)
          .values({
            organizationId: input.organizationId,
            oauthClientId: input.oauthClientId,
            appUserId: input.appUserId,
            teamId,
            allowed,
            observedAt: input.createdAtMs,
          })
          .onConflictDoUpdate({
            target: [
              linearTeamAccess.organizationId,
              linearTeamAccess.oauthClientId,
              linearTeamAccess.appUserId,
              linearTeamAccess.teamId,
            ],
            set: { allowed: sql`excluded.allowed`, observedAt: sql`excluded.observed_at` },
            setWhere: sql`${linearTeamAccess.observedAt} < excluded.observed_at
              OR (${linearTeamAccess.observedAt} = excluded.observed_at AND excluded.allowed = 0)`,
          })
          .returning({ teamId: linearTeamAccess.teamId }),
      );
      if (allowed === 0 && changed.length > 0)
        for (const session of yield* sessionsSteps(
          q,
          and(installation, eq(linearSession.teamId, teamId)),
        ))
          affected.add(session);
    }
  }
  return [...affected].sort();
}

export function changeLinearTeamAccess(db: Database, input: LinearTeamAccessChange): string[] {
  return settled(sqliteDb(db).transaction((q) => changeLinearTeamAccessSteps(q, input)));
}

type LinearInstallationSessionsScope = Pick<
  LinearInstallationScope,
  "organizationId" | "oauthClientId"
> & { appUserId?: string };

export function* listLinearInstallationSessionsSteps(
  q: Q,
  scope: LinearInstallationSessionsScope,
): Steps<string[]> {
  const { linearSession } = q.t;
  return yield* sessionsSteps(
    q,
    and(
      eq(linearSession.organizationId, scope.organizationId),
      eq(linearSession.oauthClientId, scope.oauthClientId),
      scope.appUserId === undefined ? undefined : eq(linearSession.appUserId, scope.appUserId),
    ),
  );
}

export async function listLinearInstallationSessions(
  store: Db,
  scope: LinearInstallationSessionsScope,
): Promise<string[]> {
  return store.run((q) => listLinearInstallationSessionsSteps(q, scope));
}

type LinearInstallationPermissions = { canAccessAllPublicTeams: boolean; observedAtMs: number };

export function* getLinearInstallationPermissionsSteps(
  q: Q,
  scope: LinearInstallationScope,
): Steps<LinearInstallationPermissions | null> {
  const permission = q.t.linearInstallationPermission;
  const row = yield* q.one(
    q.orm
      .select({ allPublicTeams: permission.allPublicTeams, observedAt: permission.observedAt })
      .from(permission)
      .where(
        and(
          eq(permission.organizationId, scope.organizationId),
          eq(permission.oauthClientId, scope.oauthClientId),
          eq(permission.appUserId, scope.appUserId),
        ),
      ),
  );
  return row
    ? { canAccessAllPublicTeams: row.allPublicTeams === 1, observedAtMs: row.observedAt }
    : null;
}

export async function getLinearInstallationPermissions(
  store: Db,
  scope: LinearInstallationScope,
): Promise<LinearInstallationPermissions | null> {
  return store.run((q) => getLinearInstallationPermissionsSteps(q, scope));
}

type LinearSessionInstallation = LinearInstallationScope & {
  teamId: string | null;
  observedAtMs: number;
};

export function* getLinearSessionInstallationSteps(
  q: Q,
  sessionId: string,
): Steps<LinearSessionInstallation | null> {
  const { linearSession } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        organizationId: linearSession.organizationId,
        oauthClientId: linearSession.oauthClientId,
        appUserId: linearSession.appUserId,
        teamId: linearSession.teamId,
        observedAtMs: linearSession.installationObservedAt,
      })
      .from(linearSession)
      .where(eq(linearSession.sessionId, sessionId)),
  );
  if (!row?.organizationId || !row.oauthClientId || !row.appUserId || row.observedAtMs === null)
    return null;
  return {
    organizationId: row.organizationId,
    oauthClientId: row.oauthClientId,
    appUserId: row.appUserId,
    teamId: row.teamId,
    observedAtMs: row.observedAtMs,
  };
}

export function getLinearSessionInstallation(
  db: Database,
  sessionId: string,
): LinearSessionInstallation | null {
  return settled(sqliteDb(db).run((q) => getLinearSessionInstallationSteps(q, sessionId)));
}

export function* getLinearSessionAccessSteps(q: Q, sessionId: string): Steps<LinearSessionAccess> {
  const installation = yield* getLinearSessionInstallationSteps(q, sessionId);
  if (installation === null) return "unknown";
  if (yield* unrestoredSteps(q, installation.organizationId, installation.oauthClientId))
    return "revoked";
  if (installation.teamId === null) return "unknown";
  const team = yield* getLinearTeamAccessSteps(q, { ...installation, teamId: installation.teamId });
  return team === "removed" ? "team_removed" : "allowed";
}

export function getLinearSessionAccess(db: Database, sessionId: string): LinearSessionAccess {
  return settled(sqliteDb(db).run((q) => getLinearSessionAccessSteps(q, sessionId)));
}

type LinearTeamAccess = "allowed" | "removed" | "unknown";

export function* getLinearTeamAccessSteps(
  q: Q,
  input: LinearInstallationScope & { teamId: string },
): Steps<LinearTeamAccess> {
  const { linearTeamAccess } = q.t;
  const team = yield* q.one(
    q.orm
      .select({ allowed: linearTeamAccess.allowed })
      .from(linearTeamAccess)
      .where(
        and(
          eq(linearTeamAccess.organizationId, input.organizationId),
          eq(linearTeamAccess.oauthClientId, input.oauthClientId),
          eq(linearTeamAccess.appUserId, input.appUserId),
          eq(linearTeamAccess.teamId, input.teamId),
        ),
      ),
  );
  return team === undefined ? "unknown" : team.allowed === 0 ? "removed" : "allowed";
}

export function getLinearTeamAccess(
  db: Database,
  input: LinearInstallationScope & { teamId: string },
): LinearTeamAccess {
  return settled(sqliteDb(db).run((q) => getLinearTeamAccessSteps(q, input)));
}

type LinearAppIdentity = { oauthClientId: string | null; appUserId: string | null };

export function* isLinearAppRevokedSteps(q: Q, input: LinearAppIdentity): Steps<boolean> {
  const { linearAppRevocation, linearSession } = q.t;
  const client =
    input.oauthClientId === null ? undefined : eq(linearSession.oauthClientId, input.oauthClientId);
  const scopes =
    input.appUserId === null
      ? []
      : yield* q.all(
          q.orm
            .selectDistinct({
              organizationId: sql<string>`${linearSession.organizationId}`,
              oauthClientId: sql<string>`${linearSession.oauthClientId}`,
            })
            .from(linearSession)
            .where(
              and(
                eq(linearSession.appUserId, input.appUserId),
                isNotNull(linearSession.organizationId),
                isNotNull(linearSession.oauthClientId),
                client,
              ),
            ),
        );
  if (scopes.length > 0) {
    for (const scope of scopes)
      if (yield* unrestoredSteps(q, scope.organizationId, scope.oauthClientId)) return true;
    return false;
  }
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(linearAppRevocation)
      .where(
        and(
          input.oauthClientId === null
            ? undefined
            : eq(linearAppRevocation.oauthClientId, input.oauthClientId),
          isNull(linearAppRevocation.restoredAfter),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function isLinearAppRevoked(db: Database, input: LinearAppIdentity): boolean {
  return settled(sqliteDb(db).run((q) => isLinearAppRevokedSteps(q, input)));
}

function* unrestoredSteps(q: Q, organizationId: string, oauthClientId: string): Steps<boolean> {
  const { linearAppRevocation } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(linearAppRevocation)
      .where(
        and(
          eq(linearAppRevocation.organizationId, organizationId),
          eq(linearAppRevocation.oauthClientId, oauthClientId),
          isNull(linearAppRevocation.restoredAfter),
        ),
      ),
  );
  return row !== undefined;
}

export type LinearInstallationRevocation = {
  organizationId: string;
  oauthClientId: string;
  generation: number;
  revokedAtMs: number;
  appUserIds: string[];
};

export function* listLinearInstallationRevocationsSteps(
  q: Q,
): Steps<LinearInstallationRevocation[]> {
  const { linearAppRevocation, linearSession } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(linearAppRevocation)
      .where(isNull(linearAppRevocation.restoredAfter))
      .orderBy(asc(linearAppRevocation.organizationId), asc(linearAppRevocation.oauthClientId)),
  );
  const revocations: LinearInstallationRevocation[] = [];
  for (const row of rows) {
    const users = yield* q.all(
      q.orm
        .selectDistinct({ appUserId: sql<string>`${linearSession.appUserId}` })
        .from(linearSession)
        .where(
          and(
            eq(linearSession.organizationId, row.organizationId),
            eq(linearSession.oauthClientId, row.oauthClientId),
            isNotNull(linearSession.appUserId),
          ),
        )
        .orderBy(asc(linearSession.appUserId)),
    );
    revocations.push({
      organizationId: row.organizationId,
      oauthClientId: row.oauthClientId,
      generation: row.generation,
      revokedAtMs: row.revokedAt,
      appUserIds: users.map((user) => user.appUserId),
    });
  }
  return revocations;
}

export function listLinearInstallationRevocations(db: Database): LinearInstallationRevocation[] {
  return settled(sqliteDb(db).run((q) => listLinearInstallationRevocationsSteps(q)));
}

type LinearInstallationRestore = LinearInstallationScope & {
  generation: number;
  grantStartedAtMs: number;
  credentialFingerprint: string;
};

export function* restoreLinearInstallationSteps(
  q: Q,
  input: LinearInstallationRestore,
): Steps<boolean> {
  validate(input.organizationId, input.oauthClientId, input.appUserId, input.credentialFingerprint);
  validateTime(input.grantStartedAtMs);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1)
    throw new Error("Linear revocation generation is invalid");
  const { linearAppRevocation, linearSession } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(linearAppRevocation)
      .set({
        restoredAfter: input.grantStartedAtMs,
        restoredCredentialFingerprint: input.credentialFingerprint,
      })
      .where(
        and(
          eq(linearAppRevocation.organizationId, input.organizationId),
          eq(linearAppRevocation.oauthClientId, input.oauthClientId),
          eq(linearAppRevocation.generation, input.generation),
          isNull(linearAppRevocation.restoredAfter),
          lt(linearAppRevocation.revokedAt, input.grantStartedAtMs),
        ),
      )
      .returning({ organizationId: linearAppRevocation.organizationId }),
  );
  const restored = rows.length === 1;
  if (restored)
    for (const sessionId of yield* sessionsSteps(
      q,
      and(
        eq(linearSession.organizationId, input.organizationId),
        eq(linearSession.oauthClientId, input.oauthClientId),
      ),
    ))
      yield* dropLinearSessionDeliveriesSteps(q, sessionId);
  return restored;
}

export function restoreLinearInstallation(db: Database, input: LinearInstallationRestore): boolean {
  return settled(sqliteDb(db).transaction((q) => restoreLinearInstallationSteps(q, input)));
}

function* recordEventSteps(q: Q, eventKey: string, createdAtMs: number): Steps<boolean> {
  const { linearAccessEvent } = q.t;
  const rows = yield* q.all(
    q.orm
      .insert(linearAccessEvent)
      .values({ eventKey, createdAt: createdAtMs })
      .onConflictDoNothing()
      .returning({ eventKey: linearAccessEvent.eventKey }),
  );
  return rows.length === 1;
}

function* sessionsSteps(q: Q, predicate: SQL | undefined): Steps<string[]> {
  const { linearSession } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ sessionId: linearSession.sessionId })
      .from(linearSession)
      .where(predicate)
      .orderBy(asc(linearSession.sessionId)),
  );
  return rows.map((row) => row.sessionId);
}

function validate(...values: string[]): void {
  if (values.some((value) => value.trim() === ""))
    throw new Error("Linear access identity is missing");
}

function validateTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Linear access timestamp is invalid");
}
