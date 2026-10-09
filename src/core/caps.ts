/**
 * Awake-time cap from the Quick MVP plan (45 minutes). Sleep does not count.
 * The turn cap is configurable; 80 is the default because the plan does not
 * fix a number.
 */
export const DEFAULT_MAX_TURNS = 80;
export const DEFAULT_MAX_AWAKE_MS = 45 * 60 * 1000;

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

export function capActivityText(reason: CapReason, maxTurns: number, maxAwakeMs: number): string {
  if (reason === "turns") return `Run hit the turn cap (${maxTurns}).`;
  const minutes = Math.max(1, Math.round(maxAwakeMs / 60_000));
  return `Run hit the awake time cap (${minutes} min).`;
}
