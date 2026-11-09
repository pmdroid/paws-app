import { workspaceMemberUsable, auditWorkspaceAccess, workspaceMember } from "./workspace";
import type { Database } from "bun:sqlite";
import { and, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { orm } from "./orm";
import {
  githubAttributionRequest,
  linearSession,
  verifiedGithubAttribution,
  workItem,
  workspace,
  workspaceSession,
} from "./schema";
import { immediate } from "./tx";
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

export function requireAttributionSession(db: Database, binding: AttributionBinding, now: number) {
  const session = orm(db)
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
    )
    .get();
  const member = workspaceMember(db, binding.workspaceId, binding.userId);
  if (
    !session ||
    !workspaceMemberUsable(member) ||
    now < session.authenticated_at ||
    now >= session.expires_at
  )
    throw new Error("A current sign-in and permitted workspace membership are required.");
}

export function beginGitHubAttribution(
  db: Database,
  binding: AttributionBinding,
  input: {
    stateHash: string;
    browserHash: string;
    now: number;
    /** Set by the server from the route that started the link, never from the URL. */
    returnPath?: string;
  },
) {
  const returnPath = input.returnPath ?? ATTRIBUTION_SETTINGS_PATH;
  if (attributionReturnPath(returnPath) !== returnPath)
    throw new Error("GitHub credit can only return to Settings or an onboarding page.");
  immediate(db, () => {
    requireAttributionSession(db, binding, input.now);
    const handle = orm(db);
    handle
      .insert(verifiedGithubAttribution)
      .values({ workspaceId: binding.workspaceId, userId: binding.userId, revision: 1 })
      .onConflictDoUpdate({
        target: [verifiedGithubAttribution.workspaceId, verifiedGithubAttribution.userId],
        set: { revision: sql`${verifiedGithubAttribution.revision}+1` },
      })
      .run();
    handle
      .delete(githubAttributionRequest)
      .where(
        or(
          lte(githubAttributionRequest.expiresAt, input.now),
          and(
            eq(githubAttributionRequest.workspaceId, binding.workspaceId),
            eq(githubAttributionRequest.userId, binding.userId),
          ),
        ),
      )
      .run();
    handle.run(
      sql`INSERT INTO github_attribution_request(state_hash,browser_hash,session_hash,workspace_id,user_id,revision,expires_at,return_path)
      SELECT ${input.stateHash},${input.browserHash},${binding.sessionHash},${binding.workspaceId},${binding.userId},revision,${input.now + 600_000},${returnPath === ATTRIBUTION_SETTINGS_PATH ? null : returnPath}
      FROM verified_github_attribution WHERE workspace_id=${binding.workspaceId} AND user_id=${binding.userId}`,
    );
  });
}

export function consumeGitHubAttribution(
  db: Database,
  binding: AttributionBinding,
  input: { stateHash: string; browserHash: string; now: number },
): number {
  return consumeGitHubAttributionRequest(db, binding, input).revision;
}

/** Uses up one pending link and says where its callback returns. */
export function consumeGitHubAttributionRequest(
  db: Database,
  binding: AttributionBinding,
  input: { stateHash: string; browserHash: string; now: number },
): { revision: number; returnPath: string } {
  return immediate(db, () => {
    requireAttributionSession(db, binding, input.now);
    const pending = orm(db)
      .delete(githubAttributionRequest)
      .where(
        and(
          eq(githubAttributionRequest.stateHash, input.stateHash),
          eq(githubAttributionRequest.browserHash, input.browserHash),
          eq(githubAttributionRequest.sessionHash, binding.sessionHash),
          eq(githubAttributionRequest.workspaceId, binding.workspaceId),
          eq(githubAttributionRequest.userId, binding.userId),
          gt(githubAttributionRequest.expiresAt, input.now),
        ),
      )
      .returning({
        revision: githubAttributionRequest.revision,
        returnPath: githubAttributionRequest.returnPath,
      })
      .get();
    if (!pending) throw new Error("GitHub identity request is invalid or expired.");
    return { revision: pending.revision, returnPath: attributionReturnPath(pending.returnPath) };
  });
}

