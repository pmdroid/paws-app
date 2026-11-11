import { and, asc, eq, exists, inArray, isNotNull, not, sql, type SQL } from "drizzle-orm";
import type { Q, Steps, Db } from "./db";
import { workspaceMemberUsable, workspaceMemberSteps } from "./workspace";
import { teamRepositoryAllowedSql } from "./repository-catalog";
import { getLinearSessionAccessSteps } from "./linear-access";

export function sessionRepositoryAllowed(repository: SQL): SQL {
  const parts = teamRepositoryAllowedSql("workspace.id", "linear_session.team_id", "\0").split(
    "\0",
  );
  return sql.join(
    parts.map((part) => sql.raw(part)),
    repository,
  );
}

export function* workspaceSessionCandidatesSteps(
  q: Q,
  workspaceId: string,
  userId: string,
  clientId: string,
) {
  const { linearSession: s, workspace: w, workspaceUserTeam: t, workItem: i } = q.t;
  const r = q.t.workItemRepository;
  const member = yield* workspaceMemberSteps(q, workspaceId, userId);
  if (!workspaceMemberUsable(member)) return [];
  const onTeam = exists(
    q.orm
      .select({ one: sql`1` })
      .from(t)
      .where(and(eq(t.workspaceId, w.id), eq(t.userId, userId), eq(t.teamId, s.teamId))),
  );
  const outsideScope = exists(
    q.orm
      .select({ one: sql`1` })
      .from(i)
      .innerJoin(r, eq(r.itemId, i.id))
      .where(
        and(
          eq(i.sessionKey, s.sessionId),
          not(sessionRepositoryAllowed(sql`lower(${r.owner} || '/' || ${r.repo})`)),
        ),
      ),
  );
  const rows = yield* q.all(
    q.orm
      .select({ sessionId: s.sessionId })
      .from(s)
      .innerJoin(w, eq(w.linearOrganizationId, s.organizationId))
      .where(
        and(
          eq(w.id, workspaceId),
          eq(s.oauthClientId, clientId),
          isNotNull(s.installationObservedAt),
          isNotNull(s.teamId),
          member.role === "admin" ? undefined : onTeam,
          not(outsideScope),
        ),
      )
      .orderBy(asc(s.sessionId)),
  );
  return rows.map((row) => row.sessionId);
}

export function* workspaceSessionIdsSteps(
  q: Q,
  workspaceId: string,
  userId: string,
  clientId: string,
): Steps<string[]> {
  const ids: string[] = [];
  for (const id of yield* workspaceSessionCandidatesSteps(q, workspaceId, userId, clientId))
    if ((yield* getLinearSessionAccessSteps(q, id)) === "allowed") ids.push(id);
  return ids;
}

export function workspaceSessionIds(
  store: Db,
  workspaceId: string,
  userId: string,
  clientId: string,
): Promise<string[]> {
  return store.run((q) => workspaceSessionIdsSteps(q, workspaceId, userId, clientId));
}

export function* sessionRepositoriesAllowedSteps(
  q: Q,
  sessionIds: readonly string[],
  repositories: readonly string[],
) {
  const { linearSession: s, workspace: w } = q.t;
  const allowed = new Set<string>();
  if (sessionIds.length === 0) return allowed;
  for (const repository of repositories) {
    const row = yield* q.one(
      q.orm
        .select({ one: sql`1` })
        .from(s)
        .innerJoin(w, eq(w.linearOrganizationId, s.organizationId))
        .where(
          and(
            inArray(s.sessionId, [...sessionIds]),
            isNotNull(s.teamId),
            sessionRepositoryAllowed(sql`lower(${repository})`),
          ),
        )
        .limit(1),
    );
    if (row !== undefined) allowed.add(repository);
  }
  return allowed;
}

export async function sessionRepositoriesAllowed(
  store: Db,
  sessionIds: readonly string[],
  repositories: readonly string[],
): Promise<Set<string>> {
  return store.run((q) => sessionRepositoriesAllowedSteps(q, sessionIds, repositories));
}

/** Whether the session belongs to the workspace and its team may use the repository. */
export function* workspaceSessionRepositoryAllowedSteps(
  q: Q,
  workspaceId: string,
  sessionId: string,
  repository: string,
) {
  const { linearSession: s, workspace: w } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(w)
      .innerJoin(s, eq(s.organizationId, w.linearOrganizationId))
      .where(
        and(
          eq(w.id, workspaceId),
          eq(s.sessionId, sessionId),
          sessionRepositoryAllowed(sql`lower(${repository})`),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export async function workspaceSessionRepositoryAllowed(
  store: Db,
  workspaceId: string,
  sessionId: string,
  repository: string,
): Promise<boolean> {
  return store.run((q) =>
    workspaceSessionRepositoryAllowedSteps(q, workspaceId, sessionId, repository),
  );
}
