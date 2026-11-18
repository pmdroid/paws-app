import {
  activeSlackTeamSteps,
  auditWorkspaceAccessSteps,
  saveSlackInstallationSteps,
  type Db,
  type Q,
  type SlackInstallation,
  type Steps,
} from "../db";
import { clearCredentialRefreshSteps, deleteScopedCredentialSteps } from "../credentials";
import { slackCredentialKey } from "./oauth";

export function* dropSlackCredentialSteps(q: Q, installation: SlackInstallation): Steps<void> {
  if (!installation.teamId) return;
  const key = slackCredentialKey({
    workspaceId: installation.workspaceId,
    teamId: installation.teamId,
  });
  yield* deleteScopedCredentialSteps(q, key);
  yield* clearCredentialRefreshSteps(q, key.workspace);
}

export function* endSlackInstallationSteps(
  q: Q,
  installation: SlackInstallation,
  status: "disconnected" | "revoked",
  actorId: string | null,
  now: number,
): Steps<boolean> {
  yield* dropSlackCredentialSteps(q, installation);
  return yield* saveSlackInstallationSteps(q, {
    workspaceId: installation.workspaceId,
    expectedGeneration: installation.generation,
    status,
    actorId,
    now,
  });
}

export function revokeSlackTeam(
  store: Db,
  event: { teamId: string; appId: string | null },
  now = Date.now(),
): Promise<boolean> {
  return store.transaction(function* (q) {
    const current = yield* activeSlackTeamSteps(q, event.teamId);
    if (!current || (current.appId && current.appId !== event.appId)) return false;
    yield* endSlackInstallationSteps(q, current, "revoked", null, now);
    yield* auditWorkspaceAccessSteps(q, {
      workspaceId: current.workspaceId,
      userId: null,
      action: "slack.revoked",
      subject: `slack:${event.teamId}`,
      now,
    });
    return true;
  });
}
