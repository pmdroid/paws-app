import type { Database } from "bun:sqlite";
import { and, asc, count, eq, gt, lte } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import {
  auditWorkspaceAccessSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  workspaceMemberUsableWhere,
  syncWorkspaceMemberSteps,
  type WorkspaceRole,
} from "./workspace";

export type WorkspaceOAuthRequest = {
  stateHash: string;
  browserHash: string;
  bootstrapHash: string | null;
  assignmentHash?: string | null;
  expiresAt: number;
};

export function* saveWorkspaceOAuthRequestSteps(
  q: Q,
  input: WorkspaceOAuthRequest,
): Steps<boolean> {
  const { workspaceOauthRequest: request } = q.t;
  yield* q.exec(q.orm.delete(request).where(lte(request.expiresAt, input.expiresAt - 600_000)));
  const stored = yield* q.one(q.orm.select({ count: count() }).from(request));
  if (stored!.count >= 1_000) return false;
  yield* q.exec(
    q.orm.insert(request).values({
      stateHash: input.stateHash,
      browserHash: input.browserHash,
      verifier: "",
      bootstrapHash: input.bootstrapHash,
      expiresAt: input.expiresAt,
      assignmentHash: input.assignmentHash ?? null,
    }),
  );
  return true;
}

export async function saveWorkspaceOAuthRequest(
  store: Db,
  input: WorkspaceOAuthRequest,
): Promise<boolean> {
  return store.transaction((q) => saveWorkspaceOAuthRequestSteps(q, input));
}

export function* consumeWorkspaceOAuthRequestSteps(
  q: Q,
  stateHash: string,
  browserHash: string,
  now: number,
): Steps<WorkspaceOAuthRequest | null> {
  const { workspaceOauthRequest: request } = q.t;
  const row = yield* q.one(
    q.orm
      .delete(request)
      .where(
        and(
          eq(request.stateHash, stateHash),
          eq(request.browserHash, browserHash),
          gt(request.expiresAt, now),
        ),
      )
      .returning({
        stateHash: request.stateHash,
        browserHash: request.browserHash,
        bootstrapHash: request.bootstrapHash,
        assignmentHash: request.assignmentHash,
        expiresAt: request.expiresAt,
      }),
  );
  return row ?? null;
}

export async function consumeWorkspaceOAuthRequest(
  store: Db,
  stateHash: string,
  browserHash: string,
  now: number,
): Promise<WorkspaceOAuthRequest | null> {
  return store.run((q) => consumeWorkspaceOAuthRequestSteps(q, stateHash, browserHash, now));
}

export function* listUserWorkspacesSteps(q: Q, userId: string) {
  const { workspace: w, workspaceMember: m } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: w.id, name: w.name, role: m.role })
      .from(w)
      .innerJoin(m, eq(m.workspaceId, w.id))
      .where(and(eq(m.userId, userId), workspaceMemberUsableWhere(m)))
      .orderBy(asc(w.name), asc(w.id)),
  );
  return rows as { id: string; name: string; role: WorkspaceRole }[];
}

export async function listUserWorkspaces(store: Db, userId: string) {
  return store.run((q) => listUserWorkspacesSteps(q, userId));
}

export function* listWorkspaceMembersSteps(q: Q, workspaceId: string) {
  const { workspaceMember: m, workspaceUser: u } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: u.id,
        name: u.name,
        role: m.role,
        active: m.active,
        revokedAt: m.revokedAt,
        revokedBy: m.revokedBy,
      })
      .from(m)
      .innerJoin(u, eq(u.id, m.userId))
      .where(eq(m.workspaceId, workspaceId))
      .orderBy(asc(u.name), asc(u.id)),
  );
  return rows as ((typeof rows)[number] & { role: WorkspaceRole })[];
}

export async function listWorkspaceMembers(store: Db, workspaceId: string) {
  return store.run((q) => listWorkspaceMembersSteps(q, workspaceId));
}

export function* requireWorkspaceAdminSteps(
  q: Q,
  workspaceId: string,
  actorId: string,
): Steps<void> {
  const actor = yield* workspaceMemberSteps(q, workspaceId, actorId);
  if (actor?.role !== "admin" || !workspaceMemberUsable(actor))
    throw new Error("Workspace administration is required.");
}

type RoleChange = {
  workspaceId: string;
  actorId: string;
  userId: string;
  role: WorkspaceRole;
  now: number;
};

export function* setWorkspaceRoleSteps(q: Q, input: RoleChange): Steps<void> {
  const { workspaceMember: m } = q.t;
  const member = yield* workspaceMemberSteps(q, input.workspaceId, input.userId);
  if (member === null || !workspaceMemberUsable(member))
    throw new Error("An active workspace member is required.");
  if (member.role === "admin" && input.role !== "admin") {
    const admins = yield* q.one(
      q.orm
        .select({ count: count() })
        .from(m)
        .where(
          and(
            eq(m.workspaceId, input.workspaceId),
            eq(m.role, "admin"),
            workspaceMemberUsableWhere(m),
          ),
        ),
    );
    if (admins!.count <= 1) throw new Error("The workspace must keep an active admin.");
  }
  yield* q.exec(
    q.orm
      .update(m)
      .set({ role: input.role, manualRole: input.role, source: "manual" })
      .where(and(eq(m.workspaceId, input.workspaceId), eq(m.userId, input.userId))),
  );
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: input.workspaceId,
    userId: input.actorId,
    action: "member.role.changed",
    subject: `${input.userId}:${input.role}`,
    now: input.now,
  });
}

