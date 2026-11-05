/**
 * Awake-time cap (3 hours). Sleep does not count.
 */
export const DEFAULT_MAX_AWAKE_MS = 3 * 60 * 60 * 1000;

export const TIME_STAGES = ["implementation", "fixes", "closeout"] as const;
export type TimeStage = (typeof TIME_STAGES)[number];
export type StageLimits = Record<TimeStage, number>;

const FIX_RESTARTS: readonly string[] = ["ci", "review", "findings", "conflict"];

export function agentStage(reason: string | null): "implementation" | "fixes" {
  return reason !== null && FIX_RESTARTS.includes(reason) ? "fixes" : "implementation";
}

export type StageClock = {
  implementMs: number;
  fixMs: number;
  closeoutMs: number;
  maxAwakeMs: number;
  maxFixMs: number;
  maxCloseoutMs: number;
};

export function stageLimits(clock: StageClock): StageLimits {
  return {
    implementation: clock.maxAwakeMs,
    fixes: clock.maxFixMs,
    closeout: clock.maxCloseoutMs,
  };
}

function stageTotal(clock: StageClock, stage: TimeStage): number {
  if (stage === "implementation") return clock.implementMs;
  return stage === "fixes" ? clock.fixMs : clock.closeoutMs;
}

export function stageReached(clock: StageClock, stage: TimeStage): boolean {
  const limit = stageLimits(clock)[stage];
  return limit > 0 && stageTotal(clock, stage) >= limit;
}

export function awakeCapReached(clock: StageClock): boolean {
  return TIME_STAGES.some((stage) => stageReached(clock, stage));
}

const STAGE_SUBJECT: Record<TimeStage, string> = {
  implementation: "Implementation",
  fixes: "The fixes stage",
  closeout: "Closeout",
};

export function stageLimitReached(stage: TimeStage, limitMs: number): string {
  return `${STAGE_SUBJECT[stage]} reached its ${minutes(Math.max(60_000, limitMs))} limit`;
}

/** How a task's time was spent. Waiting and re-checks of accepted work do not count. */
export type AwakeBreakdown = {
  agentMs: number;
  implementMs: number;
  fixMs: number;
  closeoutMs: number;
  waitingMs: number;
  recheckMs: number;
};

/** The time-limit answer that sends the accepted work to the merge queue without another turn. */
export const TIME_LIMIT_MERGE = "Merge the accepted work";

/** Once Closeout accepted the work, the cap asks this instead of failing a resumed agent. */
export const TIME_LIMIT_CONTINUE = "Continue";

export const TIME_LIMIT_OPTIONS = [TIME_LIMIT_MERGE, TIME_LIMIT_CONTINUE, "Stop"] as const;

export const UNACCEPTED_TIME_LIMIT_OPTIONS = [TIME_LIMIT_CONTINUE, "Stop"] as const;

export const TIME_LIMIT_VERIFYING_REASON = "time_limit_verifying";

/** How much more awake time resuming accepted work paused at the time limit gives the agent. */
export const TIME_LIMIT_EXTENSION_MS = 60 * 60 * 1000;

export function capActivityText(
  stage: TimeStage,
  limits: StageLimits,
  breakdown?: AwakeBreakdown,
): string {
  const cap = `${stageLimitReached(stage, limits[stage])}.`;
  const tracked =
    breakdown &&
    breakdown.agentMs + breakdown.closeoutMs + breakdown.waitingMs + breakdown.recheckMs > 0;
  return tracked ? `${cap} ${formatAwakeBreakdown(breakdown, limits)}` : cap;
}

export function formatAwakeBreakdown(breakdown: AwakeBreakdown, limits: StageLimits): string {
  const stages: [TimeStage, string, number][] = [
    ["implementation", "implementation", breakdown.implementMs],
    ["fixes", "fixes", breakdown.fixMs],
    ["closeout", "Closeout", breakdown.closeoutMs],
  ];
  const counted = stages
    .filter(([stage]) => limits[stage] > 0)
    .map(([, name, ms]) => `${name} ${minutes(ms)}`);
  const skipped = [
    ...stages
      .filter(([stage, , ms]) => limits[stage] <= 0 && ms > 0)
      .map(([, name, ms]) => `${name} ${minutes(ms)}`),
    breakdown.waitingMs > 0 ? `waiting ${minutes(breakdown.waitingMs)}` : null,
    breakdown.recheckMs > 0 ? `re-checking accepted work ${minutes(breakdown.recheckMs)}` : null,
  ].filter((part) => part !== null);
  const parts = [
    counted.length === 0 ? null : `Counted: ${counted.join(", ")}.`,
    skipped.length === 0 ? null : `Not counted: ${skipped.join(", ")}.`,
  ].filter((part) => part !== null);
  return parts.join(" ");
}

export function timeLimitQuestion(
  stage: TimeStage,
  limits: StageLimits,
  breakdown: AwakeBreakdown,
  /** Whether the time limit held back a handoff the agent had not started, such as a review. */
  heldHandoff = false,
): string {
  return [
    `${stageLimitReached(stage, limits[stage])}; merge, continue or stop?`,
    "Closeout already accepted this task's work, so Paws did not fail it.",
    formatAwakeBreakdown(breakdown, limits),
    heldHandoff
      ? "The agent had not started on the latest feedback yet: Continue hands it over, Merge and Stop leave it unaddressed."
      : null,
    `${TIME_LIMIT_MERGE} sends the accepted head to the merge queue without another agent turn. Continue starts the agent on a fresh ${STAGE_NOUN[stage]} limit of the configured length. Stop ends the task without merging: the accepted work stays on its branch and its pull request is not closed.`,
  ]
    .filter((part) => part !== null)
    .join(" ");
}

export function unacceptedTimeLimitQuestion(
  stage: TimeStage,
  limits: StageLimits,
  breakdown: AwakeBreakdown,
  verifying: boolean,
  heldHandoff = false,
): string {
  return [
    `${stageLimitReached(stage, limits[stage])}; continue or stop?`,
    verifying
      ? "Paws stopped Closeout while it was checking the latest head."
      : "Paws stopped the agent's run.",
    formatAwakeBreakdown(breakdown, limits),
    heldHandoff
      ? "The agent had not started on the latest feedback yet: Continue hands it over, Stop leaves it unaddressed."
      : null,
    `Continue starts ${verifying ? "Closeout on the same head again" : "the agent"} on a fresh ${STAGE_NOUN[stage]} limit of the configured length. Stop ends the task: the work stays on its branch.`,
  ]
    .filter((part) => part !== null)
    .join(" ");
}

const STAGE_NOUN: Record<TimeStage, string> = {
  implementation: "implementation",
  fixes: "fixes",
  closeout: "Closeout",
};

function minutes(ms: number): string {
  if (ms > 0 && ms < 60_000) return "under 1 min";
  const total = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
