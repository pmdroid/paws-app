import { canAct } from "./eligibility";
import type { Database } from "bun:sqlite";
import {
  auditWorkspaceAccessSteps,
  getLinearSessionAccessSteps,
  getLinearSessionInstallationSteps,
  sqliteDb,
  syncWorkspaceMemberSteps,
  workspaceForOrganizationSteps,
  workspaceLinearMemberSteps,
  type Q,
  type Steps,
} from "../db";
import {
  LinearEntityNotFoundError,
  type AcceptedLinearEvent,
  type LinearMembershipReads,
} from "../linear";

export function createWorkspaceLinearActions(options: {
  db: Database;
  organizationId: string;
  clientId: string;
  memberships: LinearMembershipReads;
  now: () => number;
}) {
  const store = sqliteDb(options.db);
  const workspaceOf = () =>
    store.run((q) => workspaceForOrganizationSteps(q, options.organizationId));
  const memberOf = (workspaceId: string, actorId: string) =>
    store.run((q) => workspaceLinearMemberSteps(q, workspaceId, actorId));
  const installationOf = (sessionId: string) =>
    store.run((q) => getLinearSessionInstallationSteps(q, sessionId));
  const accessOf = (sessionId: string) =>
    store.run((q) => getLinearSessionAccessSteps(q, sessionId));
  const syncMember = (input: Parameters<typeof syncWorkspaceMemberSteps>[1]) =>
    store.transaction((q) => syncWorkspaceMemberSteps(q, input));
  async function denied(
    event: AcceptedLinearEvent,
    workspaceId: string | null,
    userId: string | null,
  ): Promise<false> {
    const audit = {
      workspaceId,
      userId,
      action: "access.denied",
      subject: `linear:${event.sessionId ?? "unknown"}:${event.activityId ?? event.dedupeKey}`,
      now: options.now(),
    };
    await store.run((q) => auditWorkspaceAccessSteps(q, audit));
    return false;
  }
  async function recheck(event: AcceptedLinearEvent): Promise<boolean> {
    if (event.action !== "prompted" && event.signal !== "stop") return true;
    const workspace = await workspaceOf();
    const member = workspace && event.actorId ? await memberOf(workspace.id, event.actorId) : null;
    const installation = event.sessionId ? await installationOf(event.sessionId) : null;
    return (
      (workspace !== null &&
        event.sessionId !== null &&
        installation?.organizationId === options.organizationId &&
        installation.oauthClientId === options.clientId &&
        installation.teamId !== null &&
        (await accessOf(event.sessionId)) === "allowed" &&
        canAct({ id: event.actorId ?? "", member, teamId: installation.teamId }, "prompt")
          .allowed) ||
      denied(event, workspace?.id ?? null, member?.userId ?? null)
    );
  }
  async function authorize(event: AcceptedLinearEvent): Promise<boolean> {
    if (event.action !== "prompted" && event.signal !== "stop") return true;
    const workspace = await workspaceOf();
    const actorId = event.actorId;
    const member = workspace && actorId ? await memberOf(workspace.id, actorId) : null;
    const deny = () => denied(event, workspace?.id ?? null, member?.userId ?? null);
    if (
      workspace === null ||
      !actorId?.trim() ||
      event.sessionId === null ||
      !canAct({ id: actorId, member }, "prompt").allowed
    )
      return deny();
    const before = await installationOf(event.sessionId);
    if (
      before?.organizationId !== options.organizationId ||
      before.oauthClientId !== options.clientId ||
      before.teamId === null ||
      (await accessOf(event.sessionId)) !== "allowed"
    )
      return deny();
    const observedAt = options.now();
    const identity = await options.memberships.member(
      options.organizationId,
      actorId,
      AbortSignal.timeout(10_000),
    );
    const current = await installationOf(event.sessionId);
    const latest = await memberOf(workspace.id, actorId);
    if (
      identity.userId !== actorId ||
      identity.organizationId !== options.organizationId ||
      current?.organizationId !== before.organizationId ||
      current.oauthClientId !== before.oauthClientId ||
      current.appUserId !== before.appUserId ||
      current.teamId !== before.teamId ||
      (await accessOf(event.sessionId)) !== "allowed" ||
      !canAct({ id: actorId, member: latest }, "prompt").allowed
    )
      return deny();
    if (latest !== null) {
      await syncMember({
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
        member: await memberOf(workspace.id, actorId),
        teamId: before.teamId,
      },
      "prompt",
    ).allowed
      ? true
      : deny();
  }
  const actorDenial = (workspaceId: string | null, actorId: string) => ({
    workspaceId,
    userId: null,
    action: "access.denied",
    subject: `linear-comment:${actorId}`,
    now: options.now(),
  });
  async function deniedActor(workspaceId: string | null, actorId: string): Promise<false> {
    const audit = actorDenial(workspaceId, actorId);
    await store.run((q) => auditWorkspaceAccessSteps(q, audit));
    return false;
  }
  function* recheckActorSteps(q: Q, actor: { id: string; teamId: string | null }): Steps<boolean> {
    const workspace = yield* workspaceForOrganizationSteps(q, options.organizationId);
    if (workspace === null || !actor.id.trim()) return false;
    const member = yield* workspaceLinearMemberSteps(q, workspace.id, actor.id);
    if (canAct({ id: actor.id, member, teamId: actor.teamId ?? undefined }, "prompt").allowed)
      return true;
    yield* auditWorkspaceAccessSteps(q, actorDenial(workspace.id, actor.id));
    return false;
  }
  async function authorizeActor(actor: { id: string; teamId: string | null }): Promise<boolean> {
    const workspace = await workspaceOf();
    if (workspace === null || !actor.id.trim()) return deniedActor(null, actor.id);
    if (!(await store.run((q) => recheckActorSteps(q, actor)))) return false;
    const observedAt = options.now();
    let identity: Awaited<ReturnType<LinearMembershipReads["member"]>>;
    try {
      identity = await options.memberships.member(
        options.organizationId,
        actor.id,
        AbortSignal.timeout(10_000),
      );
    } catch (error) {
      if (error instanceof LinearEntityNotFoundError) return deniedActor(workspace.id, actor.id);
      throw error;
    }
    const latest = await memberOf(workspace.id, actor.id);
    if (identity.userId !== actor.id || identity.organizationId !== options.organizationId)
      return deniedActor(workspace.id, actor.id);
    if (latest !== null)
      await syncMember({
        workspaceId: workspace.id,
        userId: latest.userId,
        active: identity.active && !identity.guest,
        role: "member",
        teamIds: identity.teamIds,
        now: observedAt,
      });
    return canAct(
      {
        id: actor.id,
        identity,
        member: await memberOf(workspace.id, actor.id),
        teamId: actor.teamId ?? undefined,
      },
      "prompt",
    ).allowed
      ? true
      : deniedActor(workspace.id, actor.id);
  }
  return { authorize, recheck, authorizeActor, recheckActorSteps };
}
