import {
  getLinearSessionAccessSteps,
  getLinearSessionGenerationSteps,
  getLinearSessionInstallationSteps,
  getLinearSessionSteps,
  linearSessionsForIssueContextSteps,
  saveLinearIssueContextSteps,
  type Db,
} from "../db";
import type { LinearAdministration, TrackerAdapter } from "../linear";

export async function refreshLinearNotificationContext(
  store: Db,
  tracker: TrackerAdapter | null,
  notification: Extract<LinearAdministration, { kind: "notification" }>,
): Promise<void> {
  const sessions = await store.run(function* (q) {
    const current: { id: string; generation: number }[] = [];
    for (const id of yield* linearSessionsForIssueContextSteps(q, notification.issueId)) {
      const scope = yield* getLinearSessionInstallationSteps(q, id);
      if (
        scope?.organizationId === notification.organizationId &&
        scope.oauthClientId === notification.oauthClientId &&
        scope.appUserId === notification.appUserId &&
        (yield* getLinearSessionAccessSteps(q, id)) === "allowed" &&
        (yield* getLinearSessionSteps(q, id))?.stoppedAt === null
      )
        current.push({ id, generation: yield* getLinearSessionGenerationSteps(q, id) });
    }
    return current;
  });
  if (sessions.length === 0) return;
  if (!tracker?.getIssueContext) throw new Error("Linear issue context reads are unavailable.");
  const signal = AbortSignal.timeout(10_000);
  const context = await tracker.getIssueContext(notification.issueId, { signal });
  signal.throwIfAborted();
  if (context.id !== notification.issueId || context.teamId !== notification.teamId)
    throw new Error("The Linear notification context belongs to another issue or team.");
  await store.transaction(function* (q) {
    for (const session of sessions) {
      if (
        (yield* getLinearSessionGenerationSteps(q, session.id)) !== session.generation ||
        (yield* getLinearSessionAccessSteps(q, session.id)) !== "allowed"
      )
        continue;
      yield* saveLinearIssueContextSteps(q, {
        sessionId: session.id,
        issueId: context.id,
        observedAt: notification.createdAtMs,
        context: `Current Linear issue context:\n${JSON.stringify(context)}`,
      });
    }
  });
}
