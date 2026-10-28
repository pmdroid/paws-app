/**
 * Awake-time cap from the Quick MVP plan (45 minutes). Sleep does not count.
 * The turn cap is configurable; 80 is the default because the plan does not
 * fix a number.
 */
export const DEFAULT_MAX_TURNS = 80;
export const DEFAULT_MAX_AWAKE_MS = 3 * 60 * 60 * 1000;

export type CapReason = "turns" | "time";

export function capReason(input: {
  turnCount: number;
  maxTurns: number;
  awakeMs: number;
  maxAwakeMs: number;
}): CapReason | null {
  if (input.turnCount >= input.maxTurns) return "turns";
  if (input.awakeMs >= input.maxAwakeMs) return "time";
  return null;
}

/** How a task's time was spent. Waiting and re-checks of accepted work do not count. */
export type AwakeBreakdown = {
  agentMs: number;
  closeoutMs: number;
  waitingMs: number;
  recheckMs: number;
};

/** The time-limit answer that sends the accepted work to the merge queue without another turn. */
export const TIME_LIMIT_MERGE = "Merge the accepted work";

/** Once Closeout accepted the work, the cap asks this instead of failing a resumed agent. */
export const TIME_LIMIT_OPTIONS = [TIME_LIMIT_MERGE, "Continue", "Stop"] as const;

/** How much more awake time a Continue answer gives the agent. */
export const TIME_LIMIT_EXTENSION_MS = 60 * 60 * 1000;

export function capActivityText(
  reason: CapReason,
  maxTurns: number,
  maxAwakeMs: number,
  breakdown?: AwakeBreakdown,
): string {
  if (reason === "turns") return `Run hit the turn cap (${maxTurns}).`;
  const cap = `Run hit the awake time cap (${Math.max(1, Math.round(maxAwakeMs / 60_000))} min).`;
  const tracked =
    breakdown &&
    breakdown.agentMs + breakdown.closeoutMs + breakdown.waitingMs + breakdown.recheckMs > 0;
  return tracked ? `${cap} ${formatAwakeBreakdown(breakdown)}` : cap;
}

/** "Counted: agent turns 120 min, Closeout 60 min. Not counted: waiting for answers 90 min." */
export function formatAwakeBreakdown(breakdown: AwakeBreakdown): string {
  const counted = `Counted: agent turns ${minutes(breakdown.agentMs)}, Closeout ${minutes(breakdown.closeoutMs)}.`;
  const skipped = [
    breakdown.waitingMs > 0 ? `waiting for answers ${minutes(breakdown.waitingMs)}` : null,
    breakdown.recheckMs > 0 ? `re-checking accepted work ${minutes(breakdown.recheckMs)}` : null,
  ].filter((part) => part !== null);
  return skipped.length === 0 ? counted : `${counted} Not counted: ${skipped.join(", ")}.`;
}

export function timeLimitQuestion(maxAwakeMs: number, breakdown: AwakeBreakdown): string {
  return [
    `Time limit reached (${Math.max(1, Math.round(maxAwakeMs / 60_000))} min awake); merge, continue or stop?`,
    "Closeout already accepted this task's work, so Paws did not fail it.",
    formatAwakeBreakdown(breakdown),
    `${TIME_LIMIT_MERGE} sends the accepted head to the merge queue without another agent turn. Continue gives the agent another ${minutes(TIME_LIMIT_EXTENSION_MS)}. Stop ends the task without merging: the accepted work stays on its branch and its pull request is not closed.`,
  ].join(" ");
}

function minutes(ms: number): string {
  if (ms > 0 && ms < 60_000) return "under 1 min";
  const total = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
