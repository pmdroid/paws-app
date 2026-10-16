import type { TrackerAdapter, TrackerRequestOptions } from "./adapter";
import { UserFacingError } from "../core";
import type { AcceptedLinearEvent } from "./events";

/** Posted before intake so a slow Linear read still meets the 10 second first-activity rule. */
export const FIRST_ACTIVITY_BODY = "Picked up this issue.";

export async function acknowledgeNewSession(
  tracker: TrackerAdapter,
  event: AcceptedLinearEvent,
  followUp?: (event: AcceptedLinearEvent) => Promise<void | boolean>,
  initialRequest?: TrackerRequestOptions,
  options: { acknowledged?: Set<string> } = {},
): Promise<void | boolean> {
  if (event.signal === "stop") {
    return followUp?.(event);
  }
  if (event.action !== "created" && event.action !== "prompted") return;
  const first =
    event.action === "created" &&
    event.sessionId !== null &&
    !options.acknowledged?.has(event.sessionId);
  if (first && event.sessionId !== null) {
    initialRequest?.signal?.throwIfAborted();
    await tracker.postProgress(
      {
        sessionId: event.sessionId,
        kind: "thought",
        body: FIRST_ACTIVITY_BODY,
      },
      initialRequest,
    );
    options.acknowledged?.add(event.sessionId);
    initialRequest?.signal?.throwIfAborted();
  }
  if (followUp === undefined) return;
  try {
    const accepted = await followUp(event);
    if (accepted === false && first && event.sessionId !== null)
      await tracker.postProgress({
        sessionId: event.sessionId,
        kind: "error",
        body: "Paws did not start this work. Only an active member of the Paws workspace can delegate issues to Paws.",
      });
    return accepted;
  } catch (error) {
    const message = error instanceof Error ? error.message : "follow-up failed";
    console.error(`linear session follow-up failed: ${message}`);
    if (event.sessionId !== null) {
      try {
        await tracker.postProgress({
          sessionId: event.sessionId,
          kind: "error",
          body:
            error instanceof UserFacingError
              ? `Paws could not start work on this issue: ${error.message}`
              : "Paws could not start work on this issue. Please retry.",
        });
      } catch {
        console.error("linear follow-up error activity failed");
      }
    }
    throw error;
  }
}
