import type { Database } from "bun:sqlite";
import { immediate } from "./tx";
import { auditWorkspaceAccess, workspaceMember } from "./workspace";

export type MemberGitHubBinding = { workspaceId: string; userId: string; sessionHash: string };
export type MemberGitHubRecord = {
  githubId: number | null;
  login: string | null;
  secretId: string | null;
  expiresAt: number | null;
  revision: number;
  revoked: number;
};

export function requireMemberGitHubSession(
  db: Database,
  binding: MemberGitHubBinding,
  now: number,
) {
  const session = db
    .query<{ authenticated_at: number; expires_at: number }, [string, string, string]>(
      "SELECT authenticated_at,expires_at FROM workspace_session WHERE token_hash=? AND workspace_id=? AND user_id=?",
    )
    .get(binding.sessionHash, binding.workspaceId, binding.userId);
  const member = workspaceMember(db, binding.workspaceId, binding.userId);
  if (
    !session ||
    !member?.active ||
    member.role === "observer" ||
    now < session.authenticated_at ||
    now >= session.expires_at
  )
    throw new Error("A current member sign-in is required.");
}

export function memberGitHubRecord(
  db: Database,
  workspaceId: string,
  userId: string,
): MemberGitHubRecord | null {
  return db
    .query<MemberGitHubRecord, [string, string]>(
      "SELECT github_id AS githubId,login,secret_id AS secretId,expires_at AS expiresAt,revision,revoked FROM member_github_account WHERE workspace_id=? AND user_id=?",
    )
    .get(workspaceId, userId);
}

export function beginMemberGitHubLink(
  db: Database,
  binding: MemberGitHubBinding,
  now: number,
): number {
  return immediate(db, () => {
    requireMemberGitHubSession(db, binding, now);
    db.run(
      `INSERT INTO member_github_account(workspace_id,user_id,revision,pending_session_hash) VALUES(?,?,1,?)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET revision=revision+1,pending_session_hash=excluded.pending_session_hash`,
      [binding.workspaceId, binding.userId, binding.sessionHash],
    );
    return memberGitHubRecord(db, binding.workspaceId, binding.userId)!.revision;
  });
}

export function saveMemberGitHubLink(
  db: Database,
  binding: MemberGitHubBinding,
  input: {
    githubId: number;
    login: string;
    secretId: string;
    expiresAt: number | null;
    revision: number;
    now: number;
  },
): string | null {
  return immediate(db, () => {
    requireMemberGitHubSession(db, binding, input.now);
    const previous = memberGitHubRecord(db, binding.workspaceId, binding.userId);
    const result = db.run(
      `UPDATE member_github_account SET github_id=?,login=?,secret_id=?,expires_at=?,revoked=0,revision=revision+1,pending_session_hash=NULL
      WHERE workspace_id=? AND user_id=? AND revision=? AND pending_session_hash=?`,
      [
        input.githubId,
        input.login,
        input.secretId,
        input.expiresAt,
        binding.workspaceId,
        binding.userId,
        input.revision,
        binding.sessionHash,
      ],
    );
    if (result.changes !== 1) throw new Error("GitHub link changed. Start sign-in again.");
    auditWorkspaceAccess(db, {
      ...binding,
      action: "github.member.linked",
      subject: String(input.githubId),
      now: input.now,
    });
    return previous?.secretId ?? null;
  });
}

export function unlinkMemberGitHub(
  db: Database,
  binding: MemberGitHubBinding,
  now: number,
): string | null {
  return immediate(db, () => {
    requireMemberGitHubSession(db, binding, now);
    const previous = memberGitHubRecord(db, binding.workspaceId, binding.userId);
    db.run(
      `INSERT INTO member_github_account(workspace_id,user_id,revision,revoked) VALUES(?,?,1,1)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET github_id=NULL,login=NULL,secret_id=NULL,expires_at=NULL,revoked=1,revision=revision+1,pending_session_hash=NULL`,
      [binding.workspaceId, binding.userId],
    );
    auditWorkspaceAccess(db, {
      ...binding,
      action: "github.member.unlinked",
      subject: binding.userId,
      now,
    });
    return previous?.secretId ?? null;
  });
}

export function revokeMemberGitHub(
  db: Database,
  workspaceId: string,
  userId: string,
  revision: number,
) {
  db.run(
    "UPDATE member_github_account SET revoked=1,revision=revision+1,pending_session_hash=NULL WHERE workspace_id=? AND user_id=? AND revision=?",
    [workspaceId, userId, revision],
  );
}
