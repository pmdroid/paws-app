import type { StatusItem, StatusItemEvent, StatusRun, StatusVisualReview } from "../contract";

type JourneyItem = Pick<StatusItem, "state" | "timeline" | "doing" | "mergeQueue"> & {
  visualReviews?: readonly Pick<StatusVisualReview, "round" | "state">[];
};
type JourneyRun = Pick<StatusRun, "usagePause">;
import { doingLabel } from "./doing";
import { esc, utcClock } from "./format";

export type JourneyStepId =
  | "queued"
  | "implementing"
  | "checking"
  | "review"
  | "fixing"
  | "merging"
  | "done";
type Tone = "now" | "needs" | "failed" | "done";

export interface Journey {
  step: JourneyStepId;
  pill: [string, string];
  review: { round: number; state: string } | null;
  tone: Tone;
  headline: string;
  reason: string;
  fixLabel: string | null;
  fixRounds: number;
}

const FIXES: Record<string, { label: string; reason: string }> = {
  conflict: {
    label: "Fixing merge conflicts",
    reason:
      "Main moved under this pull request. The agent is rebasing onto main and resolving the conflicts.",
  },
  findings: {
    label: "Fixing review comments",
    reason: "Closeout found problems. The agent is fixing the findings.",
  },
  review: {
    label: "Fixing review comments",
    reason: "A reviewer asked for changes on the pull request. The agent is addressing them.",
  },
  ci: {
    label: "Fixing CI",
    reason: "CI failed on the pull request. The agent is fixing it.",
  },
};

const CLOSEOUT_STOPS: Record<string, { headline: string; reason: string; tone: Tone }> = {
  blocked: {
    headline: "Closeout blocked",
    reason: "Closeout stopped and needs a decision. It is below.",
    tone: "needs",
  },
  exhausted: {
    headline: "Closeout exhausted",
    reason: "Closeout used every attempt without passing. A decision is waiting below.",
    tone: "needs",
  },
  rejected: {
    headline: "Closeout failed",
    reason: "Closeout rejected the work.",
    tone: "failed",
  },
};

const FROM_STEP: Record<string, JourneyStepId> = {
  queued: "queued",
  running: "implementing",
  recovering: "implementing",
  verifying: "checking",
  merge_queue: "merging",
};

function lastIndex(events: readonly StatusItemEvent[], match: (event: StatusItemEvent) => boolean) {
  for (let index = events.length - 1; index >= 0; index--) if (match(events[index]!)) return index;
  return -1;
}

function currentFix(item: Pick<StatusItem, "timeline">): string | null {
  const events = item.timeline ?? [];
  const restart = lastIndex(events, (event) => event.kind === "restart");
  if (restart < 0) return null;
  const turnEnded = lastIndex(events, (event) => event.event === "turn_ended");
  const reason = events[restart]!.reason ?? "";
  return restart > turnEnded && FIXES[reason] ? reason : null;
}

function fixRounds(item: Pick<StatusItem, "timeline">): number {
  return (item.timeline ?? []).filter(
    (event) => event.kind === "restart" && FIXES[event.reason ?? ""] !== undefined,
  ).length;
}

function lastFrom(item: Pick<StatusItem, "timeline">): JourneyStepId {
  const last = item.timeline?.findLast((event) => event.kind !== "ci_rerun");
  return (last && FROM_STEP[last.from]) ?? "implementing";
}

function journeyBase(
  item: JourneyItem,
  run: JourneyRun | undefined,
  verdict: { attempt?: number; maxAttempts?: number; decision?: string } | undefined,
): Omit<Journey, "pill" | "review"> {
  const fix = currentFix(item);
  const rounds = fixRounds(item);
  const last = [...(item.timeline ?? [])]
    .reverse()
    .find((event) => event.kind === "restart" && FIXES[event.reason ?? ""]);
  const fixLabel = fix ? FIXES[fix]!.label : last ? FIXES[last.reason!]!.label : null;
  const base = { fixLabel, fixRounds: rounds };
  const doing = doingLabel(item);
  const stop = CLOSEOUT_STOPS[verdict?.decision ?? ""];
  if (stop && ["verifying", "awaiting_input", "needs_human"].includes(item.state))
    return {
      ...base,
      step: "checking",
      tone: stop.tone,
      headline: stop.headline,
      reason: stop.reason,
    };
  const withDoing = (reason: string) => (doing ? `${reason} ${doing}.` : reason);
  switch (item.state) {
    case "merged":
      return {
        ...base,
        step: "done",
        tone: "done",
        headline: "Merged",
        reason: "The pull request is merged. Nothing left to do.",
      };
    case "completed":
      return {
        ...base,
        step: "done",
        tone: "done",
        headline: "Done",
        reason: "The requested response is complete.",
      };
    case "stopped":
      return {
        ...base,
        step: lastFrom(item),
        tone: "failed",
        headline: "Stopped",
        reason: "Execution stopped with nothing to ask. Restart it from its Linear session.",
      };
    case "awaiting_input":
    case "needs_human":
      return {
        ...base,
        step: ["exhausted", "blocked", "rejected", "running"].includes(verdict?.decision ?? "")
          ? "checking"
          : lastFrom(item),
        tone: "needs",
        headline: "Needs you",
        reason: doing ?? "A decision is waiting below.",
      };
    case "merge_queue": {
      if (verdict?.decision === "running")
        return {
          ...base,
          step: "checking",
          tone: "now",
          headline: "Checking",
          reason: "Closeout is verifying the work again before the merge.",
        };
      const position = item.mergeQueue?.position;
      return {
        ...base,
        step: "merging",
        tone: "now",
        headline: "Waiting to merge",
        reason: position
          ? `Closeout accepted the work. It is #${position} in the merge queue.`
          : "Closeout accepted the work. The merge lane takes it next.",
      };
    }
    case "verifying":
      return {
        ...base,
        step: "checking",
        tone: "now",
        headline: "Checking",
        reason: withDoing(
          verdict?.attempt && verdict.maxAttempts
            ? `Closeout is verifying the work, attempt ${verdict.attempt} of ${verdict.maxAttempts}.`
            : "Closeout is running the checks and reviews.",
        ),
      };
    case "queued":
    case "planning":
      if (fix)
        return {
          ...base,
          step: "fixing",
          tone: "now",
          headline: FIXES[fix]!.label,
          reason: withDoing(`${FIXES[fix]!.reason} It starts as soon as a runner is free.`),
        };
      return {
        ...base,
        step: "queued",
        tone: "now",
        headline: "Queued",
        reason: doing ?? "Waiting for a runner slot or a blocking issue.",
      };
    default:
      if (run?.usagePause)
        return {
          ...base,
          step: fix ? "fixing" : "implementing",
          tone: "now",
          headline: "Paused · usage limit",
          reason: `${run.usagePause.agent} usage limit reached; resumes at ${run.usagePause.resumeAt.slice(0, 10)} ${utcClock(run.usagePause.resumeAt)} UTC.`,
        };
      if (fix)
        return {
          ...base,
          step: "fixing",
          tone: "now",
          headline: FIXES[fix]!.label,
          reason: withDoing(FIXES[fix]!.reason),
        };
      return {
        ...base,
        step: "implementing",
        tone: "now",
        headline: "Implementing",
        reason:
          item.doing?.phase === "preparing"
            ? `${doing}.`
            : withDoing("The agent is working on the issue."),
      };
  }
}

