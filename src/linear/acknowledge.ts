import type { TrackerAdapter, TrackerRequestOptions } from "./adapter";
import type { AcceptedLinearEvent } from "./events";

/** Posted before intake so a slow Linear read still meets the 10 second first-activity rule. */
export const FIRST_ACTIVITY_BODY = "Picked up this issue.";

export async function acknowledgeNewSession(
  tracker: TrackerAdapter,
  event: AcceptedLinearEvent,
  followUp?: (event: AcceptedLinearEvent) => Promise<void | boolean>,
  initialRequest?: TrackerRequestOptions,
): Promise<void | boolean> {
  if (event.signal === "stop") {
    return followUp?.(event);
  }
  if (event.action !== "created" && event.action !== "prompted") return;
  if (event.action === "created" && event.sessionId !== null) {
    initialRequest?.signal?.throwIfAborted();
    await tracker.postProgress(
      {
        sessionId: event.sessionId,
        kind: "thought",
        body: FIRST_ACTIVITY_BODY,
      },
      initialRequest,
    );
    initialRequest?.signal?.throwIfAborted();
  }
  if (followUp === undefined) return;
  try {
    return await followUp(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : "follow-up failed";
    console.error(`linear session follow-up failed: ${message}`);
    if (event.sessionId !== null) {
      try {
        await tracker.postProgress({
          sessionId: event.sessionId,
          kind: "error",
          body: "Paws could not start work on this issue. Please retry.",
        });
      } catch {
        console.error("linear follow-up error activity failed");
      }
    }
    throw error;
  }
}
