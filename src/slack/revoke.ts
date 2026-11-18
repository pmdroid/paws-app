import { auditWorkspaceAccessSteps, deleteCredentialCiphertextSteps, type Db } from "../db";
import { installedSlackTokenSteps, slackTeamOwnerSteps } from "./oauth";
import type { SlackRevocation } from "./webhook";

/**
 * Ends the one installation Slack says was uninstalled or lost its bot token: the
 * workspace that owns the team loses its token and the team's owner row, nothing else.
 */
export function createSlackRevocation(options: { store: Db; home: string; now?: () => number }) {
  const { store, home } = options;
  const now = options.now ?? Date.now;
  return (revocation: SlackRevocation): Promise<string | null> =>
    store.transaction(function* (q) {
      const team = yield* slackTeamOwnerSteps(q, home, revocation.teamId);
      if (!team.owner) return null;
      // Slack's event_time has second precision: a row saved after that second is a
      // reinstall, and a delayed or replayed event must not end it.
      const after = (updatedAt: number) => updatedAt >= revocation.eventTimeMs + 1000;
      if (after(team.owner.updatedAt)) return null;
      const workspaceId = team.owner.value;
      const current = yield* installedSlackTokenSteps(q, home, workspaceId);
      if (current) {
        if (current.teamId !== revocation.teamId || after(current.updatedAt)) return null;
        if (revocation.appId && current.appId && revocation.appId !== current.appId) return null;
        if (revocation.botUserIds && !revocation.botUserIds.includes(current.botUserId))
          return null;
        const key = { kind: "slack" as const, workspace: workspaceId };
        if (!(yield* deleteCredentialCiphertextSteps(q, key, current.updatedAt))) return null;
      }
      if (!(yield* deleteCredentialCiphertextSteps(q, team.key, team.owner.updatedAt)))
        throw new Error("The Slack team owner changed during revocation.");
      yield* auditWorkspaceAccessSteps(q, {
        workspaceId,
        userId: null,
        action: "slack.revoked",
        subject: `slack:${revocation.teamId}`,
        now: now(),
      });
      return workspaceId;
    });
}
