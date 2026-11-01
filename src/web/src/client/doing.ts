import type { StatusItem } from "../contract";
import { esc, itemLabel, statePill, utcClock } from "./format";
import { hoursLabel, itemAge } from "./state-times";

const HOUR = 3_600_000;

export function doingLabel(item: StatusItem): string | null {
  const doing = item.doing;
  if (!doing) return null;
  const on = doing.runners.join(", ");
  switch (doing.kind) {
    case "running":
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

export function itemPill(item: StatusItem): string {
  const doing = item.doing;
  if (doing?.stalled) return statePill("stopped", "Stalled");
  const label = doingLabel(item);
  if (!doing || label === null) return statePill(item.state, itemLabel(item.state));
  const tone = {
    running: "running",
    slot: "queued",
    paused: "running usage-limit",
    person: "awaiting_input",
    idle: item.state,
  }[doing.kind];
  return statePill(tone, label);
}

export function activeLabel(ms: number): string {
  return ms < HOUR ? `${Math.round(ms / 60_000)} min active` : `${(ms / HOUR).toFixed(1)} h active`;
}

export function doingTimeLine(item: StatusItem, now: number): string | null {
  const doing = item.doing;
  if (!doing || item.activeMs === undefined) return null;
  const since = doing.since === null ? NaN : Date.parse(doing.since);
  const waiting =
    doing.kind !== "running" && !Number.isNaN(since)
      ? [`waiting ${hoursLabel(Math.max(0, now - since))}`]
      : [];
  return [activeLabel(item.activeMs), ...waiting].join(" · ");
}

export function itemTime(item: StatusItem, now: number): string {
  const line = doingTimeLine(item, now);
  if (line === null) return itemAge(item);
  const detail = item.doing?.stalled ? `${doingLabel(item) ?? "No live work"} · ${line}` : line;
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
