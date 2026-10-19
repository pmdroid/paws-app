import type { Database } from "bun:sqlite";
import {
  beginMemberGitHubLink,
  memberGitHubRecord,
  requireMemberGitHubSession,
  revokeMemberGitHub,
  saveMemberGitHubLink,
  unlinkMemberGitHub,
  workspaceMember,
  type MemberGitHubBinding,
} from "../db";
import { memberGitHubSecrets } from "../credentials";
import { MemberGitHubUnauthorizedError, type MemberGitHubClient } from "../github";

export function createMemberGitHubAccounts(options: {
  db: Database;
  secretsDir: string;
  client: MemberGitHubClient;
  now?: () => number;
}) {
  const { db, client } = options;
  const now = options.now ?? Date.now;
  const secrets = (workspaceId: string, userId: string) =>
    memberGitHubSecrets(options.secretsDir, workspaceId, userId);
  function current(workspaceId: string, userId: string) {
    const member = workspaceMember(db, workspaceId, userId);
    const row = memberGitHubRecord(db, workspaceId, userId);
    if (
      !member?.active ||
      member.role === "observer" ||
      !row?.secretId ||
      row.revoked ||
      row.githubId === null ||
      row.login === null
    )
      return null;
    if (row.expiresAt !== null && now() >= row.expiresAt) {
      revokeMemberGitHub(db, workspaceId, userId, row.revision);
      return null;
    }
    return row;
  }
  return {
    begin(binding: MemberGitHubBinding) {
      return beginMemberGitHubLink(db, binding, now());
    },
    async complete(
      binding: MemberGitHubBinding,
      revision: number,
      grant: { accessToken: string; expiresAt: number | null },
      signal: AbortSignal,
    ) {
      let secretId: string | undefined;
      const store = secrets(binding.workspaceId, binding.userId);
      try {
        requireMemberGitHubSession(db, binding, now());
        if (
          !grant.accessToken ||
          /\s/.test(grant.accessToken) ||
          grant.accessToken.length > 4096 ||
          (grant.expiresAt !== null &&
            (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now()))
        )
          throw new Error();
        const identity = await client.identity(grant.accessToken, signal);
        signal.throwIfAborted();
        secretId = store.write(grant.accessToken);
        const previous = saveMemberGitHubLink(db, binding, {
          githubId: identity.id,
          login: identity.login,
          secretId,
          expiresAt: grant.expiresAt,
          revision,
          now: now(),
        });
        secretId = undefined;
        if (previous) store.remove(previous);
        return identity;
      } catch {
        if (secretId) store.remove(secretId);
        throw new Error("GitHub connection failed. Start sign-in again.");
      }
    },
    status(workspaceId: string, userId: string) {
      const row = current(workspaceId, userId);
      return row ? { id: row.githubId!, login: row.login!, expiresAt: row.expiresAt } : null;
    },
    unlink(binding: MemberGitHubBinding) {
      const previous = unlinkMemberGitHub(db, binding, now());
      if (previous) secrets(binding.workspaceId, binding.userId).remove(previous);
    },
    async checkRepository(
      workspaceId: string,
      userId: string,
      repository: string,
      permission: "read" | "push",
      signal: AbortSignal,
    ): Promise<boolean> {
      const row = current(workspaceId, userId);
      if (!row) return false;
      try {
        const token = secrets(workspaceId, userId).read(row.secretId!);
        if (!token) return false;
        const identity = await client.identity(token, signal);
        if (identity.id !== row.githubId) {
          revokeMemberGitHub(db, workspaceId, userId, row.revision);
          return false;
        }
        const allowed = await client.repository(token, repository, permission, signal);
        signal.throwIfAborted();
        return allowed && current(workspaceId, userId)?.revision === row.revision;
      } catch (error) {
        if (error instanceof MemberGitHubUnauthorizedError)
          revokeMemberGitHub(db, workspaceId, userId, row.revision);
        return false;
      }
    },
  };
}