export function journey(
  item: JourneyItem,
  run: JourneyRun | undefined,
  verdict: { attempt?: number; maxAttempts?: number; decision?: string } | undefined,
): Journey {
  const value = journeyBase(item, run, verdict);
  const last = item.visualReviews?.at(-1);
  const waiting = last?.state === "waiting" && item.state === "awaiting_input";
  const review = last ? { round: last.round, state: last.state } : null;
  if (waiting)
    return {
      ...value,
      step: "review",
      tone: "needs",
      headline: `Waiting for visual review · round ${last.round}`,
      reason: "Screenshots of the changed screens are waiting for a person to accept them.",
      pill: ["awaiting_input", "Waiting for visual review"],
      review,
    };
  return { ...value, pill: pillFor(value, run), review };
}

function pillFor(
  value: Omit<Journey, "pill" | "review">,
  run: JourneyRun | undefined,
): [string, string] {
  if (run?.usagePause) return ["running usage-limit", "Paused · usage limit"];
  if (value.tone === "needs") return ["awaiting_input", value.headline];
  if (value.tone === "failed") return ["stopped", value.headline];
  if (value.tone === "done") return ["merged", value.headline];
  const tones: Record<JourneyStepId, string> = {
    queued: "queued",
    implementing: "running",
    checking: "verifying",
    review: "awaiting_input",
    fixing: "running",
    merging: "merge_queue",
    done: "merged",
  };
  return [tones[value.step], value.headline];
}

export const JOURNEY_ORDER: readonly JourneyStepId[] = [
  "queued",
  "implementing",
  "review",
  "checking",
  "fixing",
  "merging",
  "done",
];

export function journeyStepper(
  value: Journey,
  notes: { implementing?: string; queue?: number } = {},
): string {
  const showFix = value.step === "fixing" || value.fixRounds > 0;
  const names: Record<JourneyStepId, string> = {
    queued: "Queued",
    implementing: notes.implementing ? `Implementing · ${notes.implementing}` : "Implementing",
    checking: "Checking",
    review:
      value.step === "review"
        ? `Visual review · round ${value.review?.round ?? 1}`
        : "Visual review",
    fixing:
      value.step === "fixing"
        ? (value.fixLabel ?? "Fixing")
        : `Fixed · ${value.fixRounds} round${value.fixRounds === 1 ? "" : "s"}`,
    merging: notes.queue ? `Waiting to merge · #${notes.queue} in queue` : "Waiting to merge",
    done: "Done",
  };
  const steps = JOURNEY_ORDER.filter(
    (id) => (id !== "fixing" || showFix) && (id !== "review" || value.review !== null),
  );
  const current = steps.indexOf(value.step);
  const marks = steps
    .map((id, index) => {
      const here = index === current;
      const cls = here
        ? value.tone === "done"
          ? "done"
          : value.tone === "failed"
            ? "failed"
            : value.tone === "needs"
              ? "needs"
              : "now"
        : index < current
          ? "done"
          : "wait";
      const mark = cls === "done" ? "✓ " : cls === "failed" ? "✕ " : "";
      return `<li class="run-step ${cls}"${here ? ' aria-current="step"' : ""}>${mark}${esc(names[id])}</li>`;
    })
    .join("");
  return `<section class="journey" aria-labelledby="journey-now"><ol class="run-stepper journey-stepper${value.review ? " with-review" : ""}" aria-label="Issue progress">${marks}</ol>
    <div class="journey-now journey-${value.tone}"><h2 id="journey-now">${esc(value.headline)}</h2><p>${esc(value.reason)}</p></div></section>`;
}
