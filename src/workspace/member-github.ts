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

export type MemberRepositoryResult = {
  state: "missing_link" | "denied" | "unavailable" | "ready";
  account: { id: number; login: string } | null;
  repository: string;
  permission: "read" | "push";
  reason: "permission" | "connection" | "provider" | "authority_changed";
};

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
  async function inspectRepository(
    workspaceId: string,
    userId: string,
    repository: string,
    permission: "read" | "push",
    signal: AbortSignal,
  ): Promise<MemberRepositoryResult> {
    signal.throwIfAborted();
    const row = current(workspaceId, userId);
    const context = {
      repository,
      permission,
      account: row ? { id: row.githubId!, login: row.login! } : null,
    };
    const result = (
      state: MemberRepositoryResult["state"],
      reason: MemberRepositoryResult["reason"],
    ): MemberRepositoryResult => ({ ...context, state, reason });
    if (!row) return result("missing_link", "connection");
    const unchanged = () => {
      const member = workspaceMember(db, workspaceId, userId);
      return (
        member?.active &&
        member.role !== "observer" &&
        memberGitHubRecord(db, workspaceId, userId)?.revision === row.revision
      );
    };
    try {
      const token = secrets(workspaceId, userId).read(row.secretId!);
      if (!token) return result("missing_link", "connection");
      const identity = await client.identity(token, signal);
      signal.throwIfAborted();
      if (!unchanged()) return result("unavailable", "authority_changed");
      if (identity.id !== row.githubId) {
        revokeMemberGitHub(db, workspaceId, userId, row.revision);
        return result("missing_link", "connection");
      }
      const allowed = await client.repository(token, repository, permission, signal);
      signal.throwIfAborted();
      if (!unchanged()) return result("unavailable", "authority_changed");
      if (row.expiresAt !== null && now() >= row.expiresAt) {
        revokeMemberGitHub(db, workspaceId, userId, row.revision);
        return result("missing_link", "connection");
      }
      return result(allowed ? "ready" : "denied", "permission");
    } catch (error) {
      signal.throwIfAborted();
      if (!unchanged()) return result("unavailable", "authority_changed");
      if (
        error instanceof MemberGitHubUnauthorizedError ||
        (row.expiresAt !== null && now() >= row.expiresAt)
      ) {
        revokeMemberGitHub(db, workspaceId, userId, row.revision);
        return result("missing_link", "connection");
      }
      return result("unavailable", "provider");
    }
  }
  return {
    inspectRepository,
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
      try {
        return (
          (await inspectRepository(workspaceId, userId, repository, permission, signal)).state ===
          "ready"
        );
      } catch {
        return false;
      }
    },
  };
}
