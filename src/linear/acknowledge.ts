import type { TrackerAdapter } from "./adapter";
import type { AcceptedLinearEvent } from "./events";

/** Posted before intake so a slow Linear read still meets the 10 second first-activity rule. */
export const FIRST_ACTIVITY_BODY = "Picked up this issue.";

export async function acknowledgeNewSession(
  tracker: TrackerAdapter,
  event: AcceptedLinearEvent,
  followUp?: (event: AcceptedLinearEvent) => Promise<void>,
): Promise<void> {
  if (event.action !== "created" || event.sessionId === null || event.signal === "stop") return;
  await tracker.postProgress({
    sessionId: event.sessionId,
    kind: "thought",
    body: FIRST_ACTIVITY_BODY,
  });
  if (followUp === undefined) return;
  try {
    await followUp(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : "follow-up failed";
    console.error(`linear session follow-up failed: ${message}`);
    await tracker.postProgress({
      sessionId: event.sessionId,
      kind: "error",
      body: "Could not load the Linear issue.",
    });
  }
}