export function saveGitHubAttribution(
  db: Database,
  binding: AttributionBinding,
  identity: VerifiedGitHubAttribution,
  revision: number,
  now: number,
) {
  immediate(db, () => {
    requireAttributionSession(db, binding, now);
    const updated = orm(db)
      .update(verifiedGithubAttribution)
      .set({
        githubId: identity.id,
        login: identity.login,
        name: identity.name,
        consentedAt: now,
        revokedAt: null,
        revision: sql`${verifiedGithubAttribution.revision}+1`,
      })
      .where(
        and(
          eq(verifiedGithubAttribution.workspaceId, binding.workspaceId),
          eq(verifiedGithubAttribution.userId, binding.userId),
          eq(verifiedGithubAttribution.revision, revision),
        ),
      )
      .returning({ revision: verifiedGithubAttribution.revision })
      .all();
    if (updated.length !== 1) throw new Error("Attribution consent changed. Start again.");
    auditWorkspaceAccess(db, {
      ...binding,
      action: "github.attribution.consented",
      subject: String(identity.id),
      now,
    });
  });
}

export function revokeGitHubAttribution(db: Database, binding: AttributionBinding, now: number) {
  immediate(db, () => {
    requireAttributionSession(db, binding, now);
    const handle = orm(db);
    handle
      .insert(verifiedGithubAttribution)
      .values({
        workspaceId: binding.workspaceId,
        userId: binding.userId,
        revision: 1,
        revokedAt: now,
      })
      .onConflictDoUpdate({
        target: [verifiedGithubAttribution.workspaceId, verifiedGithubAttribution.userId],
        set: {
          revision: sql`${verifiedGithubAttribution.revision}+1`,
          revokedAt: sql`excluded.revoked_at`,
          consentedAt: null,
        },
      })
      .run();
    handle
      .delete(githubAttributionRequest)
      .where(
        and(
          eq(githubAttributionRequest.workspaceId, binding.workspaceId),
          eq(githubAttributionRequest.userId, binding.userId),
        ),
      )
      .run();
    auditWorkspaceAccess(db, {
      ...binding,
      action: "github.attribution.revoked",
      subject: binding.userId,
      now,
    });
  });
}

export function githubAttribution(
  db: Database,
  workspaceId: string,
  userId: string,
): VerifiedGitHubAttribution | null {
  const member = workspaceMember(db, workspaceId, userId);
  if (!workspaceMemberUsable(member)) return null;
  const row = orm(db)
    .select({
      id: verifiedGithubAttribution.githubId,
      login: verifiedGithubAttribution.login,
      name: verifiedGithubAttribution.name,
    })
    .from(verifiedGithubAttribution)
    .where(
      and(
        eq(verifiedGithubAttribution.workspaceId, workspaceId),
        eq(verifiedGithubAttribution.userId, userId),
        isNotNull(verifiedGithubAttribution.consentedAt),
        isNull(verifiedGithubAttribution.revokedAt),
      ),
    )
    .get() as Omit<VerifiedGitHubAttribution, "email"> | undefined;
  return row ? { ...row, email: `${row.id}+${row.login}@users.noreply.github.com` } : null;
}

export function attributionItemScope(
  db: Database,
  itemId: string,
): { workspaceId: string; organizationId: string; sessionId: string; teamId: string } | null {
  return (
    orm(db)
      .select({
        workspaceId: workspace.id,
        organizationId: workspace.linearOrganizationId,
        sessionId: linearSession.sessionId,
        teamId: sql<string>`${linearSession.teamId}`,
      })
      .from(workItem)
      .innerJoin(linearSession, eq(linearSession.sessionId, workItem.sessionKey))
      .innerJoin(workspace, eq(workspace.linearOrganizationId, linearSession.organizationId))
      .where(eq(workItem.id, itemId))
      .get() ?? null
  );
}
