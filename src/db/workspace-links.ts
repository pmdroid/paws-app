import { and, asc, eq, exists, lte, ne, not, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import {
  workspaceMemberUsableWhere,
  workspaceMemberUsable,
  auditWorkspaceAccessSteps,
  workspaceMemberSteps,
} from "./workspace";
export type WorkspaceIdentityLink = {
  userId: string;
  provider: "slack" | "github";
  externalId: string | null;
  installationId: string | null;
  method: "email" | "manual";
  status: "linked" | "unmatched" | "error";
  checkedAt: number;
};

export function* workspaceIdentityLinksSteps(q: Q, workspaceId: string) {
  const { workspaceIdentityLink: l, workspaceUser: u } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        userId: l.userId,
        name: u.name,
        email: u.email,
        provider: l.provider,
        externalId: l.externalId,
        installationId: l.installationId,
        method: l.method,
        status: l.status,
        checkedAt: l.checkedAt,
      })
      .from(l)
      .innerJoin(u, eq(u.id, l.userId))
      .where(eq(l.workspaceId, workspaceId))
      .orderBy(asc(u.name), asc(l.provider)),
  );
  return rows as (WorkspaceIdentityLink & { name: string; email: string })[];
}

export async function workspaceIdentityLinks(store: Db, workspaceId: string) {
  return store.run((q) => workspaceIdentityLinksSteps(q, workspaceId));
}

export function* workspaceIdentityCandidatesSteps(q: Q, workspaceId: string) {
  const { workspaceUser: u, workspaceMember: m, workspaceIdentityLink: l } = q.t;
  const manualSlack = q.orm
    .select({ one: sql`1` })
    .from(l)
    .where(
      and(
        eq(l.workspaceId, m.workspaceId),
        eq(l.userId, u.id),
        eq(l.provider, "slack"),
        eq(l.method, "manual"),
      ),
    );
  return yield* q.all(
    q.orm
      .select({ userId: u.id, email: u.email })
      .from(u)
      .innerJoin(m, eq(m.userId, u.id))
      .where(
        and(
          eq(m.workspaceId, workspaceId),
          workspaceMemberUsableWhere(m),
          not(exists(manualSlack)),
        ),
      )
      .orderBy(asc(u.id)),
  );
}

export async function workspaceIdentityCandidates(store: Db, workspaceId: string) {
  return store.run((q) => workspaceIdentityCandidatesSteps(q, workspaceId));
}

type IdentityLinkInput = WorkspaceIdentityLink & { workspaceId: string; actorId?: string };

export function* saveWorkspaceIdentityLinkSteps(q: Q, input: IdentityLinkInput) {
  const { workspaceIdentityLink: l } = q.t;
  const member = yield* workspaceMemberSteps(q, input.workspaceId, input.userId);
  if (!workspaceMemberUsable(member)) throw new Error("Choose an active workspace member.");
  const privileged = input.method === "manual" || input.actorId !== undefined;
  if (privileged) {
    const actor = yield* workspaceMemberSteps(q, input.workspaceId, input.actorId ?? "");
    if (!workspaceMemberUsable(actor) || actor.role !== "admin")
      throw new Error("Workspace administration is required.");
  }
  const fields = {
    externalId: input.externalId,
    installationId: input.installationId,
    method: input.method,
    status: input.status,
    checkedAt: input.checkedAt,
  };
  const newer = lte(l.checkedAt, sql.raw("excluded.checked_at"));
  const changed = yield* q.all(
    q.orm
      .insert(l)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        provider: input.provider,
        ...fields,
      })
      .onConflictDoUpdate({
        target: [l.workspaceId, l.userId, l.provider],
        set: fields,
        setWhere: privileged ? newer : and(ne(l.method, "manual"), newer),
      })
      .returning({ userId: l.userId }),
  );
  if (changed.length > 0)
    yield* auditWorkspaceAccessSteps(q, {
      workspaceId: input.workspaceId,
      userId: input.actorId ?? input.userId,
      action: "identity.link.changed",
      subject: `${input.userId}:${input.provider}:${input.method}:${input.status}:${input.externalId ?? ""}`,
      now: input.checkedAt,
    });
}

export async function saveWorkspaceIdentityLink(
  store: Db,
  input: IdentityLinkInput,
): Promise<void> {
  await store.run((q) => saveWorkspaceIdentityLinkSteps(q, input));
}
