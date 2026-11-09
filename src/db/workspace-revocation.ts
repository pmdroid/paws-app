import type { Database } from "bun:sqlite";
import { and, asc, count, eq, inArray, isNull, max, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { TERMINAL_WORK_ITEM_STATES } from "../core";
import { applyLinearCommand } from "./commands";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { delegatedLinearUserIdSql } from "./linear-sessions";
import { immediate } from "./tx";
import {
  auditWorkspaceAccess,
  workspaceMember,
  WORKSPACE_REVOKED_RESPONSE,
  type WorkspaceRole,
} from "./workspace";
import { requireWorkspaceAdminSteps } from "./workspace-auth";

type RevocationChange = {
  workspaceId: string;
  actorId: string;
  userId: string;
  revoked: boolean;
  now: number;
};

/** Persist the access cut-off and stop its work in the same write transaction. */
export function changeWorkspaceRevocation(db: Database, input: RevocationChange): string[] {
  return immediate(db, () => {
    const queries = sqliteDb(db);
    settled(queries.run((q) => requireWorkspaceAdminSteps(q, input.workspaceId, input.actorId)));
    const member = workspaceMember(db, input.workspaceId, input.userId);
    if (!member) throw new Error("Choose a workspace member.");
    if (input.revoked && input.actorId === input.userId)
      throw new Error("You cannot revoke your own access.");
    // The usable admin actor remains; refusing self-revocation also protects the last admin.
    if ((member.revokedAt !== null) === input.revoked) return [];
    settled(queries.run((q) => recordWorkspaceRevocationSteps(q, input)));
    const stopped: string[] = [];
    if (input.revoked) {
      const items = settled(
        queries.run((q) =>
          memberOpenItemsSteps(q, input.workspaceId, input.userId, member.linearUserId),
        ),
      );
      for (const item of items) {
        const result = applyLinearCommand(
          db,
          {
            type: "stop",
            source: "dashboard",
            itemId: item.id,
            requestedAt: input.now,
          },
          input.now,
          WORKSPACE_REVOKED_RESPONSE,
          { responseOnly: true, keepPullRequest: true },
        );
        // A merge call in flight queues the Stop durably; it applies once GitHub answers.
        if (result.deferred) continue;
        if (!result.applied)
          throw new Error("Work changed before access could be revoked. Try again.");
        stopped.push(item.id);
      }
    }
    auditWorkspaceAccess(db, {
      ...input,
      userId: input.actorId,
      subject: input.userId,
      action: input.revoked ? "workspace.member_revoked" : "workspace.member_restored",
    });
    return stopped;
  });
}

export function* recordWorkspaceRevocationSteps(q: Q, input: RevocationChange): Steps<void> {
  const { memberVm, runner, workspaceMember: m } = q.t;
  yield* q.exec(
    q.orm
      .update(m)
      .set({
        revokedAt: input.revoked ? input.now : null,
        revokedBy: input.revoked ? input.actorId : null,
      })
      .where(and(eq(m.workspaceId, input.workspaceId), eq(m.userId, input.userId))),
  );
  if (!input.revoked) return;
  yield* q.exec(
    q.orm
      .update(memberVm)
      .set({ runnerId: null, updatedAt: input.now })
      .where(
        inArray(
          memberVm.runnerId,
          q.orm
            .select({ id: runner.id })
            .from(runner)
            .where(
              and(eq(runner.workspaceId, input.workspaceId), eq(runner.ownerUserId, input.userId)),
            ),
        ),
      ),
  );
}

export function* memberOpenItemsSteps(
  q: Q,
  workspaceId: string,
  userId: string,
  linearUserId: string,
): Steps<{ id: string }[]> {
  const { linearSession: s, workItem: i, workspace: w } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: i.id })
      .from(i)
      .leftJoin(s, eq(s.sessionId, i.sessionKey))
      .innerJoin(w, eq(w.id, workspaceId))
      .where(
        and(
          or(isNull(s.organizationId), eq(s.organizationId, w.linearOrganizationId)),
          or(
            eq(i.ownerUserId, userId),
            and(
              isNull(i.ownerUserId),
              sql`${sql.raw(delegatedLinearUserIdSql("work_item", "linear_session"))}=${linearUserId}`,
            ),
          ),
          notInArray(i.state, [...TERMINAL_WORK_ITEM_STATES, "manual"]),
        ),
      )
      .orderBy(asc(i.id)),
  );
}

export type WorkspaceMemberSummary = {
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  active: number;
  revokedAt: number | null;
  revokedBy: string | null;
  revokedByName: string | null;
  lastSignInAt: number | null;
  runners: number;
  openItems: number;
};

export function* listWorkspaceMemberSummariesSteps(
  q: Q,
  workspaceId: string,
): Steps<WorkspaceMemberSummary[]> {
  const { runner, workspaceAccessAudit: audit, workspaceMember: m, workspaceUser: u } = q.t;
  const revoker = alias(u, "revoker");
  const lastSignIn = q.orm
    .select({ at: max(audit.createdAt) })
    .from(audit)
    .where(
      and(
        eq(audit.workspaceId, workspaceId),
        eq(audit.action, "session.created"),
        eq(audit.subject, u.id),
      ),
    );
  const runners = q.orm
    .select({ count: count() })
    .from(runner)
    .where(
      and(
        eq(runner.workspaceId, m.workspaceId),
        eq(runner.ownerUserId, u.id),
        isNull(runner.revokedAt),
      ),
    );
  const members = yield* q.all(
    q.orm
      .select({
        id: u.id,
        name: u.name,
        email: u.email,
        linearUserId: u.linearUserId,
        role: m.role,
        active: m.active,
        revokedAt: m.revokedAt,
        revokedBy: m.revokedBy,
        revokedByName: revoker.name,
        lastSignInAt: sql<number | null>`(${lastSignIn})`.mapWith(Number),
        runners: sql<number>`(${runners})`.mapWith(Number),
      })
      .from(m)
      .innerJoin(u, eq(u.id, m.userId))
      .leftJoin(revoker, eq(revoker.id, m.revokedBy))
      .where(eq(m.workspaceId, workspaceId))
      .orderBy(asc(u.name), asc(u.id)),
  );
  const summaries: WorkspaceMemberSummary[] = [];
  for (const { linearUserId, ...member } of members) {
    const open = yield* memberOpenItemsSteps(q, workspaceId, member.id, linearUserId);
    summaries.push({ ...member, role: member.role as WorkspaceRole, openItems: open.length });
  }
  return summaries;
}

export function listWorkspaceMemberSummaries(
  db: Database,
  workspaceId: string,
): WorkspaceMemberSummary[] {
  return settled(sqliteDb(db).run((q) => listWorkspaceMemberSummariesSteps(q, workspaceId)));
}
