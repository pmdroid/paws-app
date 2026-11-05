import { TIME_STAGES, type StatusItem, type StatusStageTimes, type TimeStage } from "../contract";
import { esc, itemLabel, statePill, utcClock } from "./format";
import { hoursLabel, itemAge } from "./state-times";

const HOUR = 3_600_000;

export const PREPARING_LABEL = "Preparing: checking out and installing runtimes";

export function doingLabel(item: Pick<StatusItem, "doing" | "state">): string | null {
  const doing = item.doing;
  if (!doing) return null;
  const on = doing.runners.join(", ");
  switch (doing.kind) {
    case "running":
      if (doing.phase === "preparing") return on ? `${PREPARING_LABEL} on ${on}` : PREPARING_LABEL;
      return on ? `Running on ${on}` : item.state === "verifying" ? "Running Closeout" : "Running";
    case "slot":
      return on ? `Waiting for a slot on ${on}` : "Waiting for a slot";
    case "paused":
      return `Paused: ${doing.agent ?? "agent"} usage limit until ${utcClock(doing.until ?? "")} UTC`;
    case "person":
      return doing.question ? `Waiting for an answer: ${doing.question}` : "Waiting for a person";
    case "idle":
      return null;
  }
}

const PILLS = {
  running: ["running", "Running"],
  slot: ["queued", "Waiting for a slot"],
  paused: ["running usage-limit", "Usage limit"],
  person: ["awaiting_input", "Waiting for a person"],
} as const;

export function itemPill(item: StatusItem): string {
  const doing = item.doing;
  if (doing?.stalled) return statePill("stopped", "Stalled");
  if (!doing || doing.kind === "idle") return statePill(item.state, itemLabel(item.state));
  const [tone, label] = PILLS[doing.kind];
  return statePill(tone, label);
}

export function activeLabel(ms: number): string {
  return ms < HOUR ? `${Math.round(ms / 60_000)} min active` : `${(ms / HOUR).toFixed(1)} h active`;
}

export function doingTimeLine(
  item: Pick<StatusItem, "doing" | "activeMs">,
  now: number,
): string | null {
  if (!item.doing || item.activeMs === undefined) return null;
  return [activeLabel(item.activeMs), ...waitingPart(item, now)].join(" · ");
}

function waitingPart(item: Pick<StatusItem, "doing">, now: number): string[] {
  const doing = item.doing;
  const since = doing?.since ? Date.parse(doing.since) : NaN;
  return doing && doing.kind !== "running" && !Number.isNaN(since)
    ? [`waiting ${hoursLabel(Math.max(0, now - since))}`]
    : [];
}

const STAGE_NAMES: Record<TimeStage, string> = {
  implementation: "Implementation",
  fixes: "Fixes",
  closeout: "Closeout",
};

export function stageDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes} m`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${String(minutes).padStart(2, "0")} m`;
}

export function stageTimeLine(times: StatusStageTimes): string {
  return TIME_STAGES.flatMap((stage) => {
    const { ms, limitMs } = times[stage];
    if (limitMs > 0)
      return [`${STAGE_NAMES[stage]} ${stageDuration(ms)} of ${stageDuration(limitMs)}`];
    return ms > 0 ? [`${STAGE_NAMES[stage]} ${stageDuration(ms)} (not counted)`] : [];
  }).join(" · ");
}

export function issueTimeLine(
  item: Pick<StatusItem, "doing" | "activeMs" | "stageTimes">,
  now: number,
): string | null {
  const stages = item.stageTimes ? stageTimeLine(item.stageTimes) : "";
  if (!stages) return doingTimeLine(item, now);
  return [stages, ...waitingPart(item, now)].join(" · ");
}

export function itemTime(item: StatusItem, now: number): string {
  const line = doingTimeLine(item, now);
  if (line === null) return itemAge(item);
  const label = doingLabel(item) ?? (item.doing?.stalled ? "No live work" : null);
  const detail = label === null ? line : `${label} · ${line}`;
  return `<span class="muted item-age" data-item-time>${esc(detail)}</span>`;
}

export function itemNowLine(item: StatusItem, now: number): string {
  const time = doingTimeLine(item, now);
  if (time === null) return "";
  const label = item.doing?.stalled
    ? `Stalled: ${doingLabel(item) ?? "no live work and no change for 30 min"}`
    : doingLabel(item);
  return `<p class="muted" data-item-now>${esc([label, time].filter(Boolean).join(" · "))}</p>`;
}

export function isRunningNow(item: StatusItem): boolean {
  return item.doing === undefined || (item.doing.kind === "running" && !item.doing.stalled);
}

export function isWaitingNow(item: StatusItem): boolean {
  return (
    item.doing?.stalled === true || item.doing?.kind === "slot" || item.doing?.kind === "paused"
  );
}
