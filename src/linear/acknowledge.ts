import { journalCaught } from "../journal";
import type { TrackerAdapter, TrackerRequestOptions } from "./adapter";
import { isTransient, RunnerSlotsBusyError, UserFacingError } from "../core";
import { LinearRateLimitError } from "./budget";
import { LinearEntityNotFoundError } from "./graphql";
import type { AcceptedLinearEvent } from "./events";

/** Posted before intake so a slow Linear read still meets the 10 second first-activity rule. */
export const FIRST_ACTIVITY_BODY = "Picked up this issue.";

export class LinearIntakePendingError extends Error {}

export class LinearIntakeRefusedError extends Error {
  /** True when Paws already told the session what happens next, so no error activity follows. */
  readonly quiet: boolean;
  constructor(message: string, options: { quiet?: boolean } = {}) {
    super(message);
    this.quiet = options.quiet === true;
  }
}

export type IntakeDecision =
  | { outcome: "accepted" }
  | {
      outcome: "refused" | "retry";
      reason: string;
      /** The session already has its next step (a sign-in action), so post no error. */
      quiet?: boolean;
    };

export function linearReadRetry(error: unknown): { outcome: "retry"; reason: string } {
  if (error instanceof LinearRateLimitError || error instanceof LinearEntityNotFoundError)
    throw error;
  const message = error instanceof Error ? error.message : "read failed";
  return {
    outcome: "retry",
    reason: `Paws could not read this issue from Linear (${message}). It will try again automatically.`,
  };
}

export class LinearIssueClosedError extends UserFacingError {
  constructor(identifier: string) {
    super(`${identifier} is closed, so Paws won't start work on it. Reopen the issue to continue.`);
  }
}

export async function acknowledgeNewSession(
  tracker: TrackerAdapter,
  event: AcceptedLinearEvent,
  followUp?: (event: AcceptedLinearEvent) => Promise<void | boolean>,
  initialRequest?: TrackerRequestOptions,
  options: {
    acknowledged?: Set<string>;
    signal?: AbortSignal;
    /** The first activity for this event was posted when it arrived, before the queue ran it. */
    acknowledgedOnArrival?: boolean;
    /** False on a retry, so a failure is reported in Linear once, not on every attempt. */
    reportFailure?: boolean;
    /**
     * The session already has an item in flight. A failed follow-up then posts no error, which
     * would end that session in Linear and drop its open question; the queue retries it instead.
     */
    sessionBusy?: (sessionId: string) => boolean;
  } = {},
): Promise<void | boolean> {
  options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
    return accepted;
  } catch (error) {
    if (options.signal?.aborted) throw error;

    if (error instanceof LinearIntakeRefusedError) {
      if (
        !error.quiet &&
        event.action === "created" &&
        event.sessionId !== null &&
        (first || options.acknowledgedOnArrival === true || options.reportFailure === false)
      )
        await tracker.postProgress(
          {
            sessionId: event.sessionId,
            kind: "error",
            body: `Paws did not start this work. ${error.message}`,
          },
          { signal: options.signal },
        );

      journalCaught(error, "acknowledge.acknowledgeNewSession.followUp", null);
      return false;
    }
    if (error instanceof LinearIssueClosedError && event.sessionId !== null) {
      await tracker.postProgress(
        { sessionId: event.sessionId, kind: "error", body: error.message },
        { signal: options.signal },
      );

      journalCaught(error, "acknowledge.acknowledgeNewSession.followUp", null);
      return false;
    }
    const waiting =
      error instanceof LinearIntakePendingError || error instanceof RunnerSlotsBusyError;

    if (
      event.sessionId !== null &&
      options.reportFailure !== false &&
      !isTransient(error) &&
      !(error instanceof UserFacingError && error.reported) &&
      (waiting || options.sessionBusy?.(event.sessionId) !== true)
    ) {
      try {
        await tracker.postProgress(
          {
            sessionId: event.sessionId,
            kind: waiting ? "thought" : "error",
            body: waiting
              ? error.message
              : error instanceof UserFacingError
                ? `Paws could not start work on this issue: ${error.message}`
                : "Paws could not start work on this issue. Please retry.",
          },
          { signal: options.signal },
        );
      } catch (caughtError1) {
        journalCaught(caughtError1, "acknowledge.acknowledgeNewSession.postProgress", null);
      }
    }
    throw error;
  }
}
