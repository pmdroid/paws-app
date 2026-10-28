import { workspaceMemberUsable, auditWorkspaceAccess, workspaceMember } from "./workspace";
import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

export type VerifiedGitHubAttribution = { id: number; login: string; name: string; email: string };
export type AttributionBinding = { workspaceId: string; userId: string; sessionHash: string };

/** Where a GitHub credit link returns when nothing else is stored. */
export const ATTRIBUTION_SETTINGS_PATH = "/status/settings/account";
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
  const session = db
    .query<{ authenticated_at: number; expires_at: number }, [string, string, string]>(
      "SELECT authenticated_at,expires_at FROM workspace_session WHERE token_hash=? AND workspace_id=? AND user_id=?",
    )
    .get(binding.sessionHash, binding.workspaceId, binding.userId);
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
    db.run(
      "INSERT INTO verified_github_attribution(workspace_id,user_id,revision) VALUES(?,?,1) ON CONFLICT(workspace_id,user_id) DO UPDATE SET revision=revision+1",
      [binding.workspaceId, binding.userId],
    );
    db.run(
      "DELETE FROM github_attribution_request WHERE expires_at<=? OR (workspace_id=? AND user_id=?)",
      [input.now, binding.workspaceId, binding.userId],
    );
    db.run(
      `INSERT INTO github_attribution_request(state_hash,browser_hash,session_hash,workspace_id,user_id,revision,expires_at,return_path)
      SELECT ?,?,?,?,?,revision,?,? FROM verified_github_attribution WHERE workspace_id=? AND user_id=?`,
      [
        input.stateHash,
        input.browserHash,
        binding.sessionHash,
        binding.workspaceId,
        binding.userId,
        input.now + 600_000,
        returnPath === ATTRIBUTION_SETTINGS_PATH ? null : returnPath,
        binding.workspaceId,
        binding.userId,
      ],
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
    const pending = db
      .query<
        { revision: number; returnPath: string | null },
        [string, string, string, string, string, number]
      >(
        `DELETE FROM github_attribution_request WHERE state_hash=? AND browser_hash=? AND session_hash=? AND workspace_id=? AND user_id=? AND expires_at>? RETURNING revision,return_path AS returnPath`,
      )
      .get(
        input.stateHash,
        input.browserHash,
        binding.sessionHash,
        binding.workspaceId,
        binding.userId,
        input.now,
      );
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
    const result = db.run(
      `UPDATE verified_github_attribution SET github_id=?,login=?,name=?,consented_at=?,revoked_at=NULL,revision=revision+1 WHERE workspace_id=? AND user_id=? AND revision=?`,
      [
        identity.id,
        identity.login,
        identity.name,
        now,
        binding.workspaceId,
        binding.userId,
        revision,
      ],
    );
    if (result.changes !== 1) throw new Error("Attribution consent changed. Start again.");
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
    db.run(
      `INSERT INTO verified_github_attribution(workspace_id,user_id,revision,revoked_at) VALUES(?,?,1,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET revision=revision+1,revoked_at=excluded.revoked_at,consented_at=NULL`,
      [binding.workspaceId, binding.userId, now],
    );
    db.run("DELETE FROM github_attribution_request WHERE workspace_id=? AND user_id=?", [
      binding.workspaceId,
      binding.userId,
    ]);
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
  const row = db
    .query<Omit<VerifiedGitHubAttribution, "email">, [string, string]>(
      "SELECT github_id AS id,login,name FROM verified_github_attribution WHERE workspace_id=? AND user_id=? AND consented_at IS NOT NULL AND revoked_at IS NULL",
    )
    .get(workspaceId, userId);
  return row ? { ...row, email: `${row.id}+${row.login}@users.noreply.github.com` } : null;
}

export function attributionItemScope(db: Database, itemId: string) {
  return db
    .query<
      { workspaceId: string; organizationId: string; sessionId: string; teamId: string },
      [string]
    >(
      `SELECT w.id AS workspaceId,w.linear_organization_id AS organizationId,s.session_id AS sessionId,s.team_id AS teamId FROM work_item i JOIN linear_session s ON s.session_id=i.session_key JOIN workspace w ON w.linear_organization_id=s.organization_id WHERE i.id=?`,
    )
    .get(itemId);
}