type RoleChangeInput = RoleChange & {
  verified?: { active: boolean; guest: boolean; teamIds: readonly string[] };
};

export function* changeWorkspaceRoleSteps(q: Q, input: RoleChangeInput) {
  yield* requireWorkspaceAdminSteps(q, input.workspaceId, input.actorId);
  if (input.verified !== undefined) {
    if (
      !(yield* syncWorkspaceMemberSteps(q, {
        ...input,
        active: input.verified.active && !input.verified.guest,
        role: "member",
        teamIds: input.verified.teamIds,
      }))
    )
      throw new Error("Linear membership changed. Try again.");
    if (input.verified.guest) return "Linear guests can't use Paws.";
    if (!input.verified.active) return "Current Linear membership is required.";
  }
  yield* setWorkspaceRoleSteps(q, input);
  return null;
}

export function changeWorkspaceRole(db: Database, input: RoleChangeInput): void {
  const error = settled(sqliteDb(db).transaction((q) => changeWorkspaceRoleSteps(q, input)));
  if (error !== null) throw new Error(error);
}

type RepositoriesChange = {
  workspaceId: string;
  actorId: string;
  repositories: readonly { repository: string; teamId: string }[];
  now: number;
};

export function* replaceWorkspaceRepositoriesSteps(q: Q, input: RepositoriesChange): Steps<void> {
  const { workspaceRepository: repository } = q.t;
  yield* requireWorkspaceAdminSteps(q, input.workspaceId, input.actorId);
  yield* q.exec(q.orm.delete(repository).where(eq(repository.workspaceId, input.workspaceId)));
  for (const entry of input.repositories)
    yield* q.exec(
      q.orm.insert(repository).values({
        workspaceId: input.workspaceId,
        repository: entry.repository,
        teamId: entry.teamId,
      }),
    );
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: input.workspaceId,
    userId: input.actorId,
    action: "repositories.changed",
    subject: input.workspaceId,
    now: input.now,
  });
}

export function replaceWorkspaceRepositories(db: Database, input: RepositoriesChange): void {
  settled(sqliteDb(db).transaction((q) => replaceWorkspaceRepositoriesSteps(q, input)));
}

/**
 * Every repository a workspace can use, `owner/repo`: the ones mapped to its Linear teams and the
 * ones its stored GitHub App connection approved. Without `workspaceId`, every workspace's.
 */
export function* listWorkspaceRepositoryNamesSteps(q: Q, workspaceId?: string): Steps<string[]> {
  const { workspaceGithubConnection: connection, workspaceRepository: repository } = q.t;
  const mapped = yield* q.all(
    q.orm
      .select({ repository: repository.repository })
      .from(repository)
      .where(workspaceId === undefined ? undefined : eq(repository.workspaceId, workspaceId))
      .orderBy(asc(repository.repository)),
  );
  const connections = yield* q.all(
    q.orm
      .select({ repositories: connection.repositories })
      .from(connection)
      .where(workspaceId === undefined ? undefined : eq(connection.workspaceId, workspaceId))
      .orderBy(asc(connection.workspaceId)),
  );
  const connected = connections.flatMap((row) => {
    try {
      const names: unknown = JSON.parse(row.repositories);
      return Array.isArray(names)
        ? names.filter((name): name is string => typeof name === "string")
        : [];
    } catch {
      return [];
    }
  });
  const seen = new Set<string>();
  return [...mapped.map((row) => row.repository), ...connected].filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function listWorkspaceRepositoryNames(
  store: Db,
  workspaceId?: string,
): Promise<string[]> {
  return store.run((q) => listWorkspaceRepositoryNamesSteps(q, workspaceId));
}

export function* listWorkspaceRepositoriesSteps(q: Q, workspaceId: string) {
  const { workspaceRepository: repository } = q.t;
  return yield* q.all(
    q.orm
      .select({ repository: repository.repository, teamId: repository.teamId })
      .from(repository)
      .where(eq(repository.workspaceId, workspaceId))
      .orderBy(asc(repository.repository), asc(repository.teamId)),
  );
}

export async function listWorkspaceRepositories(store: Db, workspaceId: string) {
  return store.run((q) => listWorkspaceRepositoriesSteps(q, workspaceId));
}

export function* distinctWorkspaceRepositoriesSteps(q: Q) {
  const { workspaceRepository: repository } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ repository: repository.repository })
      .from(repository)
      .orderBy(asc(repository.repository)),
  );
  return rows.map((row) => row.repository);
}

export async function distinctWorkspaceRepositories(store: Db): Promise<string[]> {
  return store.run((q) => distinctWorkspaceRepositoriesSteps(q));
}
