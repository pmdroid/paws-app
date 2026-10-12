import type { Database } from "bun:sqlite";
import {
  getLinearSession,
  getLinearSessionAccess,
  getLinearSessionGeneration,
  getLinearSessionInstallation,
  immediate,
  linearSessionsForIssueContext,
  saveLinearIssueContext,
} from "../db";
import type { LinearAdministration, TrackerAdapter } from "../linear";

export async function refreshLinearNotificationContext(
  db: Database,
  tracker: TrackerAdapter | null,
  notification: Extract<LinearAdministration, { kind: "notification" }>,
): Promise<void> {
  const sessions = linearSessionsForIssueContext(db, notification.issueId)
    .filter((id) => {
      const scope = getLinearSessionInstallation(db, id);
      return (
        scope?.organizationId === notification.organizationId &&
        scope.oauthClientId === notification.oauthClientId &&
        scope.appUserId === notification.appUserId &&
        getLinearSessionAccess(db, id) === "allowed" &&
        getLinearSession(db, id)?.stoppedAt === null
      );
    })
    .map((id) => ({ id, generation: getLinearSessionGeneration(db, id) }));
  if (sessions.length === 0) return;
  if (!tracker?.getIssueContext) throw new Error("Linear issue context reads are unavailable.");
  const signal = AbortSignal.timeout(10_000);
  const context = await tracker.getIssueContext(notification.issueId, { signal });
  signal.throwIfAborted();
  if (context.id !== notification.issueId || context.teamId !== notification.teamId)
    throw new Error("The Linear notification context belongs to another issue or team.");
  immediate(db, () => {
    for (const session of sessions) {
      if (
        getLinearSessionGeneration(db, session.id) !== session.generation ||
        getLinearSessionAccess(db, session.id) !== "allowed"
      )
        continue;
      saveLinearIssueContext(db, {
        sessionId: session.id,
        issueId: context.id,
        observedAt: notification.createdAtMs,
        context: `Current Linear issue context:\n${JSON.stringify(context)}`,
      });
    }
  });
}
