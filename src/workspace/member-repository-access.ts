import type { Database } from "bun:sqlite";
import {
  delegatedLinearUserId,
  getLinearSession,
  getLinearSessionInstallation,
  getTaskMode,
  getTaskModeGeneration,
  getWorkItem,
  getWorkItemRepository,
  memberGitHubRecord,
  syncWorkspaceMember,
  taskRequiresRepository,
  teamRepositoryAllowedSql,
  workspaceForOrganization,
  workspaceLinearMember,
  workspaceSessionIds,
} from "../db";
import type { LinearMembershipReads } from "../linear";
import type { createMemberGitHubAccounts, MemberRepositoryResult } from "./member-github";

export type TaskRepositoryAccessResult = Omit<
  MemberRepositoryResult,
  "repository" | "permission" | "reason"
> & {
  repository: string | null;
  permission: "read" | "push" | null;
  reason:
    | MemberRepositoryResult["reason"]
    | "task_unavailable"
    | "repository_unbound"
    | "scope_denied"
    | "membership";
};

export function createMemberRepositoryAccess(options: {
  db: Database;
  clientId: string;
  accounts: Pick<ReturnType<typeof createMemberGitHubAccounts>, "inspectRepository">;
  memberships: Pick<LinearMembershipReads, "member">;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  function snapshot(itemId: string) {
    const item = getWorkItem(db, itemId);
    const session = item?.sessionKey ? getLinearSession(db, item.sessionKey) : null;
    const installation = session ? getLinearSessionInstallation(db, session.sessionId) : null;
    const workspace = session?.organizationId
      ? workspaceForOrganization(db, session.organizationId)
      : null;
    const actorId = delegatedLinearUserId(db, itemId);
    const member = workspace && actorId ? workspaceLinearMember(db, workspace.id, actorId) : null;
    const repository = getWorkItemRepository(db, itemId);
    const name = repository ? `${repository.owner}/${repository.repo}` : null;
    const mode = getTaskMode(db, itemId);
    const permission: "read" | "push" | null =
      mode === "code"
        ? "push"
        : taskRequiresRepository(db, itemId) && mode !== null
          ? "read"
          : null;
    const allowed =
      workspace && installation?.teamId && name
        ? db
            .query(`SELECT 1 WHERE ${teamRepositoryAllowedSql("?1", "?2", "lower(?3)")}`)
            .get(workspace.id, installation.teamId, name) !== null
        : false;
    const visible =
      workspace && member && session
        ? workspaceSessionIds(db, workspace.id, member.userId, options.clientId).includes(
            session.sessionId,
          )
        : false;
    const link = workspace && member ? memberGitHubRecord(db, workspace.id, member.userId) : null;
    let reason: TaskRepositoryAccessResult["reason"] | null = null;
    if (
      !item ||
      !session ||
      !installation ||
      !workspace ||
      installation.oauthClientId !== options.clientId ||
      session.stoppedAt !== null ||
      session.issueId !== item.linearIssueId ||
      item.cancelRequested ||
      ["cancelled", "completed", "merged"].includes(item.state) ||
      !permission
    )
      reason = "task_unavailable";
    else if (!repository) reason = "repository_unbound";
    else if (!member?.active || member.role === "observer") reason = "membership";
    else if (!allowed || !visible) reason = "scope_denied";
    const authority = JSON.stringify({
      item: item && {
        id: item.id,
        version: item.version,
        state: item.state,
        issue: item.linearIssueId,
        delegation: item.delegationId,
        run: item.currentRunId,
        cancel: item.cancelRequested,
      },
      session,
      installation,
      workspace,
      actorId,
      member: member && {
        id: member.userId,
        role: member.role,
        active: member.active,
        teams: member.teamIds,
      },
      repository,
      mode,
      taskGeneration: getTaskModeGeneration(db, itemId),
      permission,
      allowed,
      visible,
    });
    return {
      authority,
      item,
      workspace,
      actorId,
      member,
      name,
      permission,
      reason,
      linkRevision: link?.revision ?? null,
      linkSecret: link?.secretId ?? null,
      account: link?.githubId && link.login ? { id: link.githubId, login: link.login } : null,
    };
  }
  return {
    async check(itemId: string, signal: AbortSignal): Promise<TaskRepositoryAccessResult> {
      signal.throwIfAborted();
      const before = snapshot(itemId);
      const result = (
        state: TaskRepositoryAccessResult["state"],
        reason: TaskRepositoryAccessResult["reason"],
      ): TaskRepositoryAccessResult => ({
        state,
        reason,
        account: before.account,
        repository: before.name,
        permission: before.permission,
      });
      if (before.reason)
        return result(
          before.reason === "membership" || before.reason === "scope_denied"
            ? "denied"
            : "unavailable",
          before.reason,
        );
      const unchanged = () => {
        const latest = snapshot(itemId);
        return (
          latest.reason === null &&
          latest.authority === before.authority &&
          latest.linkRevision === before.linkRevision
        );
      };
      try {
        const observedAt = now();
        const verified = await options.memberships.member(
          before.workspace!.organizationId,
          before.actorId!,
          AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        );
        signal.throwIfAborted();
        if (!unchanged()) return result("unavailable", "authority_changed");
        if (
          verified.organizationId !== before.workspace!.organizationId ||
          verified.userId !== before.actorId
        )
          return result("unavailable", "provider");
        const applied = syncWorkspaceMember(db, {
          workspaceId: before.workspace!.id,
          userId: before.member!.userId,
          active: verified.active,
          role: verified.guest ? "observer" : "member",
          teamIds: verified.teamIds,
          now: observedAt,
        });
        if (!applied) return result("unavailable", "authority_changed");
        if (!verified.active || verified.guest) return result("denied", "membership");
        if (!unchanged()) return result("unavailable", "authority_changed");
        const checked = await options.accounts.inspectRepository(
          before.workspace!.id,
          before.member!.userId,
          before.name!,
          before.permission!,
          signal,
        );
        signal.throwIfAborted();
        const latest = snapshot(itemId);
        if (
          latest.reason !== null ||
          latest.authority !== before.authority ||
          (latest.linkRevision !== before.linkRevision &&
            !(checked.state === "missing_link" && latest.linkSecret === before.linkSecret))
        )
          return result("unavailable", "authority_changed");
        return checked;
      } catch {
        signal.throwIfAborted();
        return result("unavailable", unchanged() ? "provider" : "authority_changed");
      }
    },
  };
}
