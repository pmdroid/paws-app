import {
  auditWorkspaceAccessSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
} from "./workspace";
import type { Database } from "bun:sqlite";
import { and, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { dashboardPath } from "../dashboard-links";

export type VerifiedGitHubAttribution = { id: number; login: string; name: string; email: string };
export type AttributionBinding = { workspaceId: string; userId: string; sessionHash: string };

/** Where a GitHub credit link returns when nothing else is stored. */
export const ATTRIBUTION_SETTINGS_PATH = dashboardPath("/settings/account");
const ONBOARDING_RETURN = /^\/onboard\/[A-Za-z0-9]{26}$/;

/**
 * The page a GitHub credit callback may return to: Settings → Account or one onboarding page.
 * Anything else, including a forged or damaged stored value, becomes Settings → Account.
 */
export function attributionReturnPath(value: string | null | undefined): string {
  return typeof value === "string" && ONBOARDING_RETURN.test(value)
    ? value
    : ATTRIBUTION_SETTINGS_PATH;
}

export function* requireAttributionSessionSteps(q: Q, binding: AttributionBinding, now: number) {
  const { workspaceSession } = q.t;
  const session = yield* q.one(
    q.orm
      .select({
        authenticated_at: workspaceSession.authenticatedAt,
        expires_at: workspaceSession.expiresAt,
      })
      .from(workspaceSession)
      .where(
        and(
          eq(workspaceSession.tokenHash, binding.sessionHash),
          eq(workspaceSession.workspaceId, binding.workspaceId),
          eq(workspaceSession.userId, binding.userId),
        ),
      ),
  );
  const member = yield* workspaceMemberSteps(q, binding.workspaceId, binding.userId);
  if (
    !session ||
    !workspaceMemberUsable(member) ||
    now < session.authenticated_at ||
    now >= session.expires_at
  )
    throw new Error("A current sign-in and permitted workspace membership are required.");
}

export function requireAttributionSession(db: Database, binding: AttributionBinding, now: number) {
  settled(sqliteDb(db).run((q) => requireAttributionSessionSteps(q, binding, now)));
}

type BeginInput = {
  stateHash: string;
  browserHash: string;
  now: number;
  /** Set by the server from the route that started the link, never from the URL. */
  returnPath?: string;
};

export function* beginGitHubAttributionSteps(q: Q, binding: AttributionBinding, input: BeginInput) {
  const returnPath = input.returnPath ?? ATTRIBUTION_SETTINGS_PATH;
  if (attributionReturnPath(returnPath) !== returnPath)
    throw new Error("GitHub credit can only return to Settings or an onboarding page.");
  const { verifiedGithubAttribution: v, githubAttributionRequest: r } = q.t;
  yield* requireAttributionSessionSteps(q, binding, input.now);
  const [verified] = yield* q.all(
    q.orm
      .insert(v)
      .values({ workspaceId: binding.workspaceId, userId: binding.userId, revision: 1 })
      .onConflictDoUpdate({
        target: [v.workspaceId, v.userId],
        set: { revision: sql`${v.revision}+1` },
      })
      .returning({ revision: v.revision }),
  );
  yield* q.exec(
    q.orm
      .delete(r)
      .where(
        or(
          lte(r.expiresAt, input.now),
          and(eq(r.workspaceId, binding.workspaceId), eq(r.userId, binding.userId)),
        ),
      ),
  );
  yield* q.exec(
    q.orm.insert(r).values({
      stateHash: input.stateHash,
      browserHash: input.browserHash,
      sessionHash: binding.sessionHash,
      workspaceId: binding.workspaceId,
      userId: binding.userId,
      revision: verified!.revision,
      expiresAt: input.now + 600_000,
      returnPath: returnPath === ATTRIBUTION_SETTINGS_PATH ? null : returnPath,
    }),
  );
}

export function beginGitHubAttribution(
  db: Database,
  binding: AttributionBinding,
  input: BeginInput,
) {
  settled(sqliteDb(db).transaction((q) => beginGitHubAttributionSteps(q, binding, input)));
}

type ConsumeInput = { stateHash: string; browserHash: string; now: number };

export function consumeGitHubAttribution(
  db: Database,
  binding: AttributionBinding,
  input: ConsumeInput,
): number {
  return consumeGitHubAttributionRequest(db, binding, input).revision;
}

export function* consumeGitHubAttributionRequestSteps(
  q: Q,
  binding: AttributionBinding,
  input: ConsumeInput,
) {
  const { githubAttributionRequest: r } = q.t;
  yield* requireAttributionSessionSteps(q, binding, input.now);
  const pending = yield* q.one(
    q.orm
      .delete(r)
      .where(
        and(
          eq(r.stateHash, input.stateHash),
          eq(r.browserHash, input.browserHash),
          eq(r.sessionHash, binding.sessionHash),
          eq(r.workspaceId, binding.workspaceId),
          eq(r.userId, binding.userId),
          gt(r.expiresAt, input.now),
        ),
      )
      .returning({ revision: r.revision, returnPath: r.returnPath }),
  );
  if (!pending) throw new Error("GitHub identity request is invalid or expired.");
  return { revision: pending.revision, returnPath: attributionReturnPath(pending.returnPath) };
}

/** Uses up one pending link and says where its callback returns. */
export function consumeGitHubAttributionRequest(
  db: Database,
  binding: AttributionBinding,
  input: ConsumeInput,
): { revision: number; returnPath: string } {
  return settled(
    sqliteDb(db).transaction((q) => consumeGitHubAttributionRequestSteps(q, binding, input)),
  );
}

export function* saveGitHubAttributionSteps(
  q: Q,
  binding: AttributionBinding,
  identity: VerifiedGitHubAttribution,
  revision: number,
  now: number,
) {
  const { verifiedGithubAttribution: v } = q.t;
  yield* requireAttributionSessionSteps(q, binding, now);
  const updated = yield* q.all(
    q.orm
      .update(v)
      .set({
        githubId: identity.id,
        login: identity.login,
        name: identity.name,
        consentedAt: now,
        revokedAt: null,
        revision: sql`${v.revision}+1`,
      })
      .where(
        and(
          eq(v.workspaceId, binding.workspaceId),
          eq(v.userId, binding.userId),
          eq(v.revision, revision),
        ),
      )
      .returning({ revision: v.revision }),
  );
  if (updated.length !== 1) throw new Error("Attribution consent changed. Start again.");
  yield* auditWorkspaceAccessSteps(q, {
    ...binding,
    action: "github.attribution.consented",
    subject: String(identity.id),
    now,
  });
}

export function saveGitHubAttribution(
  db: Database,
  binding: AttributionBinding,
  identity: VerifiedGitHubAttribution,
  revision: number,
  now: number,
) {
  settled(
    sqliteDb(db).transaction((q) =>
      saveGitHubAttributionSteps(q, binding, identity, revision, now),
    ),
  );
}

export function* revokeGitHubAttributionSteps(q: Q, binding: AttributionBinding, now: number) {
  const { verifiedGithubAttribution: v, githubAttributionRequest: r } = q.t;
  yield* requireAttributionSessionSteps(q, binding, now);
  yield* q.exec(
    q.orm
      .insert(v)
      .values({
        workspaceId: binding.workspaceId,
        userId: binding.userId,
        revision: 1,
        revokedAt: now,
      })
      .onConflictDoUpdate({
        target: [v.workspaceId, v.userId],
        set: {
          revision: sql`${v.revision}+1`,
          revokedAt: sql`excluded.revoked_at`,
          consentedAt: null,
        },
      }),
  );
  yield* q.exec(
    q.orm
      .delete(r)
      .where(and(eq(r.workspaceId, binding.workspaceId), eq(r.userId, binding.userId))),
  );
  yield* auditWorkspaceAccessSteps(q, {
    ...binding,
    action: "github.attribution.revoked",
    subject: binding.userId,
    now,
  });
}

export function revokeGitHubAttribution(db: Database, binding: AttributionBinding, now: number) {
  settled(sqliteDb(db).transaction((q) => revokeGitHubAttributionSteps(q, binding, now)));
}

export function* githubAttributionSteps(q: Q, workspaceId: string, userId: string) {
  const member = yield* workspaceMemberSteps(q, workspaceId, userId);
  if (!workspaceMemberUsable(member)) return null;
  const { verifiedGithubAttribution: v } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: v.githubId, login: v.login, name: v.name })
      .from(v)
      .where(
        and(
          eq(v.workspaceId, workspaceId),
          eq(v.userId, userId),
          isNotNull(v.consentedAt),
          isNull(v.revokedAt),
        ),
      ),
  );
  if (!row) return null;
  const found = row as Omit<VerifiedGitHubAttribution, "email">;
  return { ...found, email: `${found.id}+${found.login}@users.noreply.github.com` };
}

export function githubAttribution(
  db: Database,
  workspaceId: string,
  userId: string,
): VerifiedGitHubAttribution | null {
  return settled(sqliteDb(db).run((q) => githubAttributionSteps(q, workspaceId, userId)));
}

export function* attributionItemScopeSteps(q: Q, itemId: string) {
  const { workItem, linearSession, workspace } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        workspaceId: workspace.id,
        organizationId: workspace.linearOrganizationId,
        sessionId: linearSession.sessionId,
        teamId: sql<string>`${linearSession.teamId}`,
      })
      .from(workItem)
      .innerJoin(linearSession, eq(linearSession.sessionId, workItem.sessionKey))
      .innerJoin(workspace, eq(workspace.linearOrganizationId, linearSession.organizationId))
      .where(eq(workItem.id, itemId)),
  );
  return row ?? null;
}

export function attributionItemScope(
  db: Database,
  itemId: string,
): { workspaceId: string; organizationId: string; sessionId: string; teamId: string } | null {
  return settled(sqliteDb(db).run((q) => attributionItemScopeSteps(q, itemId)));
}
