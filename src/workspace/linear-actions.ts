import { canAct } from "./eligibility";
import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccess,
  getLinearSessionAccess,
  getLinearSessionInstallation,
  syncWorkspaceMember,
  workspaceForOrganization,
  workspaceLinearMember,
} from "../db";
import type { AcceptedLinearEvent, LinearMembershipReads } from "../linear";

export function createWorkspaceLinearActions(options: {
  db: Database;
  organizationId: string;
  clientId: string;
  memberships: LinearMembershipReads;
  now: () => number;
}) {
  function denied(
    event: AcceptedLinearEvent,
    workspaceId: string | null,
    userId: string | null,
  ): false {
    auditWorkspaceAccess(options.db, {
      workspaceId,
      userId,
      action: "access.denied",
      subject: `linear:${event.sessionId ?? "unknown"}:${event.activityId ?? event.dedupeKey}`,
      now: options.now(),
    });
    return false;
  }
  function recheck(event: AcceptedLinearEvent): boolean {
    if (event.action !== "prompted" && event.signal !== "stop") return true;
    const workspace = workspaceForOrganization(options.db, options.organizationId);
    const member =
      workspace && event.actorId
        ? workspaceLinearMember(options.db, workspace.id, event.actorId)
        : null;
    const installation = event.sessionId
      ? getLinearSessionInstallation(options.db, event.sessionId)
      : null;
    return (
      (workspace !== null &&
        event.sessionId !== null &&
        installation?.organizationId === options.organizationId &&
        installation.oauthClientId === options.clientId &&
        installation.teamId !== null &&
        getLinearSessionAccess(options.db, event.sessionId) === "allowed" &&
        canAct({ id: event.actorId ?? "", member, teamId: installation.teamId }, "prompt")
          .allowed) ||
      denied(event, workspace?.id ?? null, member?.userId ?? null)
    );
  }
  async function authorize(event: AcceptedLinearEvent): Promise<boolean> {
    if (event.action !== "prompted" && event.signal !== "stop") return true;
    const workspace = workspaceForOrganization(options.db, options.organizationId);
    const actorId = event.actorId;
    const member =
      workspace && actorId ? workspaceLinearMember(options.db, workspace.id, actorId) : null;
    const deny = () => denied(event, workspace?.id ?? null, member?.userId ?? null);
    if (
      workspace === null ||
      !actorId?.trim() ||
      event.sessionId === null ||
      !canAct({ id: actorId, member }, "prompt").allowed
    )
      return deny();
    const before = getLinearSessionInstallation(options.db, event.sessionId);
    if (
      before?.organizationId !== options.organizationId ||
      before.oauthClientId !== options.clientId ||
      before.teamId === null ||
      getLinearSessionAccess(options.db, event.sessionId) !== "allowed"
    )
      return deny();
    const observedAt = options.now();
    const identity = await options.memberships.member(
      options.organizationId,
      actorId,
      AbortSignal.timeout(10_000),
    );
    const current = getLinearSessionInstallation(options.db, event.sessionId);
    const latest = workspaceLinearMember(options.db, workspace.id, actorId);
    if (
      identity.userId !== actorId ||
      identity.organizationId !== options.organizationId ||
      current?.organizationId !== before.organizationId ||
      current.oauthClientId !== before.oauthClientId ||
      current.appUserId !== before.appUserId ||
      current.teamId !== before.teamId ||
      getLinearSessionAccess(options.db, event.sessionId) !== "allowed" ||
      !canAct({ id: actorId, member: latest }, "prompt").allowed
    )
      return deny();
    if (latest !== null) {
      syncWorkspaceMember(options.db, {
        workspaceId: workspace.id,
        userId: latest.userId,
        active: identity.active && !identity.guest,
        role: "member",
        teamIds: identity.teamIds,
        now: observedAt,
      });
    }
    return canAct(
      {
        id: actorId,
        identity,
        member: workspaceLinearMember(options.db, workspace.id, actorId),
        teamId: before.teamId,
      },
      "prompt",
    ).allowed
      ? true
      : deny();
  }
  return { authorize, recheck };
}
