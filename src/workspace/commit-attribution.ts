import type { Database } from "bun:sqlite";
import {
  attributionItemScope,
  getTaskLinearActor,
  getWorkItem,
  githubAttribution,
  syncWorkspaceMember,
  workspaceLinearMember,
  workspaceSessionIds,
  type WorkItemRecord,
  type VerifiedGitHubAttribution,
} from "../db";
import type {
  LinearAttributionContext,
  LinearMembershipReads,
  TrackerRequestOptions,
} from "../linear";

export class MissingCommitAttributionError extends Error {
  constructor(readonly missing: "project" | "projectLead" | "taskSteerer" | "verifiedConsent") {
    super(`Commit attribution requires ${missing}.`);
  }
}

export function createCommitPolicyForItem<Bot>(options: {
  db: Database;
  bot: Bot;
  clientId: string;
  tracker: {
    getIssueAttribution(
      issueId: string,
      options?: TrackerRequestOptions,
    ): Promise<LinearAttributionContext>;
  };
  memberships: LinearMembershipReads;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (
    item: WorkItemRecord,
  ): Promise<{
    bot: Bot;
    projectLead: VerifiedGitHubAttribution;
    taskSteerer: VerifiedGitHubAttribution;
  }> => {
    const scope = attributionItemScope(options.db, item.id);
    const canonical = getWorkItem(options.db, item.id);
    if (
      !scope ||
      !canonical ||
      canonical.linearIssueId !== item.linearIssueId ||
      canonical.version !== item.version
    )
      throw new Error("Canonical work item is required.");
    const context = await options.tracker.getIssueAttribution(canonical.linearIssueId, {
      signal: AbortSignal.timeout(10_000),
    });
    if (
      context.issueId !== canonical.linearIssueId ||
      context.organizationId !== scope.organizationId ||
      context.teamId !== scope.teamId
    )
      throw new Error("Linear returned another attribution workspace.");
    if (context.projectId === null) throw new MissingCommitAttributionError("project");
    if (context.leadId === null) throw new MissingCommitAttributionError("projectLead");
    const actorId = getTaskLinearActor(options.db, item.id);
    if (!actorId) throw new MissingCommitAttributionError("taskSteerer");
    const members = new Map<string, string>();
    for (const linearId of new Set([context.leadId, actorId])) {
      const member = workspaceLinearMember(options.db, scope.workspaceId, linearId);
      if (!member?.active || member.role === "observer")
        throw new Error("Active permitted workspace members are required for attribution.");
      const observedAt = now();
      const verified = await options.memberships.member(
        scope.organizationId,
        linearId,
        AbortSignal.timeout(10_000),
      );
      if (verified.userId !== linearId || verified.organizationId !== scope.organizationId)
        throw new Error("Linear returned another member.");
      const applied = syncWorkspaceMember(options.db, {
        workspaceId: scope.workspaceId,
        userId: member.userId,
        active: verified.active,
        role: verified.guest ? "observer" : "member",
        teamIds: verified.teamIds,
        now: observedAt,
      });
      if (!applied || !verified.active || verified.guest)
        throw new Error("Current permitted Linear membership is required for attribution.");
      members.set(linearId, member.userId);
    }
    const latest = getWorkItem(options.db, item.id);
    if (
      !latest ||
      latest.version !== canonical.version ||
      latest.linearIssueId !== canonical.linearIssueId ||
      JSON.stringify(attributionItemScope(options.db, item.id)) !== JSON.stringify(scope) ||
      latest.sessionKey !== canonical.sessionKey ||
      latest.cancelRequested ||
      getTaskLinearActor(options.db, item.id) !== actorId
    )
      throw new Error("Task attribution changed during verification.");
    const identities = new Map<string, VerifiedGitHubAttribution>();
    for (const [linearId, userId] of members) {
      if (
        !workspaceSessionIds(options.db, scope.workspaceId, userId, options.clientId).includes(
          scope.sessionId,
        )
      )
        throw new Error("Workspace task access is required for attribution.");
      const identity = githubAttribution(options.db, scope.workspaceId, userId);
      if (!identity) throw new MissingCommitAttributionError("verifiedConsent");
      identities.set(linearId, identity);
    }
    return {
      bot: options.bot,
      projectLead: identities.get(context.leadId)!,
      taskSteerer: identities.get(actorId)!,
    };
  };
}
